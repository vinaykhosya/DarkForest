import { z } from "zod";

/**
 * WORLD EVENTS — the experimental canonical record (ADR-025).
 *
 * An event is something that HAPPENED. It is immutable and never revised. What
 * is TRUE NOW is folded from the event log deterministically (see
 * packages/core/src/world/projections.ts), never stored twice.
 *
 * That separation is the point. The current memory store writes mutable facts as
 * immutable records: "Elena has the ring" on day 12 and "Marcus has the ring" on
 * day 40 both persist, both are retrievable, and asking who has the ring returns
 * whichever scores higher. No ranking weight can fix that, because the
 * information needed to resolve it — that the second event supersedes the first
 * with respect to ownership — was never represented.
 *
 * This is deliberately NOT a general graph. There are no causal edges, because
 * nothing measured so far requires them and a wrong edge is invisible and
 * permanent. Events carry `causedBy` only where the transcript states a cause
 * outright.
 */

/**
 * A closed enum, which is what makes validation possible at write time.
 *
 * Kept minimal on purpose: each type must earn its place by feeding a projection
 * that answers a question users actually ask. A type that feeds nothing is a
 * field the extractor can get wrong for no benefit.
 */
export const WorldEventTypeSchema = z.enum([
  // → ownership
  "acquired",
  "gave",
  "lost",
  // → commitments
  "promised",
  "refused",
  "fulfilled",
  // → open questions
  "asked",
  "answered",
  // → knowledge
  "revealed",
  /*
   * Someone PERCEIVED something that already existed. Distinct from
   * `world_event`, which is the world changing, and from `acquired`, which is
   * taking. Measured 2026-09-06 on 32 unseen sentences: perception captured 33%
   * against 67-83% for every other shape, and see/hear/notice/smell produced NO
   * event at all while discover/find worked. The model was not failing to judge
   * importance - the ontology had nowhere to put the fact.
   *
   * The separation matters beyond extraction. A tunnel existing beneath the
   * chapel is world truth; the user finding it is a knowledge transition; Elena
   * still not knowing is her state. Collapsing those into one record is how a
   * character reveals a secret nobody told them.
   */
  "observed",
  // → relationships
  "relation_stated",
  "relation_changed",
  // → persona
  "preference_stated",
  // → numerics
  "numeric_stated",
  // → the log itself
  "world_event",
]);
export type WorldEventType = z.infer<typeof WorldEventTypeSchema>;

/**
 * Who may recall this. Mirrors the existing memory visibility rules so knowledge
 * isolation stays one concept rather than two.
 */
export const EventVisibilitySchema = z.enum(["world", "witnessed", "private"]);
export type EventVisibility = z.infer<typeof EventVisibilitySchema>;

export const WorldEventSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  /** In-world day. Ordering key, paired with seq. */
  worldDay: z.number().int().nonnegative(),
  /** Monotonic within a world. Breaks ties inside one day. */
  seq: z.number().int().nonnegative(),
  type: WorldEventTypeSchema,

  /**
   * Names, not ids. Resolving refs backend-side rather than asking the model to
   * emit them is settled: requiring `character:<uuid>` made one malformed ref
   * reject an entire validated batch, and three of four worlds extracted nothing.
   */
  actor: z.string().min(1),
  target: z.string().nullable().default(null),
  /** The thing acted upon — an object, a topic, a fact. */
  object: z.string().nullable().default(null),

  /**
   * The payload in the world's own words: what was promised, what was asked,
   * what was refused. Kept verbatim so a projection never has to re-infer it.
   */
  value: z.string().max(300).nullable().default(null),
  quantity: z.number().nullable().default(null),
  location: z.string().nullable().default(null),

  participants: z.array(z.string()).default([]),
  visibility: EventVisibilitySchema.default("world"),
  knownBy: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5),

  /** The turn this was read from. The raw transcript stays the ground truth. */
  sourceTurn: z.number().int().nonnegative(),
  /** Only when the transcript states the cause outright. Never inferred. */
  causedBy: z.string().nullable().default(null),
});
export type WorldEvent = z.infer<typeof WorldEventSchema>;

/**
 * What the extractor proposes, before the backend assigns identity and order.
 *
 * `worldDay` is omitted deliberately, alongside id/worldId/seq/sourceTurn: the
 * caller already knows the day and stamps it. Requiring the model to echo it
 * back cost 25 of 66 extractions in the first A/B run — every one of them a
 * CORRECT event, rejected for omitting a field the backend owns.
 *
 * This is the UUID-ref mistake in a new costume. That schema made models emit
 * `character:<uuid>` refs, one malformed ref rejected an entire validated batch,
 * and three of four worlds extracted nothing. The rule that came out of it holds
 * here too: never make the model responsible for data the backend already has.
 */
export const ProposedEventSchema = WorldEventSchema.omit({
  id: true,
  worldId: true,
  seq: true,
  sourceTurn: true,
  worldDay: true,
});
export type ProposedEvent = z.infer<typeof ProposedEventSchema>;

export const EventExtractionSchema = z.object({
  events: z.array(ProposedEventSchema).max(4),
});
export type EventExtraction = z.infer<typeof EventExtractionSchema>;
