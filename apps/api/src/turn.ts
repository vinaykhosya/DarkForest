import type {
  AIProvider,
  CharacterId,
  MemoryId,
  EmbeddingProvider,
  ModelDescriptor,
  WorldEvent,
  WorldId,
} from "@darkforest/contracts";
import {
  PostgresMemoryStore,
  appendEvents,
  appendTurn,
  asUser,
  claimTurnSlot,
  inAudience,
  releaseTurnSlot,
  currentWorldDay,
  projectFor,
  recentTurns,
  type DbPool,
} from "@darkforest/db";
import { extractEvents, retrieve } from "@darkforest/memory";
import { memoryKindForEvent, openThreads, renderEventAsMemory } from "@darkforest/core";
import { ApiError } from "./envelope.js";

/**
 * ONE TURN — the whole product, in the order it happens.
 *
 *   1. the player's turn is stored
 *   2. what this character may recall is retrieved (isolated in SQL)
 *   3. a reply is generated from that, and only that
 *   4. the reply is stored
 *   5. events are extracted and stored with their audience
 *
 * TRANSACTION SHAPE, which is the decision worth reading.
 *
 * Steps 1 and 2-5 are SEPARATE transactions, with the model call between them.
 * The obvious alternative — one transaction around everything — holds a
 * connection open for the several seconds a generation takes, and a handful of
 * concurrent users then exhaust the pool while doing nothing but waiting.
 *
 * The cost is that a crash mid-generation leaves a player turn with no reply.
 * That is recoverable and honest: the transcript is the ground truth, it says
 * the player spoke and nobody answered, and a retry appends a reply. The
 * opposite failure — a reply stored with no turn behind it — would be a
 * transcript that lies, and nothing downstream could detect it.
 */

export interface TurnDeps {
  pool: DbPool;
  router: AIProvider;
  embedder: EmbeddingProvider;
  /**
   * A descriptor to satisfy the `AIProvider` signature. The SchedulerRouter
   * IGNORES it and chooses by capability then capacity (ADR-021, ADR-022),
   * which is the behaviour we want: `taskClass: "extract"` excludes every model
   * not verified for structured output, rather than merely scoring it lower.
   * That gate exists because a capacity-only choice once sent 34 of 62
   * extractions to a model that writes prose well and fails schemas.
   */
  anyModel: ModelDescriptor;
}

export interface TurnRequest {
  userId: string;
  worldId: string;
  characterId: string;
  message: string;
}

export interface TurnResult {
  reply: string;
  /** What the character actually drew on. Shown in the UI; it is the product. */
  recalled: Array<{ content: string; worldDay: number | null }>;
  eventsExtracted: number;
}

const PLAYER = "the user";
const RECALL_LIMIT = 6;
/** ADR-012/ADR-020: the compact profile is mandatory, not an optimisation. */
const RECALL_TOKEN_BUDGET = 700;

/**
 * A rendered event, cut to what `MemoryContentSchema` accepts (8..200 chars).
 *
 * Truncation happens at a WORD boundary. A hard `slice(0, 200)` cuts mid-word,
 * and this string is not a log line — it goes into the prompt under "WHAT YOU
 * REMEMBER", where a severed word is a small piece of nonsense the character
 * then has to speak around.
 *
 * Returns null when the result is too short to be a fact, so the caller can
 * report it rather than skip silently.
 */
