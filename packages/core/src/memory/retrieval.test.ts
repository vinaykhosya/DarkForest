import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type RankedList } from "./fusion.js";
import { maximalMarginalRelevance } from "./mmr.js";
import { packMemories } from "./budget.js";
import { MMR_DUPLICATE_THRESHOLD } from "./weights.js";
import type { ScoredMemory } from "./scoring.js";
import { estimateTokens, jaccard, overlapCoefficient, tokenize, tokenSet } from "./text.js";

// ─── text ─────────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("strips punctuation, lowercases and drops stopwords", () => {
    expect(tokenize("The user OWNS Ravenblade, a legendary sword!")).toEqual([
      "user",
      "owns",
      "ravenblade",
      "legendary",
      "sword",
    ]);
  });

  it("handles non-ASCII letters", () => {
    expect(tokenize("Renée met Zoë in Köln")).toEqual(["renée", "met", "zoë", "köln"]);
  });

  it("returns an empty array for punctuation only", () => {
    expect(tokenize("!!! ... ???")).toEqual([]);
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets", () => {
    expect(jaccard(tokenSet("the user owns Ravenblade"), tokenSet("user owns Ravenblade"))).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccard(tokenSet("dragons fly"), tokenSet("politics collapsed"))).toBe(0);
  });

  it("is 0 rather than NaN when a set is empty", () => {
    expect(jaccard(new Set(), tokenSet("anything"))).toBe(0);
  });

  it("scores restatements of the same fact above the duplicate threshold", () => {
    // The property MMR depends on. Measured at 0.667 — recorded here so a change
    // to the stopword list or tokeniser that moves it shows up as a failure.
    const a = tokenSet("The user owns Ravenblade, a legendary sword.");
    const b = tokenSet("Ravenblade, a legendary sword, belongs to the user.");
    expect(jaccard(a, b)).toBeCloseTo(0.667, 2);
    expect(jaccard(a, b)).toBeGreaterThan(MMR_DUPLICATE_THRESHOLD);
  });

  it("keeps genuinely distinct facts below the duplicate threshold", () => {
    // Calibration guard: same structure, same subject, different content.
    // If tokenisation changes push this above the threshold, real memories start
    // being silently dropped — which is much worse than an occasional duplicate.
    const a = tokenSet("The user promised Elena he would return before sunset.");
    const b = tokenSet("The user promised Marcus he would return before dawn.");
    expect(jaccard(a, b)).toBeLessThan(MMR_DUPLICATE_THRESHOLD);
  });
});

describe("overlapCoefficient", () => {
  it("does not penalise a short memory contained in a long scene", () => {
    const short = tokenSet("Elena distrusts the king");
    const long = tokenSet(
      "Elena distrusts the king and has said so openly in the great hall before many witnesses",
    );
    expect(overlapCoefficient(short, long)).toBe(1);
    expect(jaccard(short, long)).toBeLessThan(1); // which is why we use overlap here
  });
});

describe("estimateTokens", () => {
  it("over-estimates rather than under-estimates", () => {
    // Under-estimating causes truncation mid-generation; over-estimating wastes a little budget.
    const text = "a".repeat(360);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(100);
  });
});

// ─── fusion ───────────────────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  const id = (s: string): string => s;

  it("ranks an item found by two paths above one that tops a single path", () => {
    const lists: RankedList<string>[] = [
      { path: "vector", items: ["both", "vector-only"] },
      { path: "keyword", items: ["keyword-only", "both"] },
    ];
    const fused = reciprocalRankFusion(lists, id);
    expect(fused[0]?.item).toBe("both");
  });

  it("records every path an item was found through", () => {
    const fused = reciprocalRankFusion(
      [
        { path: "vector", items: ["m1"] },
        { path: "keyword", items: ["m1"] },
      ],
      id,
    );
    expect(fused[0]?.paths.sort()).toEqual(["keyword", "vector"]);
    expect(fused[0]?.ranks).toEqual({ vector: 1, keyword: 1 });
  });

  it("gives the top fused item a rankScore of 1", () => {
    const fused = reciprocalRankFusion(
      [
        { path: "vector", items: ["m1"] },
        { path: "keyword", items: ["m1"] },
      ],
      id,
    );
    expect(fused[0]?.rankScore).toBeCloseTo(1, 6);
  });

  it("spreads rankScore widely enough to actually discriminate", () => {
    // The bug this guards against: a linear normalisation of raw RRF scores put
    // rank 4 at 0.95, so the similarity term became a near-constant and the
    // ranking formula silently lost its most heavily weighted input.
    const items = Array.from({ length: 40 }, (_, i) => `m${String(i)}`);
    const fused = reciprocalRankFusion([{ path: "vector", items }], id);
    expect(fused[0]?.rankScore).toBeCloseTo(1, 6);
    expect(fused[9]?.rankScore).toBeLessThan(0.5);
    expect(fused[39]?.rankScore).toBeLessThan(0.05);
  });

  it("decreases rankScore monotonically", () => {
    const items = Array.from({ length: 15 }, (_, i) => `m${String(i)}`);
    const fused = reciprocalRankFusion([{ path: "vector", items }], id);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i]!.rankScore).toBeLessThan(fused[i - 1]!.rankScore);
    }
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([], id)).toEqual([]);
    expect(reciprocalRankFusion([{ path: "vector", items: [] }], id)).toEqual([]);
  });

  it("respects per-path weights", () => {
    const fused = reciprocalRankFusion(
      [
        { path: "vector", items: ["trusted"], weight: 5 },
        { path: "keyword", items: ["untrusted"], weight: 1 },
      ],
      id,
    );
    expect(fused[0]?.item).toBe("trusted");
  });
});

