import { audienceFor, project, type WorldProjection } from "@darkforest/core";
import type { ProposedEvent, WorldEvent } from "@darkforest/contracts";
import type { DbClient } from "./client.js";

/**
 * THE WORLD REPOSITORY — turns in, events out, projections folded on read.
 *
 * This is where the frozen architecture becomes storage. Three rules it exists
 * to keep, none of which survive being left to callers:
 *
 *  1. A turn and the events read from it land in ONE transaction. Half a turn
 *     is worse than no turn: the transcript says something happened and the
 *     event log disagrees, and every projection folded afterwards is wrong in a
 *     way nothing detects.
 *
 *  2. `audienceFor()` runs HERE, at write time, and its output is stored. It
 *     stays the single implementation of the audience rule (core/world/
 *     knowledge.ts exists because there were two and they disagreed), while the
 *     filtering itself happens in SQL where a caller cannot skip it.
 *
 *  3. Reads are already isolated. `recallableEvents` takes a `who` and there is
 *     no method that returns a world's events unfiltered.
 */

export type Speaker = "player" | "character" | "narrator";

/**
 * Removes bytes Postgres cannot store in a `text` column.
 *
 * A NUL is not "unusual text" to Postgres — it cannot be represented at all,
 * and the driver reports `invalid byte sequence for encoding "UTF8": 0x00`,
 * which reads like a database or locale problem rather than what it is: a model
 * emitted a stray control character and the whole turn was rejected with a 500.
 *
 * Applied at the persistence boundary rather than at the provider, because
 * EVERY path that stores generated text needs it and a provider-side fix
 * protects only the paths that go through that provider. Other control
 * characters are stored as-is; only the ones that cannot round-trip go.
 */
function storable(s: string): string {
  // eslint-disable-next-line no-control-regex -- NUL is the specific byte Postgres rejects.
  return s.replace(/\u0000/g, "");
}

export interface NewTurn {
  worldId: string;
  speaker: Speaker;
  /** Required for `character`, forbidden otherwise — the schema checks this too. */
  characterId?: string | null;
  content: string;
  worldDay: number;
}

export interface StoredTurn {
  id: string;
  seq: number;
  worldDay: number;
}

interface EventRow {
  id: string;
  world_id: string;
  world_day: number;
  seq: number;
  type: string;
  actor: string;
  target: string | null;
  object: string | null;
  value: string | null;
  quantity: number | string | null;
  location: string | null;
  participants: string[];
  visibility: string;
  known_by: string[];
  importance: number | string;
  source_turn: number;
  caused_by: string | null;
}

function toEvent(r: EventRow): WorldEvent {
  return {
    id: r.id,
    worldId: r.world_id,
    worldDay: r.world_day,
    seq: r.seq,
    type: r.type as WorldEvent["type"],
    actor: r.actor,
    target: r.target,
    object: r.object,
    value: r.value,
    quantity: r.quantity === null ? null : Number(r.quantity),
    location: r.location,
    participants: r.participants,
    visibility: r.visibility as WorldEvent["visibility"],
    knownBy: r.known_by,
    importance: Number(r.importance),
    sourceTurn: r.source_turn,
    causedBy: r.caused_by,
  };
}

