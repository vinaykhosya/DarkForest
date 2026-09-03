import { cosineSimilarity } from "@darkforest/ai";
import { jaccard, overlapCoefficient, tokenSet } from "@darkforest/core";
import type {
  CharacterId,
  KnowledgeSource,
  Memory,
  MemoryId,
  WorldId,
} from "@darkforest/contracts";
import type {
  MemoryCandidate,
  MemoryStore,
  NewMemory,
  StructuralQuery,
} from "./store.js";

/**
 * In-memory MemoryStore — the Phase 1 lab implementation.
 *
 * Mirrors the Postgres semantics closely enough that Phase 4 is a translation
 * rather than a redesign. In particular the knowledge-isolation predicate here
 * is the direct equivalent of the SQL in docs/04 § 5:
 *
 *   visibility = 'world'
 *   OR EXISTS (SELECT 1 FROM character_knowledge ck
 *              WHERE ck.memory_id = m.id AND ck.character_id = $c AND ck.knows)
 *
 * Not intended for production: linear scans, no indexes, no concurrency control.
 * That is fine for a few thousand memories in a lab run.
 */

interface KnowledgeRow {
  characterId: CharacterId;
  memoryId: MemoryId;
  source: KnowledgeSource;
  certainty: number;
  learnedAtDay: number | null;
}

