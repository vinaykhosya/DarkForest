import { z } from "zod";
import { CharacterIdSchema, EntityRefSchema, WorldIdSchema } from "./ids.js";

/** Character & relationship contracts — docs/06-character-and-relationship-engine.md. */

// docs/09 § 4 defense 5 — length caps bound both cost and injection surface.
const CAPS = {
  personality: 2000,
  backstory: 4000,
  speechStyle: 600,
  exampleLine: 300,
  values: 1000,
} as const;

export const CharacterProfileSchema = z.object({
  personality: z.string().trim().max(CAPS.personality).default(""),
  traits: z.array(z.string().trim().max(60)).max(12).default([]),
  speechStyle: z.string().trim().max(CAPS.speechStyle).default(""),
  valuesBeliefs: z.string().trim().max(CAPS.values).default(""),
  fears: z.array(z.string().trim().max(120)).max(8).default([]),
  backstory: z.string().trim().max(CAPS.backstory).default(""),
  /**
   * docs/06 § 2 — the highest-leverage field in the character model.
   * Three lines of real dialogue beat three paragraphs of description, because
   * they demonstrate rhythm and register rather than describing them.
   * Two is the enforced minimum: a character without a voice is not usable.
   */
  exampleLines: z
    .array(z.string().trim().min(3).max(CAPS.exampleLine))
    .min(2, "A character needs at least two example lines. See docs/06 § 2.")
    .max(8),
  /** Hard constraints. Stated in the prompt AND checked in output moderation. */
  forbidden: z.array(z.string().trim().max(160)).max(10).default([]),
});
export type CharacterProfile = z.infer<typeof CharacterProfileSchema>;

export const CharacterGoalSchema = z.object({
  goal: z.string().trim().min(3).max(240),
  kind: z.enum(["immediate", "short_term", "long_term", "hidden"]),
  priority: z.number().int().min(0).max(100).default(50),
  status: z.enum(["active", "achieved", "abandoned", "blocked"]).default("active"),
});
export type CharacterGoal = z.infer<typeof CharacterGoalSchema>;

export const CharacterSecretSchema = z.object({
  secret: z.string().trim().min(3).max(400),
  severity: z.number().min(0).max(1).default(0.5),
  knownBy: z.array(CharacterIdSchema).default([]),
  revealedToUser: z.boolean().default(false),
  revealCondition: z.string().trim().max(240).nullable().default(null),
});
export type CharacterSecret = z.infer<typeof CharacterSecretSchema>;

export const CharacterSchema = z.object({
  id: CharacterIdSchema,
  worldId: WorldIdSchema,
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).nullable().default(null),
  summary: z.string().trim().max(200).default(""),
  appearance: z.string().trim().max(1000).default(""),
  isActive: z.boolean().default(true),
  isAlive: z.boolean().default(true),
  /** Feeds responder scoring (docs/07 § 4). Uniformly high values flatten every scene. */
  talkativeness: z.number().min(0).max(1).default(0.5),
  profile: CharacterProfileSchema,
  goals: z.array(CharacterGoalSchema).max(10).default([]),
  secrets: z.array(CharacterSecretSchema).max(10).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

// ─── Relationships ────────────────────────────────────────────────────────────

/**
 * docs/06 § 4. Directional: `Elena → User` and `User → Elena` are separate rows
 * with separate values. Unrequited feeling is where the drama lives, and a
 * symmetric model cannot express it.
 */
export const RELATIONSHIP_DIMENSIONS = [
  "trust",
  "affection",
  "respect",
  "fear",
  "romance",
  "loyalty",
  "hostility",
  "familiarity",
] as const;

export type RelationshipDimension = (typeof RELATIONSHIP_DIMENSIONS)[number];

const bipolar = z.number().int().min(-100).max(100);

export const RelationshipSchema = z.object({
  worldId: WorldIdSchema,
  from: EntityRefSchema,
  to: EntityRefSchema,
  trust: bipolar.default(0),
  affection: bipolar.default(0),
  respect: bipolar.default(0),
  fear: bipolar.default(0),
  romance: bipolar.default(0),
  loyalty: bipolar.default(0),
  hostility: bipolar.default(0),
  /** Only monotonic dimension — familiarity never decays. */
  familiarity: z.number().int().min(0).max(100).default(0),
  statusLabel: z.string().max(60).nullable().default(null),
  lastInteractionAt: z.string().datetime().nullable().default(null),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/** Momentary, conversation-scoped. Deliberately not persisted — docs/06 § 6. */
export const EmotionalStateSchema = z.object({
  mood: z.enum([
    "calm",
    "anxious",
    "angry",
    "joyful",
    "grieving",
    "suspicious",
    "affectionate",
    "afraid",
  ]),
  intensity: z.number().min(0).max(1),
  cause: z.string().trim().max(200),
});
export type EmotionalState = z.infer<typeof EmotionalStateSchema>;
