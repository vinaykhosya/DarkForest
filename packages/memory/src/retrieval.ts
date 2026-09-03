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
}

export interface RetrievalOutput {
  memories: ScoredMemory[];
  trace: RetrievalTrace;
  /** True when embeddings lagged and the vector path contributed nothing. */
  degraded: boolean;
}

/**
 * Builds the retrieval query.
 *
 * Deliberately NOT the bare user message: a reply of "yes" retrieves nothing on
 * its own. Widening with recent lines and the scene gives short turns something
 * to match against.
 *
 * Entity extraction is regex against a per-world alias list, not an LLM call —
 * names are the highest-signal retrieval term and exact matching finds them
 * better than embeddings do (docs/04 § 5, docs/01 § P4).
 */
export function buildQuery(input: RetrievalInput): { text: string; entities: string[] } {
  const parts = [input.userMessage, ...(input.recentLines ?? []).slice(-2)];
  if (input.sceneSummary !== undefined && input.sceneSummary.length > 0) {
    parts.push(input.sceneSummary);
  }

  const haystack = parts.join(" ").toLowerCase();
  const entities = (input.aliases ?? []).filter((alias) =>
    haystack.includes(alias.toLowerCase()),
  );

  return { text: [...parts, ...entities].join(" "), entities };
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
    const [queryVector] = await embedder.embed([query.text]);
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

  return { memories: packed.selected, trace, degraded };
}
