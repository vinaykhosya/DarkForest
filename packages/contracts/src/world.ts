import { z } from "zod";
import { CharacterIdSchema, WorldIdSchema, type PersonaId } from "./ids.js";

/** World contracts — docs/05-world-engine.md. */

export const TimeOfDaySchema = z.enum([
  "dawn",
  "morning",
  "midday",
  "afternoon",
  "evening",
  "night",
  "late_night",
]);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const ContentRatingSchema = z.enum(["general", "teen", "mature"]);
export type ContentRating = z.infer<typeof ContentRatingSchema>;

/**
 * Declared world variables. `flags` and `numerics` are jsonb because every world
 * tracks different things — but they remain AUTHORITATIVE, because writes are
 * validated against these declarations. An undeclared key is rejected. docs/05 § 3.
 */
export const FlagDeclarationSchema = z.object({
  type: z.literal("bool"),
  default: z.boolean(),
  label: z.string().max(60),
  visible: z.boolean().default(false),
});

export const NumericDeclarationSchema = z.object({
  type: z.enum(["int", "float"]),
  min: z.number(),
  max: z.number(),
  default: z.number(),
  label: z.string().max(60),
  visible: z.boolean().default(true),
  /** Per-turn movement cap. Bounds the damage from a confused or manipulated model. */
  maxDelta: z.number().positive().default(50),
});

export const WorldRuleSchema = z.object({
  ruleText: z.string().trim().min(3).max(500),
  category: z.enum([
    "general",
    "magic",
    "technology",
    "politics",
    "physics",
    "society",
    "tone",
    "forbidden",
  ]),
  /** `always` rules are capped at 8 — beyond that the model starts ignoring all of them. */
  scope: z.enum(["always", "contextual"]),
  keywords: z.array(z.string().trim().max(40)).max(12).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  /** Hard rules are stated in the prompt AND enforced in code. docs/05 § 4. */
  isHard: z.boolean().default(false),
});
export type WorldRule = z.infer<typeof WorldRuleSchema>;

export const WorldStateSchema = z.object({
  worldId: WorldIdSchema,
  /** Optimistic concurrency token. Every write is conditioned on the value read. */
  version: z.bigint(),
  day: z.number().int().min(0),
  timeOfDay: TimeOfDaySchema,
  currentLocation: z.string().max(120).nullable(),
  weather: z.string().max(60).nullable(),
  chapter: z.number().int().min(1),
  chapterTitle: z.string().max(160).nullable(),
  sceneSummary: z.string().max(2000).default(""),
  flags: z.record(z.string(), z.boolean()).default({}),
  numerics: z.record(z.string(), z.number()).default({}),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

export const WorldSettingsSchema = z.object({
  maxResponders: z.number().int().min(1).max(8).default(3),
  perspective: z.enum(["first", "second", "third"]).default("second"),
  narrationStyle: z.string().max(80).default("balanced"),
  allowTimeSkip: z.boolean().default(true),
  memoryAggressiveness: z.number().min(0).max(1).default(0.5),
  declaredFlags: z.record(z.string(), FlagDeclarationSchema).default({}),
  declaredNumerics: z.record(z.string(), NumericDeclarationSchema).default({}),
});
export type WorldSettings = z.infer<typeof WorldSettingsSchema>;

export const SceneSchema = z.object({
  location: z.string().max(120).nullable(),
  presentCharacterIds: z.array(CharacterIdSchema).max(64).default([]),
  timeOfDay: TimeOfDaySchema,
  summary: z.string().max(2000).default(""),
});
export type Scene = z.infer<typeof SceneSchema>;

/**
 * Everything the context builder needs about the world for one turn.
 * Assembled by ONE batched read — the Workers free tier allows 50 subrequests
 * per request and every PostgREST call spends one. docs/02 § 3 step 5.
 */
export interface WorldContext {
  worldId: string;
  name: string;
  genre: string[];
  tone: string;
  contentRating: ContentRating;
  state: WorldState;
  settings: WorldSettings;
  scene: Scene;
  rules: WorldRule[];
  personaId: PersonaId | null;
}

// ─── Mutations ────────────────────────────────────────────────────────────────
// docs/05 § 5. The model never writes to the database. It REQUESTS a mutation;
// the backend validates and decides. A prose assertion of change is decorative.

export const MutationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_flag"),
    key: z.string().max(60),
    value: z.boolean(),
  }),
  z.object({
    op: z.literal("adjust_numeric"),
    key: z.string().max(60),
    delta: z.number(),
  }),
  z.object({
    op: z.literal("record_event"),
    title: z.string().trim().min(3).max(120),
    eventType: z.string().max(40),
    importance: z.number().min(0).max(1),
  }),
  z.object({
    op: z.literal("move_character"),
    characterId: CharacterIdSchema,
    location: z.string().max(120),
  }),
  z.object({
    op: z.literal("advance_time"),
    hours: z.number().min(0).max(24),
  }),
  z.object({
    op: z.literal("set_character_alive"),
    characterId: CharacterIdSchema,
    alive: z.boolean(),
  }),
]);
export type Mutation = z.infer<typeof MutationSchema>;

/** docs/05 § 5 — per-turn caps bound the blast radius of a bad generation. */
export const MUTATION_CAPS = {
  relationshipDeltas: 6,
  numericAdjustments: 4,
  flagChanges: 3,
  questTransitions: 2,
  timeAdvances: 1,
} as const;

export interface MutationResult {
  applied: Mutation[];
  rejected: Array<{ mutation: unknown; reason: string }>;
  newVersion: bigint;
}
