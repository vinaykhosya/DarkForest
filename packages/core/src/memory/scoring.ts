import type { EntityRef, MemoryKind } from "@darkforest/contracts";
import {
  DEFAULT_RANKING_WEIGHTS,
  RECENCY_HALFLIFE_DAYS,
  type RankingWeights,
} from "./weights.js";
import { overlapCoefficient, tokenSet } from "./text.js";

/**
 * Composite memory ranking — docs/04-memory-engine.md § 6.
 *
 * Pure. No I/O, no clock, no randomness. Everything time-dependent arrives as
 * `currentWorldDay`, which is what makes long-horizon behaviour testable without
 * waiting a hundred days.
 */

export interface ScorableMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  subjects: readonly EntityRef[];
  worldDay: number | null;
  importance: number;
  isPinned: boolean;
  accessCount: number;
  /** 0..1. From RRF-normalised rank, or raw vector similarity in a single-path retrieval. */
  similarity: number;
  /** True when a linked memory (not this one) names the speaking character. */
  linkedToCharacter?: boolean;
}

export interface ScoringContext {
  currentWorldDay: number;
  /** null = narrator, which has world scope. */
  characterRef: EntityRef | null;
  /** Pre-tokenised once per turn, not per memory. */
  sceneTokens: ReadonlySet<string>;
  weights?: Partial<RankingWeights>;
}

export interface ScoredMemory {
  memory: ScorableMemory;
  score: number;
  /** Per-term contributions. Persisted in the retrieval trace — docs/04 § 12. */
  breakdown: Record<string, number>;
}

/**
 * Exponential decay over WORLD days, per kind.
 *
 * `world` memories have an infinite half-life and always return 1.
 * A memory with no day stamp is treated as timeless (1) rather than ancient (0) —
 * absent data should not be read as evidence of age.
 */
export function recencyScore(
  kind: MemoryKind,
  worldDay: number | null,
  currentWorldDay: number,
): number {
  const halflife = RECENCY_HALFLIFE_DAYS[kind];
  if (!Number.isFinite(halflife)) return 1;
  if (worldDay === null) return 1;
  const age = Math.max(0, currentWorldDay - worldDay);
  return Math.exp((-Math.LN2 * age) / halflife);
}

/**
 * Is this memory ABOUT the character who is speaking?
 *
 * 1.0  — the character is a subject
 * 0.5  — a linked memory names them
 * 0.1  — neither, but it may still be relevant world context
 * 1.0  — narrator, which is concerned with everything
 */
export function characterRelevance(
  memory: Pick<ScorableMemory, "subjects" | "linkedToCharacter">,
  characterRef: EntityRef | null,
): number {
  if (characterRef === null) return 1;
  if (memory.subjects.includes(characterRef)) return 1;
  if (memory.linkedToCharacter === true) return 0.5;
  return 0.1;
}

/** Entity overlap between the memory and the current scene. */
export function topicOverlap(content: string, sceneTokens: ReadonlySet<string>): number {
  if (sceneTokens.size === 0) return 0;
  return overlapCoefficient(tokenSet(content), sceneTokens);
}

/**
 * Log-scaled and saturating: a memory recalled ten times is load-bearing, but a
 * memory recalled a hundred times is not ten times more load-bearing than that.
 * Without saturation this term becomes a feedback loop that pins whatever surfaced
 * first and starves everything else.
 */
export function accessBoost(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return Math.min(1, Math.log2(1 + accessCount) / Math.log2(11));
}

export function scoreMemory(memory: ScorableMemory, ctx: ScoringContext): ScoredMemory {
  const w: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, ...ctx.weights };

  // Pinned memories bypass ranking entirely. They are the user's explicit
  // instruction, and the whole point of pinning is that it is not negotiable.
  if (memory.isPinned) {
    return {
      memory,
      score: w.pinned,
      breakdown: { pinned: w.pinned },
    };
  }

  const terms = {
    similarity: w.similarity * clamp01(memory.similarity),
    recency: w.recency * recencyScore(memory.kind, memory.worldDay, ctx.currentWorldDay),
    importance: w.importance * clamp01(memory.importance),
    characterRelevance: w.characterRelevance * characterRelevance(memory, ctx.characterRef),
    topicOverlap: w.topicOverlap * topicOverlap(memory.content, ctx.sceneTokens),
    accessBoost: w.accessBoost * accessBoost(memory.accessCount),
  };

  let score = 0;
  for (const value of Object.values(terms)) score += value;

  return { memory, score, breakdown: terms };
}

export function scoreAll(
  memories: readonly ScorableMemory[],
  ctx: ScoringContext,
): ScoredMemory[] {
  // Tokenise the scene once, not once per memory.
  return memories.map((m) => scoreMemory(m, ctx)).sort((a, b) => b.score - a.score);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
