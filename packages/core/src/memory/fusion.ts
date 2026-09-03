import { RRF_K } from "./weights.js";

/**
 * Reciprocal Rank Fusion — docs/04-memory-engine.md § 5.
 *
 * Retrieval runs three paths (vector, keyword, structural) that produce scores on
 * incomparable scales: a cosine distance and a BM25 rank cannot be added together
 * meaningfully. RRF sidesteps the problem by discarding the scores and fusing on
 * RANK alone:
 *
 *     score(d) = Σ_lists 1 / (k + rank_in_that_list)
 *
 * A document ranked well in two lists beats one ranked brilliantly in a single
 * list — which is exactly the behaviour we want. A memory found by both semantic
 * similarity AND exact name match is almost always the right one.
 *
 * k = 60 is the standard from the IR literature; it damps the influence of the
 * very top ranks enough that a single list cannot dominate the fusion.
 */

export type RetrievalPath = "vector" | "keyword" | "pinned" | "recent" | "subject";

export interface RankedList<T> {
  path: RetrievalPath;
  /** Ordered best-first. Position in the array IS the rank. */
  items: readonly T[];
  /** Optional per-path multiplier, for when one path is known to be more trustworthy. */
  weight?: number;
}

/**
 * How quickly `rankScore` decays with fused rank. τ = 10 puts rank 1 at 1.00,
 * rank 5 at 0.67, rank 10 at 0.41 and rank 40 at 0.02 — a spread wide enough to
 * actually discriminate when fed into the ranking formula.
 */
const RANK_DECAY_TAU = 10;

export interface FusedItem<T> {
  item: T;
  /** Raw RRF score. Meaningful only relative to other items in the SAME fusion. */
  fusedScore: number;
  /**
   * 0..1 position signal, used as the `similarity` term in ranking.
   *
   * IMPORTANT: this expresses *rank within this result set*, not absolute match
   * quality. RRF discards the underlying scores by construction, so absolute
   * quality is not recoverable here — a query where every candidate is poor still
   * yields a rank-1 item at 1.0. Callers needing true semantic similarity should
   * carry the raw vector distance through separately.
   *
   * A linear normalisation against the theoretical maximum was tried first and is
   * wrong: with k = 60, ranks 1 and 4 differ by under 5%, so everything normalised
   * to ~0.95 and the similarity term stopped discriminating entirely.
   */
  rankScore: number;
  paths: RetrievalPath[];
  ranks: Partial<Record<RetrievalPath, number>>;
}

export function reciprocalRankFusion<T>(
  lists: readonly RankedList<T>[],
  identify: (item: T) => string,
  k: number = RRF_K,
): FusedItem<T>[] {
  const acc = new Map<
    string,
    { item: T; score: number; paths: RetrievalPath[]; ranks: Partial<Record<RetrievalPath, number>> }
  >();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      if (item === undefined) continue;
      const id = identify(item);
      const rank = i + 1;
      const contribution = weight / (k + rank);

      const existing = acc.get(id);
      if (existing) {
        existing.score += contribution;
        existing.paths.push(list.path);
        existing.ranks[list.path] = rank;
      } else {
        acc.set(id, {
          item,
          score: contribution,
          paths: [list.path],
          ranks: { [list.path]: rank },
        });
      }
    }
  }

  const fused = [...acc.values()].sort((a, b) => b.score - a.score);

  return fused.map((entry, index) => ({
    item: entry.item,
    fusedScore: entry.score,
    rankScore: Math.exp(-index / RANK_DECAY_TAU),
    paths: entry.paths,
    ranks: entry.ranks,
  }));
}
