import { z } from "zod";
import { CharacterIdSchema, EntityRefSchema, MemoryIdSchema, WorldIdSchema } from "./ids.js";

/**
 * Memory contracts — docs/04-memory-engine.md.
 *
 * The writing invariants in § 3 of that document are enforced here, at the schema
 * boundary, because an invalid memory row is worse than a missing one: it will be
 * retrieved, believed and repeated for months.
 */

export const MemoryKindSchema = z.enum([
  "episodic", // what happened
  "semantic", // what is true
  "relational", // how two entities relate, and why
  "world", // a global event — never decays
  "persona", // a fact about the player
  "reflection", // a synthesised insight — produced by consolidation only
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryVisibilitySchema = z.enum(["world", "restricted", "private"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const KnowledgeSourceSchema = z.enum([
  "witnessed",
  "told",
  "inferred",
  "overheard",
  "authored",
]);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/** docs/04 § 3 — one fact, third person, self-contained, ≤200 chars. */
export const MemoryContentSchema = z
  .string()
  .trim()
  .min(8, "A memory shorter than 8 characters is not a fact.")
  .max(200, "Over 200 characters means this is more than one fact. Split it.");

export const MemorySchema = z.object({
  id: MemoryIdSchema,
  worldId: WorldIdSchema,
  kind: MemoryKindSchema,
  content: MemoryContentSchema,
  subjects: z.array(EntityRefSchema).max(8).default([]),
  location: z.string().max(120).nullable().default(null),
  worldDay: z.number().int().min(0).nullable().default(null),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).default(1),
  visibility: MemoryVisibilitySchema.default("world"),
  isPinned: z.boolean().default(false),
  isUserEdited: z.boolean().default(false),
  supersededBy: MemoryIdSchema.nullable().default(null),
  accessCount: z.number().int().min(0).default(0),
  lastAccessedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().nullable().default(null),
  /** Soft delete. Retrieval must exclude these; consolidation must not resurrect them. */
  deletedAt: z.string().datetime().nullable().default(null),
});
export type Memory = z.infer<typeof MemorySchema>;

/** A memory as returned by retrieval, carrying its scoring provenance. */
export const RetrievedMemorySchema = MemorySchema.extend({
  score: z.number(),
  /** Per-term contributions. Kept so `explainTurn` can answer "why did she say that?". */
  scoreBreakdown: z.record(z.string(), z.number()),
  /** How this candidate was found. A memory can surface through more than one path. */
  retrievedVia: z.array(z.enum(["vector", "keyword", "pinned", "recent", "subject"])).min(1),
  /** Below 0.9 the model is instructed to hedge rather than assert. */
  certainty: z.number().min(0).max(1).default(1),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemorySchema>;

// ─── Extraction ───────────────────────────────────────────────────────────────
// docs/04 § 4. This is the schema the model must produce. Neither Nemotron model
// supports `response_format`, so on those endpoints this is enforced via the
// tool-calling fallback (docs/08 § 9) — not by trusting the prose.

/**
 * A character NAME as the model writes it. Resolved to a CharacterId by the
 * extraction service against the world's roster.
 *
 * WHY NAMES AND NOT IDS — learned the hard way, 2026-09-04.
 * The first version required `character:<uuid>` refs. Models are poor at
 * copying 36-character random strings, and because Zod validates the whole
 * object, ONE malformed ref rejected the entire extraction batch. Measured
 * effect: 3 of 4 test worlds extracted zero memories, reported only as
 * "unparseable".
 *
 * Asking a model to echo an identifier is a bad contract. The model emits what
 * it can say reliably — a name — and the backend does the lookup, which it can
 * do perfectly.
 */
const CharacterNameSchema = z.string().trim().min(1).max(80);

export const ExtractedMemorySchema = z.object({
  kind: MemoryKindSchema,
  content: MemoryContentSchema,
  /** Character names. Unknown names are dropped during resolution, not rejected. */
  subjects: z.array(CharacterNameSchema).max(8).default([]),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).default(0.9),
  worldDay: z.number().int().min(0).nullable().default(null),
  /**
   * Knowledge isolation at birth (docs/06 § 3). Empty means world-visible.
   * Getting this wrong here is how secrets leak weeks later.
   */
  knownBy: z.array(CharacterNameSchema).default([]),
  visibility: MemoryVisibilitySchema.default("world"),
});
export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;

export const RelationshipDeltaSchema = z.object({
  /** Names, resolved by the backend. See CharacterNameSchema above. */
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  deltas: z
    .object({
      trust: z.number().int().min(-15).max(15).optional(),
      affection: z.number().int().min(-15).max(15).optional(),
      respect: z.number().int().min(-15).max(15).optional(),
      fear: z.number().int().min(-15).max(15).optional(),
      romance: z.number().int().min(-15).max(15).optional(),
      loyalty: z.number().int().min(-15).max(15).optional(),
      hostility: z.number().int().min(-15).max(15).optional(),
      familiarity: z.number().int().min(0).max(15).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, "A delta must move at least one dimension."),
  /** docs/06 § 5 — a delta without a reason is rejected. No exceptions. */
  reason: z.string().trim().min(8).max(240),
});
export type RelationshipDelta = z.infer<typeof RelationshipDeltaSchema>;

export const ExtractionResultSchema = z.object({
  memories: z.array(ExtractedMemorySchema).max(10),
  relationshipDeltas: z.array(RelationshipDeltaSchema).max(6),
  events: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(120),
        description: z.string().trim().max(400).default(""),
        eventType: z.enum([
          "story",
          "combat",
          "social",
          "discovery",
          "death",
          "betrayal",
          "romance",
          "quest",
          "system",
        ]),
        participants: z.array(EntityRefSchema).max(12).default([]),
        importance: z.number().min(0).max(1),
      }),
    )
    .max(3),
  contradictions: z
    .array(
      z.object({
        memoryId: MemoryIdSchema,
        reason: z.string().trim().min(8).max(240),
      }),
    )
    .max(5)
    .default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// ─── Retrieval ────────────────────────────────────────────────────────────────

export const RetrievalQuerySchema = z.object({
  worldId: WorldIdSchema,
  /** null = narrator, which has world-scope visibility. Characters do not. */
  characterId: CharacterIdSchema.nullable(),
  queryText: z.string().min(1),
  sceneEntities: z.array(z.string()).default([]),
  tokenBudget: z.number().int().positive(),
  currentWorldDay: z.number().int().min(0),
  candidatePoolSize: z.number().int().min(5).max(100).default(40),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuerySchema>;

/** Stored per turn so "why did she say that?" is answerable. docs/04 § 12. */
export const RetrievalTraceSchema = z.object({
  queryText: z.string(),
  characterId: CharacterIdSchema.nullable(),
  candidateCount: z.number().int(),
  selected: z.array(
    z.object({
      memoryId: MemoryIdSchema,
      score: z.number(),
      breakdown: z.record(z.string(), z.number()),
    }),
  ),
  droppedForBudget: z.array(MemoryIdSchema),
  tokensUsed: z.number().int(),
  durationMs: z.number().int(),
});
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