/** Appends one turn, taking its sequence number under the world's row lock. */
export async function appendTurn(db: DbClient, turn: NewTurn): Promise<StoredTurn> {
  const { rows: seqRows } = await db.query<{ next_turn_seq: number }>(
    "select next_turn_seq($1)",
    [turn.worldId],
  );
  const seq = seqRows[0]?.next_turn_seq;
  if (seq === undefined) throw new Error("could not allocate a turn sequence");

  const { rows } = await db.query<{ id: string }>(
    `insert into turns (world_id, seq, speaker, character_id, content, world_day)
     values ($1,$2,$3,$4,$5,$6)
     returning id`,
    [
      turn.worldId,
      seq,
      turn.speaker,
      turn.speaker === "character" ? (turn.characterId ?? null) : null,
      storable(turn.content),
      turn.worldDay,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("turn insert returned no row");
  return { id, seq, worldDay: turn.worldDay };
}

/**
 * Appends extracted events, stamping the fields the backend owns.
 *
 * `worldDay`, `seq`, `sourceTurn` and `worldId` are all assigned here and are
 * deliberately absent from `ProposedEventSchema`. Asking the model to echo back
 * data the backend already has cost 25 of 66 extractions in the first A/B run —
 * every one of them a CORRECT event, rejected for omitting a field we knew.
 */
export async function appendEvents(
  db: DbClient,
  worldId: string,
  proposed: readonly ProposedEvent[],
  sourceTurn: number,
  worldDay: number,
  /*
   * WHO WAS DEMONSTRABLY IN THE EXCHANGE. Backend ground truth, not inference.
   *
   * The V0.1 acceptance test failed here after extraction was fixed. A stranger
   * told Elena "I can't swim", the event stored correctly, and Elena could not
   * recall it a day later — because `audienceFor` restricts a
   * `preference_stated` to its actor, and the extractor had not named Elena as
   * the target. The player was speaking directly to her and she could not
   * remember a word of it.
   *
   * The wrong fix is to loosen `audienceFor`. That rule fails closed because
   * the extractor is demonstrably unreliable about who was present, and
   * loosening it is what produced the Saltmarsh leak.
   *
   * The right fix is that the BACKEND knows something the extractor does not:
   * who this conversation was between. That is not a guess — it is the same
   * class of fact as `worldDay` and `sourceTurn`, which the backend also stamps
   * rather than asking the model to echo. Being TOLD something is how a
   * character legitimately learns it; the Saltmarsh leak was a character
   * recorded as having SEEN something, which is a different claim entirely.
   *
   * V0.2 CAUTION: with several characters this must come from the SCENE — who
   * was actually there — and never from "every character in the world". The
   * moment it means the latter, isolation is gone.
   */
  present: readonly string[] = [],
): Promise<WorldEvent[]> {
  const stored: WorldEvent[] = [];

  for (const p of proposed) {
    const { rows: seqRows } = await db.query<{ next_event_seq: number }>(
      "select next_event_seq($1)",
      [worldId],
    );
    const seq = seqRows[0]?.next_event_seq;
    if (seq === undefined) throw new Error("could not allocate an event sequence");

    /*
     * The audience is computed from the COMPLETE event, so `audienceFor` sees
     * exactly what it will see when the same event is read back. Building it
     * from the proposal alone would work today and break the moment the rule
     * consults a field the backend stamps.
     */
    const complete: WorldEvent = {
      ...p,
      id: "00000000-0000-0000-0000-000000000000",
      worldId,
      worldDay,
      seq,
      sourceTurn,
    };
    const audience = audienceFor(complete);
    /*
     * A public audience has no array representation, and nothing produces one
     * today — `audienceFor` returns `restricted` for every current type. If a
     * broadcast type is ever added, it needs a column of its own rather than a
     * sentinel value in this one, because "everyone" and "these three people"
     * are not the same kind of thing and `@>` cannot express both.
     */
    if (audience.kind === "public") {
      throw new Error(
        "a public audience has no stored form yet; add an explicit broadcast column",
      );
    }

    // The rule's output, plus whoever the backend knows was in the room.
    // Case-insensitive union, keeping the first spelling seen.
    const seen = new Set<string>();
    const finalAudience: string[] = [];
    for (const name of [...audience.who, ...present]) {
      const key = name.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      finalAudience.push(name);
    }

    const { rows } = await db.query<EventRow>(
      `insert into events
         (world_id, world_day, seq, type, actor, target, object, value, quantity,
          location, participants, visibility, known_by, importance, audience,
          source_turn, caused_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       returning id, world_id, world_day, seq, type, actor, target, object, value,
                 quantity, location, participants, visibility, known_by, importance,
                 source_turn, caused_by`,
      [
        worldId,
        worldDay,
        seq,
        p.type,
        storable(p.actor),
        p.target === null ? null : storable(p.target),
        p.object === null ? null : storable(p.object),
        p.value === null ? null : storable(p.value),
        p.quantity,
        p.location === null ? null : storable(p.location),
        p.participants.map(storable),
        p.visibility,
        p.knownBy.map(storable),
        p.importance,
        finalAudience,
        sourceTurn,
        p.causedBy,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("event insert returned no row");
    stored.push(toEvent(row));
  }

  return stored;
}

/**
 * Every event `who` may recall, in fold order.
 *
 * The filter is `audience @> array[$who]` — in the query, not afterwards. There
 * is deliberately no sibling function that returns a world's events unfiltered:
 * a caller handed unfiltered rows and trusted to filter them will eventually
 * forget, and the failure mode is a character revealing a secret nobody told
 * them.
 *
 * Case-insensitive, because the audience holds names as the transcript spelled
 * them and "Elena" must match "elena".
 */
export async function recallableEvents(
  db: DbClient,
  worldId: string,
  who: string,
): Promise<WorldEvent[]> {
  const { rows } = await db.query<EventRow>(
    `select id, world_id, world_day, seq, type, actor, target, object, value,
            quantity, location, participants, visibility, known_by, importance,
            source_turn, caused_by
       from events
      where world_id = $1
        and exists (
          select 1 from unnest(audience) as name
           where lower(name) = lower($2)
        )
      order by world_day asc, seq asc`,
    [worldId, who],
  );
  return rows.map(toEvent);
}

/**
 * What is true now, from this character's point of view.
 *
 * Folded on read rather than read from a projections table. `project()` is a
 * pure function of the event log with one implementation; a materialised copy
 * would be a second source of truth that can silently disagree with it. A
 * snapshot is worth adding when refolding is measurably slow — and that will be
 * a measurement, not a hunch.
 */
export async function projectFor(
  db: DbClient,
  worldId: string,
  who: string,
): Promise<WorldProjection> {
  return project(await recallableEvents(db, worldId, who));
}

/** The in-world clock. Every event is stamped with it. */
export async function currentWorldDay(db: DbClient, worldId: string): Promise<number> {
  const { rows } = await db.query<{ day: number }>(
    "select day from world_state where world_id = $1",
    [worldId],
  );
  const day = rows[0]?.day;
  if (day === undefined) throw new Error(`world ${worldId} has no world_state row`);
  return day;
}

/** The last `limit` turns, oldest first — the shape a prompt wants them in. */
export async function recentTurns(
  db: DbClient,
  worldId: string,
  limit: number,
): Promise<Array<{ seq: number; speaker: Speaker; characterId: string | null; content: string }>> {
  const { rows } = await db.query<{
    seq: number;
    speaker: string;
    character_id: string | null;
    content: string;
  }>(
    `select seq, speaker, character_id, content from (
       select seq, speaker, character_id, content
         from turns where world_id = $1
        order by seq desc limit $2
     ) recent order by seq asc`,
    [worldId, limit],
  );
  return rows.map((r) => ({
    seq: r.seq,
    speaker: r.speaker as Speaker,
    characterId: r.character_id,
    content: r.content,
  }));
}