let counter = 0;
function nextId(): MemoryId {
  counter += 1;
  // Deterministic, UUID-shaped, so lab runs are reproducible and ids remain
  // valid against the schema's uuid checks.
  const n = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}` as MemoryId;
}

/** Test-only: makes id generation reproducible across runs. */
export function __resetMemoryIds(): void {
  counter = 0;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly memories = new Map<MemoryId, Memory>();
  private readonly embeddings = new Map<MemoryId, Float32Array>();
  private readonly embeddingMeta = new Map<MemoryId, { model: string; version: number }>();
  private readonly knowledge: KnowledgeRow[] = [];

  insert(input: NewMemory): Promise<Memory> {
    const memory: Memory = {
      id: nextId(),
      worldId: input.worldId,
      kind: input.kind,
      content: input.content,
      subjects: [...(input.subjects ?? [])],
      location: input.location ?? null,
      worldDay: input.worldDay ?? null,
      importance: input.importance,
      confidence: input.confidence ?? 1,
      visibility: input.visibility ?? "world",
      isPinned: input.isPinned ?? false,
      isUserEdited: input.isUserEdited ?? false,
      supersededBy: null,
      accessCount: 0,
      lastAccessedAt: null,
      // Fixed epoch rather than Date.now(): lab runs must be reproducible, and
      // recency in this system is measured in WORLD days anyway (docs/04 § 6).
      createdAt: new Date(0).toISOString(),
      updatedAt: null,
      deletedAt: null,
    };
    this.memories.set(memory.id, memory);
    return Promise.resolve(memory);
  }

  get(id: MemoryId): Promise<Memory | null> {
    return Promise.resolve(this.memories.get(id) ?? null);
  }

  update(
    id: MemoryId,
    patch: Partial<Pick<Memory, "content" | "isPinned" | "importance">>,
  ): Promise<Memory> {
    const existing = this.memories.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    const updated: Memory = {
      ...existing,
      ...patch,
      // A user correction wins every future contradiction (docs/04 § 8b).
      isUserEdited: patch.content !== undefined ? true : existing.isUserEdited,
    };
    this.memories.set(id, updated);
    // A changed body invalidates the vector; re-embedding is a background job.
    if (patch.content !== undefined) this.embeddings.delete(id);
    return Promise.resolve(updated);
  }

  softDelete(id: MemoryId): Promise<void> {
    const existing = this.memories.get(id);
    if (existing) this.memories.set(id, { ...existing, deletedAt: new Date(0).toISOString() });
    return Promise.resolve();
  }

  supersede(id: MemoryId, by: MemoryId): Promise<void> {
    const existing = this.memories.get(id);
    if (existing) this.memories.set(id, { ...existing, supersededBy: by });
    // Dropping the superseded vector is the largest storage win available
    // (docs/01 § Storage math).
    this.embeddings.delete(id);
    return Promise.resolve();
  }

  /**
   * The knowledge-isolation predicate. Equivalent to the SQL in docs/04 § 5.
   *
   * Returns the certainty this character holds the memory at, or null if they
   * may not recall it at all. Null means the memory is invisible to them —
   * not "visible with low confidence".
   */
  private visibleTo(memory: Memory, characterId: CharacterId | null): number | null {
    if (memory.deletedAt != null) return null;
    if (memory.supersededBy !== null) return null;

    // The narrator has world scope. Characters do not.
    if (characterId === null) return 1;

    if (memory.visibility === "world") return 1;

    const row = this.knowledge.find(
      (k) => k.memoryId === memory.id && k.characterId === characterId,
    );
    return row ? row.certainty : null;
  }

  private liveIn(worldId: WorldId, characterId: CharacterId | null): MemoryCandidate[] {
    const out: MemoryCandidate[] = [];
    for (const memory of this.memories.values()) {
      if (memory.worldId !== worldId) continue;
      const certainty = this.visibleTo(memory, characterId);
      if (certainty === null) continue;
      out.push({ memory, rawScore: 0, certainty });
    }
    return out;
  }

  vectorSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryVector: Float32Array,
    limit: number,
  ): Promise<MemoryCandidate[]> {
    const scored: MemoryCandidate[] = [];
    for (const candidate of this.liveIn(worldId, characterId)) {
      const vector = this.embeddings.get(candidate.memory.id);
      // No embedding yet — invisible to THIS path, still reachable by keyword
      // and structural search. Retrieval degrades, never fails (docs/04 § 11).
      if (!vector) continue;
      scored.push({ ...candidate, rawScore: cosineSimilarity(queryVector, vector) });
    }
    scored.sort((a, b) => b.rawScore - a.rawScore);
    return Promise.resolve(scored.slice(0, limit));
  }

  keywordSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryText: string,
    limit: number,
  ): Promise<MemoryCandidate[]> {
    const queryTokens = tokenSet(queryText);
    const scored: MemoryCandidate[] = [];
    for (const candidate of this.liveIn(worldId, characterId)) {
      const contentTokens = tokenSet(candidate.memory.content);
      // Overlap rather than Jaccard: a short memory fully contained in a long
      // query should score 1, not be penalised for the length difference.
      const score = overlapCoefficient(contentTokens, queryTokens);
      if (score <= 0) continue;
      scored.push({ ...candidate, rawScore: score });
    }
    scored.sort((a, b) => b.rawScore - a.rawScore);
    return Promise.resolve(scored.slice(0, limit));
  }

  structuralSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    query: StructuralQuery,
  ): Promise<MemoryCandidate[]> {
    const live = this.liveIn(worldId, characterId);
    const picked = new Map<MemoryId, MemoryCandidate>();

    if (query.includePinned) {
      for (const c of live.filter((c) => c.memory.isPinned)) {
        picked.set(c.memory.id, { ...c, rawScore: 1 });
      }
    }

    if (query.subjects.length > 0) {
      const wanted = new Set(query.subjects);
      for (const c of live) {
        if (c.memory.subjects.some((s) => wanted.has(s))) {
          picked.set(c.memory.id, { ...c, rawScore: 0.8 });
        }
      }
    }

    if (query.recentCount > 0) {
      const byRecency = [...live].sort((a, b) => {
        const dayA = a.memory.worldDay ?? -1;
        const dayB = b.memory.worldDay ?? -1;
        if (dayA !== dayB) return dayB - dayA;
        // Stable tiebreak on id, so lab runs are reproducible.
        return a.memory.id < b.memory.id ? 1 : -1;
      });
      for (const c of byRecency.slice(0, query.recentCount)) {
        if (!picked.has(c.memory.id)) picked.set(c.memory.id, { ...c, rawScore: 0.6 });
      }
    }

    return Promise.resolve([...picked.values()].sort((a, b) => b.rawScore - a.rawScore));
  }

  grantKnowledge(
    characterId: CharacterId,
    memoryId: MemoryId,
    source: KnowledgeSource,
    certainty: number,
    learnedAtDay: number | null,
  ): Promise<void> {
    const existing = this.knowledge.find(
      (k) => k.memoryId === memoryId && k.characterId === characterId,
    );
    if (existing) {
      // Learning something again can only raise confidence, never lower it.
      existing.certainty = Math.max(existing.certainty, certainty);
      return Promise.resolve();
    }
    this.knowledge.push({ characterId, memoryId, source, certainty, learnedAtDay });
    return Promise.resolve();
  }

  setEmbedding(
    id: MemoryId,
    vector: Float32Array,
    model: string,
    version: number,
  ): Promise<void> {
    this.embeddings.set(id, vector);
    this.embeddingMeta.set(id, { model, version });
    return Promise.resolve();
  }

  pendingEmbeddings(worldId: WorldId, limit: number): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.worldId !== worldId) continue;
      if (memory.deletedAt != null || memory.supersededBy !== null) continue;
      if (this.embeddings.has(memory.id)) continue;
      out.push(memory);
      if (out.length >= limit) break;
    }
    return Promise.resolve(out);
  }

  recordAccess(ids: readonly MemoryId[]): Promise<void> {
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (memory) {
        this.memories.set(id, {
          ...memory,
          accessCount: memory.accessCount + 1,
          lastAccessedAt: new Date(0).toISOString(),
        });
      }
    }
    return Promise.resolve();
  }

  countByWorld(worldId: WorldId): Promise<number> {
    let n = 0;
    for (const memory of this.memories.values()) {
      if (memory.worldId === worldId && memory.deletedAt == null && memory.supersededBy === null) {
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  allByWorld(worldId: WorldId): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.worldId === worldId && memory.deletedAt == null && memory.supersededBy === null) {
        out.push(memory);
      }
    }
    return Promise.resolve(out);
  }

  // ── lab helpers, not part of MemoryStore ────────────────────────────────────

  /** Nearest existing memory by content, for write-time dedupe (docs/04 § 4). */
  nearestByContent(worldId: WorldId, content: string): { memory: Memory; similarity: number } | null {
    const tokens = tokenSet(content);
    let best: { memory: Memory; similarity: number } | null = null;
    for (const memory of this.memories.values()) {
      if (memory.worldId !== worldId) continue;
      if (memory.deletedAt != null || memory.supersededBy !== null) continue;
      const similarity = jaccard(tokens, tokenSet(memory.content));
      if (best === null || similarity > best.similarity) best = { memory, similarity };
    }
    return best;
  }

  embeddingModelOf(id: MemoryId): { model: string; version: number } | null {
    return this.embeddingMeta.get(id) ?? null;
  }
}
