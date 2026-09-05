import type { EmbeddingProvider } from "@darkforest/contracts";
import type {
  CharacterId,
  EntityRef,
  MemoryId,
  RetrievalTrace,
  WorldId,
} from "@darkforest/contracts";
import {
  MEMORY_COUNT_TARGET,
  packMemories,
  reciprocalRankFusion,
  maximalMarginalRelevance,
  scoreAll,
  tokenSet,
  type RankedList,
  type RankingWeights,
  type ScorableMemory,
  type ScoredMemory,
} from "@darkforest/core";
import type { MemoryCandidate, MemoryStore } from "./store.js";

/**
 * The retrieval pipeline — docs/04-memory-engine.md § 5.
 *
 *   query construction → three parallel paths → RRF fusion
 *   → composite ranking → MMR → token-budget packing
 *
 * Knowledge isolation is NOT performed here. It happens inside the store, as
 * part of each query (see store.ts). This module never sees a memory the
 * character may not recall, which is the only arrangement that cannot be
 * accidentally bypassed.
 */

export interface RetrievalInput {
  worldId: WorldId;
  /** null = narrator, which has world scope. */
  characterId: CharacterId | null;
  userMessage: string;
  /** Last couple of character lines, to widen the query beyond the bare message. */
  recentLines?: readonly string[];
  sceneSummary?: string;
  /** Character and location names for this world — the highest-signal query terms. */
  aliases?: readonly string[];
  subjects?: readonly EntityRef[];
  currentWorldDay: number;
  tokenBudget: number;
  candidatePoolSize?: number;
  maxMemories?: number;
  weights?: Partial<RankingWeights>;
  /**
   * Diagnostic only. When supplied, the pipeline records where the memory
   * matching this predicate was lost. Off in production: the cost is a
   * predicate call per candidate per stage.
   */
  traceMatch?: (content: string) => boolean;
}

/**
 * Where a specific memory was lost between the store and the final context.
 *
 * Exists because "not retrieved" was, for three benchmark generations, a single
 * undifferentiated failure. The 3-rep gate produced 46 stored-but-not-retrieved
 * probes against 5 never-stored ones, and no way to say whether the memory never
 * became a candidate, lost on score, was evicted as a near-duplicate, or fell
 * off the end of the top-K. Those have four different fixes.
 */
export type FunnelStage =
  | "not_a_candidate"
  | "lost_on_score"
  | "evicted_by_mmr"
  | "dropped_for_budget"
  | "retrieved";

export interface RetrievalFunnel {
  /** False when nothing in the candidate pool matched — see `stage`. */
  found: boolean;
  stage: FunnelStage;
  /** Rank within each generator, or null when that path missed it entirely. */
  vectorRank: number | null;
  keywordRank: number | null;
  structuralRank: number | null;
  fusedRank: number | null;
  /** Rank by composite score, BEFORE MMR and budget packing. */
  scoreRank: number | null;
  score: number | null;
  breakdown: Record<string, number> | null;
  finalRank: number | null;
  candidateCount: number;
  /** Memories that outscored it, nearest first. Names what actually won. */
  beatenBy: Array<{ score: number; breakdown: Record<string, number>; content: string }>;
}

export interface RetrievalOutput {
  memories: ScoredMemory[];
  trace: RetrievalTrace;
  /** True when embeddings lagged and the vector path contributed nothing. */
  degraded: boolean;
  /** Present only when `traceMatch` was supplied. */
  funnel?: RetrievalFunnel;
}

/**
 * Words too common to tell one memory from another. Small on purpose: this
 * decides only whether a message can stand as its own query.
 */
