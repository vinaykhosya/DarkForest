import type {
  AIProvider,
  CharacterId,
  EmbeddingProvider,
  ModelDescriptor,
  WorldId,
} from "@darkforest/contracts";
import {
  PostgresMemoryStore,
  appendEvents,
  appendTurn,
  asUser,
  currentWorldDay,
  projectFor,
  recentTurns,
  type DbPool,
} from "@darkforest/db";
import { extractEvents, retrieve } from "@darkforest/memory";
import { openThreads } from "@darkforest/core";
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

export async function runTurn(deps: TurnDeps, req: TurnRequest): Promise<TurnResult> {
  const worldId = req.worldId as WorldId;
  const characterId = req.characterId as CharacterId;

  // ── 1. the player's turn, and everything needed to answer it ──────────────
  const prepared = await asUser(deps.pool, req.userId, async (db) => {
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
   * this exchange produced no events, which the next turn can live with. So it
   * catches, and the turn continues.
   */
  const extraction = await extractEvents(deps.router, deps.anyModel, {
    worldId,
    transcript: [
      { speaker: PLAYER, content: req.message },
      { speaker: prepared.who.name, content: reply },
    ],
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
  }).catch(() => null);

  // ── 4. the reply and its events, in ONE transaction ───────────────────────
  const stored = await asUser(deps.pool, req.userId, async (db) => {
    await appendTurn(db, {
      worldId,
      speaker: "character",
      characterId,
      content: reply,
      worldDay: prepared.worldDay,
    });

    if (extraction === null || extraction.events.length === 0) return 0;

    /*
     * Events are attributed to the PLAYER's turn, not the reply's.
     *
     * `source_turn` answers "which sentence produced this", and the sentence is
     * the player's — extraction reads the exchange but the fact originates with
     * what the player said. Attributing it to the reply would make a character
     * the source of the player's own commitments.
     */
    const events = await appendEvents(
      db,
      worldId,
      extraction.events,
      prepared.turn.seq,
      prepared.worldDay,
    );

    /*
     * The memory index is DERIVED from the events, not written in parallel with
     * them. One writer, one vocabulary, and the index can be rebuilt from the
     * log — which is the property that lets the embedding model change.
     */
    const store = new PostgresMemoryStore(db);
    for (const e of events) {
      const content = [e.actor, e.type.replace(/_/g, " "), e.target, e.object, e.value]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .join(" ");
      if (content.length < 8) continue;
      const memory = await store.insert({
        worldId,
        kind: "episodic",
        content: content.slice(0, 200),
        worldDay: e.worldDay,
        importance: e.importance,
        // The event already decided who may know this. The memory inherits it
        // rather than deciding again — one rule, applied once.
        visibility: "restricted",
      });
      // `audience` on the event is the authority; grants mirror it.
      for (const name of e.knownBy.concat(e.actor)) {
        if (name.toLowerCase() === prepared.who.name.toLowerCase()) {
          await store.grantKnowledge(characterId, memory.id, "witnessed", 1, e.worldDay);
        }
      }
      if (e.actor === PLAYER || e.knownBy.some((n) => n.toLowerCase() === PLAYER)) {
        // The player is not a character row, so their knowledge is carried by
        // the event log alone. Nothing to grant here; noted so the asymmetry
        // does not read as an omission.
      }
    }
    return events.length;
  });

  return {
    reply,
    recalled: prepared.retrieved.memories.map((m) => ({
      content: m.memory.content,
      worldDay: m.memory.worldDay,
    })),
    eventsExtracted: stored,
  };
}