// ─── MMR ──────────────────────────────────────────────────────────────────────

function scored(id: string, content: string, score: number, isPinned = false): ScoredMemory {
  return {
    memory: {
      id,
      kind: "episodic",
      content,
      subjects: [],
      worldDay: 1,
      importance: 0.5,
      isPinned,
      accessCount: 0,
      similarity: score,
    },
    score,
    breakdown: {},
  };
}

describe("maximalMarginalRelevance", () => {
  it("excludes a near-duplicate outright, even when it outranks the alternative", () => {
    // "b" restates "a" and scores higher than "c". A soft penalty is not enough:
    // 0.3 × 0.667 = 0.20 is less than the relevance gap, so "b" would win.
    const candidates = [
      scored("a", "The user owns Ravenblade, a legendary sword.", 0.9),
      scored("b", "Ravenblade, a legendary sword, belongs to the user.", 0.88),
      scored("c", "The northern kingdom declared war on Ravenhold.", 0.6),
    ];
    const picked = maximalMarginalRelevance(candidates, { limit: 2 });
    expect(picked.map((p) => p.memory.id)).toEqual(["a", "c"]);
  });

  it("never reconsiders an excluded duplicate on a later pass", () => {
    const candidates = [
      scored("a", "The user owns Ravenblade, a legendary sword.", 0.9),
      scored("b", "Ravenblade, a legendary sword, belongs to the user.", 0.88),
      scored("c", "The northern kingdom declared war on Ravenhold.", 0.6),
      scored("d", "Marcus keeps a knife hidden beneath his cloak.", 0.5),
    ];
    const picked = maximalMarginalRelevance(candidates, { limit: 4 });
    expect(picked.map((p) => p.memory.id)).toEqual(["a", "c", "d"]);
    expect(picked).toHaveLength(3); // fewer than the limit — correctly, not a bug
  });

  it("keeps distinct memories that merely share a subject", () => {
    const candidates = [
      scored("a", "The user promised Elena he would return before sunset.", 0.9),
      scored("b", "The user promised Marcus he would return before dawn.", 0.85),
    ];
    const picked = maximalMarginalRelevance(candidates, { limit: 2 });
    expect(picked).toHaveLength(2);
  });

  it("selects pinned memories first and exempts them from the diversity penalty", () => {
    const candidates = [
      scored("pin1", "The user promised Elena he would return.", 0.1, true),
      scored("pin2", "The user promised Elena he would come back.", 0.1, true),
      scored("hot", "Marcus was seen near the gate at midnight.", 0.99),
    ];
    const picked = maximalMarginalRelevance(candidates, { limit: 3 });
    expect(picked.slice(0, 2).map((p) => p.memory.id).sort()).toEqual(["pin1", "pin2"]);
  });

  it("respects the limit", () => {
    // Genuinely varied content. An earlier version of this fixture used
    // `Distinct fact number ${i} about the kingdom` — which shares 4 of 5 content
    // words between iterations (Jaccard 0.667) and was correctly excluded as
    // duplicate. Worth knowing: the cutoff bites hard on templated text.
    const subjects = [
      "Elena hid a letter beneath the floorboards.",
      "Marcus sold his horse to a merchant from the south.",
      "The granary burned during the third night of the siege.",
      "A stranger asked about the old road to Ravenhold.",
      "The queen's physician resigned without explanation.",
      "Frost killed most of the orchard this year.",
      "Someone has been leaving bread at the shrine.",
      "The river crossing washed out after heavy rain.",
    ];
    const candidates = subjects.map((content, i) => scored(`m${String(i)}`, content, 0.5));
    expect(maximalMarginalRelevance(candidates, { limit: 5 })).toHaveLength(5);
  });

  it("returns fewer than the limit rather than padding with duplicates", () => {
    // A caller asking for 8 memories when only 2 distinct ones exist gets 2.
    // Silently padding with restatements would waste context and sound obsessive.
    const candidates = [
      scored("a", "The user owns Ravenblade, a legendary sword.", 0.9),
      scored("b", "Ravenblade, a legendary sword, belongs to the user.", 0.88),
      scored("c", "Ravenblade — a legendary sword — is owned by the user.", 0.87),
      scored("d", "Marcus keeps a knife hidden beneath his cloak.", 0.5),
    ];
    const picked = maximalMarginalRelevance(candidates, { limit: 8 });
    expect(picked.map((p) => p.memory.id)).toEqual(["a", "d"]);
  });

  it("returns everything when the limit exceeds the candidate count", () => {
    const candidates = [scored("a", "One fact.", 0.5), scored("b", "Another entirely.", 0.4)];
    expect(maximalMarginalRelevance(candidates, { limit: 10 })).toHaveLength(2);
  });

  it("handles empty input and a zero limit", () => {
    expect(maximalMarginalRelevance([], { limit: 5 })).toEqual([]);
    expect(maximalMarginalRelevance([scored("a", "x y z", 1)], { limit: 0 })).toEqual([]);
  });

  it("with lambda = 1 and the cutoff disabled, ranks purely by relevance", () => {
    const candidates = [
      scored("a", "The user owns Ravenblade, a legendary sword.", 0.9),
      scored("b", "Ravenblade, a legendary sword, belongs to the user.", 0.85),
      scored("c", "War was declared.", 0.1),
    ];
    const picked = maximalMarginalRelevance(candidates, {
      limit: 2,
      lambda: 1,
      duplicateThreshold: 1.1, // above any achievable Jaccard, so nothing is excluded
    });
    expect(picked.map((p) => p.memory.id)).toEqual(["a", "b"]);
  });
});