const STOPWORDS = new Set([
  "the", "and", "but", "for", "you", "your", "our", "her", "his", "its", "was",
  "were", "are", "did", "does", "have", "has", "had", "what", "who", "whom",
  "when", "where", "why", "how", "that", "this", "these", "those", "with",
  "from", "into", "about", "there", "then", "than", "them", "they",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Below this, a message cannot retrieve on its own and must be widened.
 *
 * Two, not three. "What did I promise Odell?" reduces to {promise, odell} — a
 * perfectly specific query that a threshold of three would have widened and
 * ruined. Reply-shaped turns are the ones that need help and they score zero:
 * "yes", "ok", "and then what", "he did" all reduce to nothing.
 */
const SELF_SUFFICIENT_QUERY_WORDS = 2;

/**
 * Builds the retrieval query.
 *
 * TWO queries, deliberately, because the two search paths fail in opposite ways.
 *
 * `text` is widened with recent lines and the scene, because a reply of "yes"
 * retrieves nothing on its own. Extra terms cost a keyword search almost
 * nothing: it matches terms independently, so widening adds recall.
 *
 * `vectorText` is NOT widened when the message can stand alone. An embedding is
 * a single averaged point, so appending two lines of narrative prose to a short
 * question moves that point away from the question and towards whatever was
 * recently said. The retrieved set then reflects the recent topic instead of the
 * thing being asked.
 *
 * MEASURED 2026-09-05, Suite 1. Probing the SAME 38-memory store:
 *   mid-session (recentLines populated)   3/19 recalled
 *   fresh session (recentLines empty)     4/5  recalled
 * 31 of 43 failed probes were stored-but-not-retrieved, and when a fact did
 * surface it ranked first — so the memory was not being ranked poorly, it was
 * missing from the candidate set entirely. Widening the vector query was the
 * whole gap.
 *
 * Entity extraction is regex against a per-world alias list, not an LLM call —
 * names are the highest-signal retrieval term and exact matching finds them
 * better than embeddings do (docs/04 § 5, docs/01 § P4).
 */
export function buildQuery(input: RetrievalInput): {
  text: string;
  vectorText: string;
  entities: string[];
} {
  const parts = [input.userMessage, ...(input.recentLines ?? []).slice(-2)];
  if (input.sceneSummary !== undefined && input.sceneSummary.length > 0) {
    parts.push(input.sceneSummary);
  }

  const haystack = parts.join(" ").toLowerCase();
  const entities = (input.aliases ?? []).filter((alias) =>
    haystack.includes(alias.toLowerCase()),
  );

  const widened = [...parts, ...entities].join(" ");
  // Entities stay on the vector query even when narrow: a name is the strongest
  // signal available and costs one token, unlike a paragraph of prose.
  const standalone = [input.userMessage, ...entities].join(" ");
  const selfSufficient = contentWords(input.userMessage).length >= SELF_SUFFICIENT_QUERY_WORDS;

  return { text: widened, vectorText: selfSufficient ? standalone : widened, entities };
}

export async function retrieve(
  store: MemoryStore,
  embedder: EmbeddingProvider,
  input: RetrievalInput,
): Promise<RetrievalOutput> {
  const startedAt = Date.now();
  const poolSize = input.candidatePoolSize ?? 40;
  const maxMemories = input.maxMemories ?? MEMORY_COUNT_TARGET.max;

  const query = buildQuery(input);

  // ── the three paths ───────────────────────────────────────────────────────
  // Vector search may legitimately return nothing when embeddings lag behind
  // extraction. That is a degradation, not an error.
  let vectorResults: MemoryCandidate[] = [];
  try {
    const [queryVector] = await embedder.embed([query.vectorText]);
    if (queryVector) {
      vectorResults = await store.vectorSearch(
        input.worldId,
        input.characterId,
        queryVector,
        poolSize,
      );
    }
  } catch {
    // Embedding provider unavailable — fall through on keyword + structural.
    vectorResults = [];
  }

  const [keywordResults, structuralResults] = await Promise.all([
    store.keywordSearch(input.worldId, input.characterId, query.text, poolSize),
    store.structuralSearch(input.worldId, input.characterId, {
      includePinned: true,
      recentCount: 5,
      subjects: input.subjects ?? [],
    }),
  ]);

  const degraded = vectorResults.length === 0;

  // ── fusion ────────────────────────────────────────────────────────────────
  const byId = new Map<string, MemoryCandidate>();
  for (const list of [vectorResults, keywordResults, structuralResults]) {
    for (const candidate of list) byId.set(candidate.memory.id, candidate);
  }

  const allLists: RankedList<string>[] = [
    { path: "vector", items: vectorResults.map((c) => c.memory.id) },
    { path: "keyword", items: keywordResults.map((c) => c.memory.id) },
    { path: "recent", items: structuralResults.map((c) => c.memory.id) },
  ];
  // An empty list would still contribute a denominator to fusion, so drop it.
  const lists = allLists.filter((l) => l.items.length > 0);

  const fused = reciprocalRankFusion(lists, (id) => id);

  // ── ranking ───────────────────────────────────────────────────────────────
  const sceneTokens = tokenSet([input.sceneSummary ?? "", ...query.entities].join(" "));
  // EntityRef is a runtime-validated string (regex refinement in contracts), not
  // a compile-time brand — so no assertion is needed or meaningful here.
  const characterRef: EntityRef | null =
    input.characterId === null ? null : `character:${input.characterId}`;

  const scorable: ScorableMemory[] = [];
  for (const entry of fused) {
    const candidate = byId.get(entry.item);
    if (!candidate) continue;
    const m = candidate.memory;
    scorable.push({
      id: m.id,
      kind: m.kind,
      content: m.content,
      subjects: m.subjects,
      worldDay: m.worldDay,
      importance: m.importance,
      isPinned: m.isPinned,
      accessCount: m.accessCount,
      similarity: entry.rankScore,
    });
  }

  const ranked = scoreAll(scorable, {
    currentWorldDay: input.currentWorldDay,
    characterRef,
    sceneTokens,
    ...(input.weights === undefined ? {} : { weights: input.weights }),
  });

  // ── diversify, then pack ──────────────────────────────────────────────────
  const diversified = maximalMarginalRelevance(ranked, { limit: maxMemories });
  const packed = packMemories(diversified, {
    tokenBudget: input.tokenBudget,
    maxCount: maxMemories,
  });

  // Access counts feed the accessBoost term — frequently-recalled memories are
  // load-bearing for the story (docs/04 § 6).
  // `ScorableMemory.id` is a plain string — packages/core is deliberately free of
  // branded id types so it stays a pure algorithms package. This is the single
  // boundary where the brand is reapplied, and the ids provably came from the
  // store, so the assertion is safe rather than convenient.
  const selectedIds = packed.selected.map((s) => s.memory.id as MemoryId);
  await store.recordAccess(selectedIds);

  const funnel =
    input.traceMatch === undefined
      ? undefined
      : buildFunnel(input.traceMatch, {
          vectorResults,
          keywordResults,
          structuralResults,
          fused: fused.map((f) => f.item),
          byId,
          ranked,
          diversified,
          selected: packed.selected,
        });

  const trace: RetrievalTrace = {
    queryText: query.text,
    characterId: input.characterId,
    candidateCount: fused.length,
    selected: packed.selected.map((s) => ({
      memoryId: s.memory.id as never,
      score: s.score,
      breakdown: s.breakdown,
    })),
    droppedForBudget: packed.dropped.map((s) => s.memory.id as never),
    tokensUsed: packed.tokensUsed,
    durationMs: Date.now() - startedAt,
  };

  return {
    memories: packed.selected,
    trace,
    degraded,
    ...(funnel === undefined ? {} : { funnel }),
  };
}

/** Rank of the first match in a candidate list, or null. */
function rankIn(
  list: readonly MemoryCandidate[],
  match: (content: string) => boolean,
): number | null {
  const i = list.findIndex((c) => match(c.memory.content));
  return i >= 0 ? i : null;
}

function buildFunnel(
  match: (content: string) => boolean,
  s: {
    vectorResults: readonly MemoryCandidate[];
    keywordResults: readonly MemoryCandidate[];
    structuralResults: readonly MemoryCandidate[];
    fused: readonly string[];
    byId: ReadonlyMap<string, MemoryCandidate>;
    ranked: readonly ScoredMemory[];
    diversified: readonly ScoredMemory[];
    selected: readonly ScoredMemory[];
  },
): RetrievalFunnel {
  const vectorRank = rankIn(s.vectorResults, match);
  const keywordRank = rankIn(s.keywordResults, match);
  const structuralRank = rankIn(s.structuralResults, match);

  const fusedIdx = s.fused.findIndex((id) => {
    const c = s.byId.get(id);
    return c !== undefined && match(c.memory.content);
  });
  const scoreIdx = s.ranked.findIndex((r) => match(r.memory.content));
  const finalIdx = s.selected.findIndex((r) => match(r.memory.content));
  const inDiversified = s.diversified.some((r) => match(r.memory.content));

  const hit = scoreIdx >= 0 ? s.ranked[scoreIdx] : undefined;

  // Ordered so the FIRST stage that lost it is the one reported. A memory that
  // never became a candidate cannot also be "lost on score".
  const stage: FunnelStage =
    finalIdx >= 0
      ? "retrieved"
      : scoreIdx < 0
        ? "not_a_candidate"
        : inDiversified
          ? "dropped_for_budget"
          : scoreIdx < s.diversified.length
            ? "evicted_by_mmr"
            : "lost_on_score";

  return {
    found: scoreIdx >= 0,
    stage,
    vectorRank,
    keywordRank,
    structuralRank,
    fusedRank: fusedIdx >= 0 ? fusedIdx : null,
    scoreRank: scoreIdx >= 0 ? scoreIdx : null,
    score: hit?.score ?? null,
    breakdown: hit?.breakdown ?? null,
    finalRank: finalIdx >= 0 ? finalIdx : null,
    candidateCount: s.ranked.length,
    // Only the ones that actually displaced it, nearest first.
    beatenBy:
      scoreIdx <= 0
        ? []
        : s.ranked.slice(Math.max(0, scoreIdx - 3), scoreIdx).map((r) => ({
            score: r.score,
            breakdown: r.breakdown,
            content: r.memory.content.slice(0, 90),
          })),
  };
}