function fitToMemory(rendered: string): string | null {
  const text = rendered.trim();
  if (text.length < 8) return null;
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to the boundary if it does not cost most of the sentence.
  return (lastSpace > 160 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Whether an event names this character in any role. Exact match, never fuzzy. */
function namesThisCharacter(e: WorldEvent, name: string): boolean {
  const target = name.trim().toLowerCase();
  const named = [e.actor, e.target, ...e.participants, ...e.knownBy];
  return named.some((n) => typeof n === "string" && n.trim().toLowerCase() === target);
}

/**
 * Step 1, as its own function: claim the slot, store the player's turn, and
 * gather everything needed to answer it — all in ONE transaction.
 *
 * Separated from the rest so the slot's lifetime is visible at a glance in
 * `runTurn`: claimed here, released there, with nothing in between that could
 * return early without passing the release.
 */
async function prepareTurn(
  deps: TurnDeps,
  req: TurnRequest,
  worldId: WorldId,
  characterId: CharacterId,
) {
  return asUser(deps.pool, req.userId, async (db) => {
    const character = await db.query<{ name: string; persona: string; speech_style: string }>(
      `select name, persona, speech_style from characters
        where id = $1 and world_id = $2 and deleted_at is null`,
      [characterId, worldId],
    );
    const who = character.rows[0];
    // NOT_FOUND rather than FORBIDDEN: RLS has already hidden other people's
    // worlds, so "it exists but is not yours" is a distinction we should not
    // draw for the caller (docs/10 § 3).
    if (who === undefined) throw new ApiError("NOT_FOUND", "That character could not be found.");

    /*
     * Claim the world's turn slot BEFORE anything is written.
     *
     * Two turns in flight interleave — two player lines, then two replies, each
     * generated without the other's question — and the transcript is the record
     * every projection folds from, so an interleaved one is corrupt rather than
     * merely untidy. Two browser tabs is enough to cause it.
     *
     * Claiming first means a rejected turn writes nothing at all.
     */
    if (!(await claimTurnSlot(db, worldId))) {
      throw new ApiError("CONVERSATION_BUSY", "They are still thinking. One moment.", {
        retryAfter: 5,
      });
    }

    const worldDay = await currentWorldDay(db, worldId);
    const turn = await appendTurn(db, {
      worldId,
      speaker: "player",
      content: req.message,
      worldDay,
    });

    const store = new PostgresMemoryStore(db);
    const retrieved = await retrieve(store, deps.embedder, {
      worldId,
      characterId,
      userMessage: req.message,
      // Character and location names are the highest-signal query terms, and
      // ADR-024 is why: the vector query and the keyword query are not the same
      // query, and widening the wrong one cost 63 points of recall.
      aliases: [who.name],
      currentWorldDay: worldDay,
      tokenBudget: RECALL_TOKEN_BUDGET,
      maxMemories: RECALL_LIMIT,
    });

    // What is TRUE NOW for this character, folded from what they may recall.
    const projection = await projectFor(db, worldId, who.name);
    const history = await recentTurns(db, worldId, 8);

    return { who, worldDay, turn, retrieved, projection, history };
  });
}

export async function runTurn(deps: TurnDeps, req: TurnRequest): Promise<TurnResult> {
  const worldId = req.worldId as WorldId;
  const characterId = req.characterId as CharacterId;

  const prepared = await prepareTurn(deps, req, worldId, characterId);

  /*
   * From here the slot is HELD, so every exit must release it. The stale
   * timeout in the migration is the backstop for a process that dies outright;
   * it is not an excuse to leak the claim on an ordinary error, which would
   * block the player's own retry for two minutes.
   */
  try {
    return await generateAndStore(deps, req, worldId, characterId, prepared);
  } catch (e) {
    await asUser(deps.pool, req.userId, async (db) => {
      await releaseTurnSlot(db, worldId);
    }).catch(() => {
      // Secondary. The error worth reporting is the one that got us here, and
      // the claim expires by itself either way.
    });
    throw e;
  }
}

type Prepared = Awaited<ReturnType<typeof prepareTurn>>;

async function generateAndStore(
  deps: TurnDeps,
  req: TurnRequest,
  worldId: WorldId,
  characterId: CharacterId,
  prepared: Prepared,
): Promise<TurnResult> {
  // ── 2. generation, OUTSIDE any transaction ────────────────────────────────
  const threads = openThreads(prepared.projection);
  const knows = prepared.retrieved.memories.map((m) => `  ${m.memory.content}`);
  const commitments = threads.commitments.map(
    (c) => `  ${c.actor} promised ${c.target ?? "someone"}: ${c.what}`,
  );

  const system = [
    `You are ${prepared.who.name}.`,
    prepared.who.persona.length > 0 ? prepared.who.persona : null,
    prepared.who.speech_style.length > 0 ? `You speak like this: ${prepared.who.speech_style}` : null,
    ``,
    knows.length > 0 ? `WHAT YOU REMEMBER` : null,
    ...knows,
    commitments.length > 0 ? `\nWHAT IS STILL OPEN BETWEEN YOU` : null,
    ...commitments,
    ``,
    /*
     * "Do not list what you know" is doing real work. The expression suite
     * measured 81% utilisation with a matching instruction and 3/3 on
     * restraint; without it a character recites its context, which is the
     * specific way an AI stops feeling like a person.
     */
    `Reply in character, in one to three sentences. Let what you remember shape`,
    `what you say and what you decide — do not recite it, and do not mention`,
    `anything you were not told.`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const messages = prepared.history.map((t) => ({
    role: t.speaker === "player" ? ("user" as const) : ("assistant" as const),
    content: t.content,
  }));

  let reply: string;
  try {
    const generated = await deps.router.generate(
      {
        taskClass: "dialogue",
        system,
        messages,
        maxTokens: 220,
        temperature: 0.85,
        timeoutMs: 30_000,
        meta: { requestId: `turn-${prepared.turn.id}` },
      },
      deps.anyModel,
    );
    reply = generated.text.trim();
  } catch (e) {
    throw new ApiError("AI_UNAVAILABLE", "Nobody answered. Try again in a moment.", {
      detail: e instanceof Error ? e.message : String(e),
      retryAfter: 5,
    });
  }
  if (reply.length === 0) {
    throw new ApiError("AI_UNAVAILABLE", "Nobody answered. Try again in a moment.", {
      detail: "empty generation",
      retryAfter: 5,
    });
  }

  // ── 3. extraction, also outside a transaction ─────────────────────────────
  /*
   * Extraction failing must NEVER cost the player their reply. The reply is
   * already generated and the turn already happened; a failed extraction means
   * this exchange produced no events, which the next turn can live with.
   *
   * But it is REPORTED. The first version swallowed the error and returned
   * null, and the first end-to-end run then showed "0 events extracted" with no
   * way to tell a thrown error from a model that found nothing worth keeping —
   * two completely different problems behind one number. A quiet catch is how a
   * subsystem stops working without anybody noticing.
   */
  const extraction = await extractEvents(deps.router, deps.anyModel, {
    worldId,
    /*
     * THE PLAYER'S TURN ONLY. The character's reply is deliberately excluded,
     * and this is the fix for the V0.1 gate failing 1 run in 3.
     *
     * Measured, paired, same generated reply in both arms (`pnpm replynoise`):
     *
     *     A  the player's line alone          8/8
     *     B  the player's line + that reply   4/8
     *     lost only when the reply was present: 4
     *     lost in both arms:                    0
     *
     * A sentence the character INVENTED was deleting a fact the person TYPED,
     * half the time. Not a model — `pnpm shootout` showed gpt-oss-120b and
     * gpt-oss-20b scoring identically, fixture for fixture. Not the prompt, not
     * the temperature: extraction already runs at 0. The window was the whole
     * of it, and the mechanism is mundane — the extra text reframes the
     * exchange as advice-giving, so the model stops seeing a fact worth
     * recording.
     *
     * The principle it settles is bigger than the bug: THE PLAYER'S WORDS ARE
     * GROUND TRUTH, and generated text must never be able to erase them.
     *
     * COST, stated rather than buried. Two things are lost, both real:
     *
     *   Facts a CHARACTER asserts about themselves are no longer recorded.
     *   That needs its own decision, not a free ride on this call, because
     *   extracting canon from generated text is a confabulation channel — the
     *   model inventing "I have lived here my whole life" and having it become
     *   permanent world truth. V1-T22.
     *
     *   Conversational context is gone, so a player's "yes, I promise" whose
     *   subject sits in the character's previous question extracts nothing.
     *   V1-T23. Including PRIOR turns while still excluding the new reply may
     *   fix that, but it is unmeasured, and adding an unmeasured variant to a
     *   fix that is measured is how this gets muddled again.
     *
     * It also costs fewer tokens, which is not the reason but is not nothing.
     */
    transcript: [{ speaker: PLAYER, content: req.message }],
    knownEntities: [
      { ref: `character:${characterId}`, name: prepared.who.name },
      { ref: "narrator", name: PLAYER },
    ],
    aggressiveness: 0.5,
    sourceTurn: prepared.turn.seq,
    // The database assigns the real sequence under a row lock; this only keeps
    // the extractor's own output internally ordered.
    nextSeq: 0,
    worldDay: prepared.worldDay,
  }).catch((e: unknown) => {
    process.stderr.write(
      `  extraction threw for turn ${String(prepared.turn.seq)}: ` +
        `${e instanceof Error ? e.message : String(e)}
`,
    );
    return null;
  });

  if (extraction !== null && extraction.events.length === 0) {
    // Nothing kept is a legitimate outcome — most turns contain no durable
    // fact. `rejected` is what distinguishes "nothing worth keeping" from
    // "four correct events thrown away by a validator", and those need
    // different fixes.
    process.stderr.write(
      `  turn ${String(prepared.turn.seq)}: 0 events from ${String(extraction.proposed)} ` +
        `attempt(s); model=${extraction.modelId}; ` +
        `rejected=${extraction.rejected.map((r) => r.reason).join(",") || "none"}
`,
    );
  }

  // ── 4. the reply and its events, in ONE transaction ───────────────────────
  const stored = await asUser(deps.pool, req.userId, async (db) => {
    /*
     * Released in the SAME transaction that commits the reply. If this
     * transaction rolls back, the slot stays claimed and the whole turn is
     * undone together — the alternative, releasing separately, can free the
     * world while the reply is lost, which invites a second turn into a
     * transcript the first one is still going to write to.
     */
    await releaseTurnSlot(db, worldId);

    await appendTurn(db, {
      worldId,
      speaker: "character",
      characterId,
      content: reply,
      worldDay: prepared.worldDay,
    });

    const written: Array<{ id: MemoryId; content: string }> = [];
    if (extraction === null || extraction.events.length === 0) return written;

    /*
     * Events are attributed to the PLAYER's turn, not the reply's.
     *
     * `source_turn` answers "which sentence produced this", and the sentence is
     * the player's — extraction reads the exchange but the fact originates with
     * what the player said. Attributing it to the reply would make a character
     * the source of the player's own commitments.
     */
    const storedEvents = await appendEvents(
      db,
      worldId,
      extraction.events,
      prepared.turn.seq,
      prepared.worldDay,
      /*
       * Both parties were in this exchange. The player typed it and this
       * character answered it, so both heard every word — that is not an
       * inference, it is what a two-party conversation IS.
       *
       * V0.2: with several characters this becomes the scene's cast, not every
       * character in the world.
       */
      [PLAYER, prepared.who.name],
    );

    /*
     * The memory index is DERIVED from the events, not written in parallel with
     * them. One writer, one vocabulary, and the index can be rebuilt from the
     * log — which is the property that lets the embedding model change.
     */
    const store = new PostgresMemoryStore(db);
    for (const { event: e, audience } of storedEvents) {
      // Rendered as a sentence, not as joined fields. This string goes into the
      // prompt under "WHAT YOU REMEMBER", so it is read by the model that has
      // to sound like it remembers.
      const content = fitToMemory(renderEventAsMemory(e));
      if (content === null) {
        /*
         * An event whose rendering is too short to be a fact leaves the world
         * holding something no character can retrieve — the same shape as the
         * grant bug: two representations of one fact, disagreeing. It should be
         * impossible, so it is reported rather than skipped in silence.
         */
        process.stderr.write(
          `  event ${e.type} on turn ${String(prepared.turn.seq)} rendered too short ` +
            `to store as a memory; the event is kept and nothing can recall it\n`,
        );
        continue;
      }
      const memory = await store.insert({
        worldId,
        /*
         * Derived from the event type, NOT hardcoded. `kind` selects the decay
         * half-life — episodic 30 days, persona 180, world never — and every
         * memory used to be filed `episodic`, so a stated trait faded like an
         * errand. See core/world/memory-kind.ts.
         */
        kind: memoryKindForEvent(e.type),
        content,
        worldDay: e.worldDay,
        importance: e.importance,
        /*
         * Who this memory is ABOUT, which `characterRelevance` scores. Set only
         * when the event actually names this character — an exact fact, never a
         * guess. Left unset, every memory scored the same 0.1 "not about
         * anyone", and the term contributed nothing to any ranking.
         */
        subjects: namesThisCharacter(e, prepared.who.name)
          ? [`character:${characterId}`]
          : [],
        // The event already decided who may know this. The memory inherits it
        // rather than deciding again — one rule, applied once.
        visibility: "restricted",
      });
      /*
       * The grant mirrors the event's STORED AUDIENCE — the actual array that
       * was written, not a recomputation of the rule.
       *
       * Two earlier versions of this line were wrong in the same direction.
       * The first read `knownBy`, the field the extractor fills in, and granted
       * nothing whenever the model failed to name the listener. The second
       * called `canRecall(e, name)`, which recomputes `audienceFor` and so
       * cannot see the `present` names the backend unioned in — the event was
       * written `audience=[the user, Elena]` and the check said no.
       *
       * Both are the same mistake: deriving an answer that has already been
       * decided and stored. `inAudience` reads what was written.
       */
      if (inAudience({ event: e, audience }, prepared.who.name)) {
        await store.grantKnowledge(characterId, memory.id, "told", 1, e.worldDay);
      }
      // The player has no character row, so their own knowledge is carried by
      // the event log alone. Noted so the asymmetry does not read as an omission.
      written.push({ id: memory.id, content });
    }
    return written;
  });

  /*
   * ── 5. EMBED WHAT WAS JUST WRITTEN ────────────────────────────────────────
   *
   * Without this the vector path is dead. `setEmbedding` was never called, so
   * every memory sat with no vector; `vectorSearch` skips those by design —
   * "retrieval degrades, never fails" — and the whole burden fell on keyword
   * overlap and recency.
   *
   * That is exactly the path that cannot work here. The stored memory reads
   * "the user cannot swim, never learned" and the question a day later is
   * "should we wade across the channel?" — not one content word in common.
   * Bridging that is the entire reason the semantic index exists, and it was
   * switched off. Extraction reached 9/10 while the gate sat at 5/10, and the
   * gap was this.
   *
   * In its OWN transaction, after the write committed. Embedding is a network
   * call, and holding a database connection open across one is the same mistake
   * as wrapping the generation in a transaction — a handful of concurrent users
   * exhaust the pool while everyone waits on someone else's HTTP.
   *
   * Failure here is survivable BY DESIGN and must stay that way: the memory
   * exists without a vector, `pendingEmbeddings` already models exactly that
   * state, and retrieval falls back to keyword and structural rather than
   * erroring. A background re-embed job (V0.2) drains the backlog.
   */
  if (stored.length > 0) {
    try {
      const vectors = await deps.embedder.embed(stored.map((m) => m.content));
      await asUser(deps.pool, req.userId, async (db) => {
        const store = new PostgresMemoryStore(db);
        for (const [i, m] of stored.entries()) {
          const vector = vectors[i];
          if (vector === undefined) continue;
          await store.setEmbedding(m.id, vector, deps.embedder.id, deps.embedder.version);
        }
      });
    } catch (e) {
      process.stderr.write(
        `  embedding failed for ${String(stored.length)} memories on turn ` +
          `${String(prepared.turn.seq)}: ${e instanceof Error ? e.message : String(e)}
`,
      );
    }
  }

  return {
    reply,
    recalled: prepared.retrieved.memories.map((m) => ({
      content: m.memory.content,
      worldDay: m.memory.worldDay,
    })),
    eventsExtracted: stored.length,
  };
}
