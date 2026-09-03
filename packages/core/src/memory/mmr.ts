import { jaccard, tokenSet } from "./text.js";
import { MMR_DUPLICATE_THRESHOLD, MMR_LAMBDA } from "./weights.js";
import type { ScoredMemory } from "./scoring.js";

/**
 * Maximal Marginal Relevance — docs/04-memory-engine.md § 6.
 *
 * Without this, retrieval returns eight near-identical memories about one event
 * and the character sounds obsessive: every reply circles the same fact because
 * the same fact occupies every slot in the context.
 *
 *     next = argmax [ λ · relevance(m) − (1−λ) · max similarity(m, already_selected) ]
 *
 * Similarity here is lexical, not semantic — see text.ts for why (10 ms CPU budget,
 * and near-duplicates share vocabulary by definition).
 *
 * Pinned memories are exempt: the user asked for them explicitly, and silently
 * dropping one because it resembles another would be a broken promise.
 */

export interface MmrOptions {
  lambda?: number;
  limit: number;
  /**
   * Above this lexical similarity to an already-selected memory, a candidate is
   * excluded OUTRIGHT rather than merely penalised. See MMR_DUPLICATE_THRESHOLD
   * for why a soft penalty alone is not sufficient.
   */
  duplicateThreshold?: number;
  /** Pinned memories are selected first and never subjected to the diversity penalty. */
  isPinned?: (m: ScoredMemory) => boolean;
}

export function maximalMarginalRelevance(
  candidates: readonly ScoredMemory[],
  opts: MmrOptions,
): ScoredMemory[] {
  const lambda = opts.lambda ?? MMR_LAMBDA;
  const duplicateThreshold = opts.duplicateThreshold ?? MMR_DUPLICATE_THRESHOLD;
  const isPinned = opts.isPinned ?? ((m) => m.memory.isPinned);
  if (candidates.length === 0 || opts.limit <= 0) return [];

  // Tokenise once. Doing this inside the selection loop would make the whole
  // thing O(n²) in string length rather than in set size.
  const tokens = new Map<string, Set<string>>();
  for (const c of candidates) tokens.set(c.memory.id, tokenSet(c.memory.content));

  const selected: ScoredMemory[] = [];
  const remaining = new Set(candidates);

  // Pinned first, in score order, exempt from the diversity penalty.
  for (const c of [...remaining].filter(isPinned).sort((a, b) => b.score - a.score)) {
    if (selected.length >= opts.limit) break;
    selected.push(c);
    remaining.delete(c);
  }

  const maxScore = Math.max(...candidates.map((c) => c.score), 1e-9);

  while (selected.length < opts.limit && remaining.size > 0) {
    let best: ScoredMemory | null = null;
    let bestValue = Number.NEGATIVE_INFINITY;
    const nearDuplicates: ScoredMemory[] = [];

    for (const candidate of remaining) {
      const candidateTokens = tokens.get(candidate.memory.id);
      if (candidateTokens === undefined) continue;

      let maxSimilarity = 0;
      for (const chosen of selected) {
        const chosenTokens = tokens.get(chosen.memory.id);
        if (chosenTokens === undefined) continue;
        const sim = jaccard(candidateTokens, chosenTokens);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }

      // Hard cutoff: a restatement of something already selected never earns a
      // context slot, however relevant it looks in isolation.
      if (maxSimilarity >= duplicateThreshold) {
        nearDuplicates.push(candidate);
        continue;
      }

      // Relevance is normalised so λ balances two 0..1 quantities. Comparing a raw
      // composite score against a 0..1 similarity would make λ meaningless.
      const relevance = candidate.score / maxScore;
      const value = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (value > bestValue) {
        bestValue = value;
        best = candidate;
      }
    }

    // Drop the excluded duplicates so they are not reconsidered on the next pass.
    for (const dup of nearDuplicates) remaining.delete(dup);

    if (best === null) break;
    selected.push(best);
    remaining.delete(best);
  }

  return selected;
}