// ─── budget packing ───────────────────────────────────────────────────────────

describe("packMemories", () => {
  it("never exceeds the token budget", () => {
    const ranked = Array.from({ length: 50 }, (_, i) =>
      scored(`m${String(i)}`, "A memory of roughly forty characters.", 0.5),
    );
    const packed = packMemories(ranked, { tokenBudget: 100 });
    expect(packed.tokensUsed).toBeLessThanOrEqual(100);
  });

  it("drops memories whole — never a partial sentence", () => {
    const ranked = [
      scored("a", "A short fact.", 0.9),
      scored("b", "A considerably longer memory that will not fit in the remaining budget.", 0.8),
    ];
    const packed = packMemories(ranked, { tokenBudget: 15 });
    for (const s of packed.selected) {
      expect(s.memory.content).toMatch(/\.$/); // still a complete sentence
    }
  });

  it("flags pinned overflow rather than silently discarding a user instruction", () => {
    const ranked = Array.from({ length: 10 }, (_, i) =>
      scored(`p${String(i)}`, "A pinned memory that the user explicitly asked for.", 0.5, true),
    );
    const packed = packMemories(ranked, { tokenBudget: 40, pinnedShare: 0.3 });
    expect(packed.pinnedOverflow).toBe(true);
    expect(packed.dropped.length).toBeGreaterThan(0);
  });

  it("lets ranked memories use budget the pins did not claim", () => {
    const ranked = [
      scored("pin", "One pinned fact.", 0.5, true),
      scored("a", "An ordinary fact.", 0.9),
      scored("b", "Another ordinary fact.", 0.8),
    ];
    const packed = packMemories(ranked, { tokenBudget: 200, pinnedShare: 0.3 });
    expect(packed.selected).toHaveLength(3);
  });

  it("respects maxCount independently of the token budget", () => {
    const ranked = Array.from({ length: 30 }, (_, i) =>
      scored(`m${String(i)}`, "Short.", 0.5),
    );
    const packed = packMemories(ranked, { tokenBudget: 100_000, maxCount: 12 });
    expect(packed.selected).toHaveLength(12);
    expect(packed.dropped).toHaveLength(18);
  });

  it("accounts for per-item formatting overhead", () => {
    const ranked = [scored("a", "Tiny.", 0.9)];
    const withOverhead = packMemories(ranked, { tokenBudget: 1000, perItemOverhead: 50 });
    expect(withOverhead.tokensUsed).toBeGreaterThan(estimateTokens("Tiny."));
  });
});
