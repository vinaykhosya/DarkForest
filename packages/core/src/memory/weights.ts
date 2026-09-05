import type { MemoryKind } from "@darkforest/contracts";

/**
 * Ranking weights — docs/04-memory-engine.md § 6.
 *
 * These are HYPOTHESES, not settings. Every change must be justified by a measured
 * improvement on eval suites 1 and 2 (docs/15 § 3), and the version below must be
 * bumped so a regression can be bisected.
 *
 * They live in a named, versioned module rather than inline constants precisely so
 * that "who changed the ranking and why" is always answerable.
 */

export const RANKING_WEIGHTS_VERSION = 2;

export interface RankingWeights {
  /** Necessary but not sufficient — pure vector search retrieves plausible irrelevance. */
  similarity: number;
  recency: number;
  importance: number;
  /** Is this memory ABOUT the character who is speaking. */
  characterRelevance: number;
  /** Entity overlap between the memory and the current scene. */
  topicOverlap: number;
  /** Frequently-recalled memories are load-bearing for the story. */
  accessBoost: number;
  /** Pinned memories bypass ranking entirely; this is their score floor. */
  pinned: number;
  /** Penalty against memories already selected. Prevents an obsessive-sounding character. */
  redundancy: number;
}

/**
 * Version 2 — relevance to the QUESTION dominates; everything else is a
 * tie-break among memories that are already relevant.
 *
 * MEASURED, Suite 1, 2026-09-05. Version 1 failed the gate at 67.4% median and
 * recall degraded monotonically as the store grew (78% at 10-19 memories, 33%
 * at 50-59). Instrumenting the retrieval funnel showed why:
 *
 *   42 of 47 failures  lost on score   (the memory WAS a candidate, and lost)
 *    3                 evicted by MMR
 *    2                 never extracted
 *
 * and the memories that displaced the correct answer drew their score from:
 *
 *   recency             24%  }
 *   importance          23%  }  query-INDEPENDENT  74%
 *   characterRelevance  18%  }
 *   accessBoost          9%  }
 *   similarity          20%  }  query-dependent    26%
 *   topicOverlap         6%  }
 *
 * A retrieval ranker in which three quarters of the winning score is unrelated
 * to the question is not ranking, it is sorting. It works while the store is
 * small enough that everything relevant fits in the context anyway, and fails
 * exactly when retrieval starts to matter — which is the failure we measured.
 *
 * So the split is inverted to roughly 70/30 in favour of query relevance.
 * Importance, recency and character-relevance remain real signals: given two
 * memories that both answer the question, prefer the important, recent one
 * about this character. They are tie-breakers, and version 1 had them deciding.
 *
 * characterRelevance drops furthest on purpose. Knowledge isolation is already
 * enforced as a WHERE clause in the store (docs/04 § 5), so every candidate is
 * one this character may recall. Weighting it heavily again in scoring
 * double-counts a constraint that has already been applied.
 */
export const DEFAULT_RANKING_WEIGHTS: Readonly<RankingWeights> = Object.freeze({
  similarity: 0.55,
  topicOverlap: 0.15,
  importance: 0.12,
  recency: 0.08,
  characterRelevance: 0.07,
  accessBoost: 0.03,
  pinned: 1.0,
  redundancy: 0.25,
});

/**
 * Recency half-lives, in WORLD days rather than wall-clock days.
 *
 * A world played intensely over one weekend may cover 200 in-world days; its
 * memories should age accordingly. Using wall-clock time here would make a
 * fast-moving campaign feel like it never forgets anything.
 *
 * `world` memories never decay — the king staying dead is not negotiable.
 */
export const RECENCY_HALFLIFE_DAYS: Readonly<Record<MemoryKind, number>> = Object.freeze({
  episodic: 30,
  semantic: 365,
  relational: 90,
  world: Number.POSITIVE_INFINITY,
  persona: 180,
  reflection: 180,
});

/** Prior contribution of each kind to the deterministic importance adjustment. docs/04 § 4. */
export const KIND_IMPORTANCE_PRIOR: Readonly<Record<MemoryKind, number>> = Object.freeze({
  episodic: 0.5,
  semantic: 0.6,
  relational: 0.6,
  world: 0.85,
  persona: 0.5,
  reflection: 0.7,
});

/** MMR trade-off. Higher favours relevance; lower favours diversity. docs/04 § 6. */
export const MMR_LAMBDA = 0.7;

/**
 * Hard near-duplicate cutoff for MMR, as lexical Jaccard.
 *
 * A soft penalty alone does not stop restatements. Measured: two phrasings of the
 * same fact ("The user owns Ravenblade, a legendary sword." / "Ravenblade, a
 * legendary sword, belongs to the user.") score 0.667. At λ = 0.7 the resulting
 * penalty (0.30 × 0.667 = 0.20) is smaller than the relevance gap between a
 * near-duplicate and the next distinct memory, so both survive and one context
 * slot is wasted saying the same thing twice.
 *
 * So above this threshold a candidate is excluded outright rather than penalised.
 * The property this buys is stateable and testable: two memories that are ≥60%
 * lexically identical never both enter the same context.
 *
 * Calibration check — these must stay BELOW the threshold, and do:
 *   "user promised Elena he would return before sunset"
 *   "user promised Marcus he would return before dawn"      → 0.50
 * Distinct facts that merely share a subject score lower still.
 *
 * MMR is the second line of defence. The first is anti-duplication at write time
 * (DEDUPE.merge) and consolidation; this catches what those miss.
 */
export const MMR_DUPLICATE_THRESHOLD = 0.6;

/** Reciprocal-rank-fusion constant. 60 is the standard from the IR literature. */
export const RRF_K = 60;

/** docs/04 § 7 — beyond ~20 memories the model averages across them instead of using them. */
export const MEMORY_COUNT_TARGET = { min: 8, max: 15, hardCap: 20 } as const;

/** Anti-duplication thresholds at write time. docs/04 § 4. */
export const DEDUPE = { merge: 0.92, link: 0.85, consolidate: 0.88 } as const;
