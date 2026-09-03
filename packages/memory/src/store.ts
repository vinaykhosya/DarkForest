import type {
  CharacterId,
  EntityRef,
  KnowledgeSource,
  Memory,
  MemoryId,
  MemoryKind,
  MemoryVisibility,
  WorldId,
} from "@darkforest/contracts";

/**
 * The MemoryStore boundary — docs/01 § P2, docs/04-memory-engine.md.
 *
 * Phase 1 uses an in-memory implementation; Phase 4 adds Postgres + pgvector.
 * The interface is shaped so the Postgres version is a direct translation and
 * nothing above it changes.
 *
 * THE MOST IMPORTANT DESIGN DECISION HERE
 * ---------------------------------------
 * Every retrieval method takes `characterId` and applies knowledge isolation
 * ITSELF. The filter is part of the query, never a step the caller performs
 * afterwards.
 *
 * That is deliberate and it is a hard rule (CLAUDE.md § 5, docs/04 § 5): a
 * caller that receives unfiltered rows and is trusted to filter them will
 * eventually forget, and the failure mode is a character revealing a secret they
 * were never told. Making the unfiltered read impossible to express is the only
 * version of this that survives contact with a deadline.
 *
 * `characterId: null` means the narrator, which has world scope.
 */

export interface NewMemory {
  worldId: WorldId;
  kind: MemoryKind;
  content: string;
  subjects?: readonly EntityRef[];
  location?: string | null;
  worldDay?: number | null;
  importance: number;
  confidence?: number;
  visibility?: MemoryVisibility;
  isPinned?: boolean;
  isUserEdited?: boolean;
}

/** A retrieval candidate, before ranking. */
export interface MemoryCandidate {
  memory: Memory;
  /** Raw path score. Meaning differs per path; fusion normalises by rank. */
  rawScore: number;
  /** Certainty from this character's knowledge record; 1 for world-scope. */
  certainty: number;
}

export interface StructuralQuery {
  includePinned: boolean;
  recentCount: number;
  subjects: readonly EntityRef[];
}

export interface MemoryStore {
  insert(memory: NewMemory): Promise<Memory>;
  get(id: MemoryId): Promise<Memory | null>;
  /** Content edits set `isUserEdited` and require re-embedding. */
  update(id: MemoryId, patch: Partial<Pick<Memory, "content" | "isPinned" | "importance">>): Promise<Memory>;
  softDelete(id: MemoryId): Promise<void>;
  supersede(id: MemoryId, by: MemoryId): Promise<void>;

  /** Knowledge isolation applied internally. See the note above. */
  vectorSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryVector: Float32Array,
    limit: number,
  ): Promise<MemoryCandidate[]>;

  keywordSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryText: string,
    limit: number,
  ): Promise<MemoryCandidate[]>;

  structuralSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    query: StructuralQuery,
  ): Promise<MemoryCandidate[]>;

  grantKnowledge(
    characterId: CharacterId,
    memoryId: MemoryId,
    source: KnowledgeSource,
    certainty: number,
    learnedAtDay: number | null,
  ): Promise<void>;

  setEmbedding(
    id: MemoryId,
    vector: Float32Array,
    model: string,
    version: number,
  ): Promise<void>;

  /** Memories awaiting an embedding. Retrieval must degrade, not fail, when this is non-empty. */
  pendingEmbeddings(worldId: WorldId, limit: number): Promise<Memory[]>;

  recordAccess(ids: readonly MemoryId[]): Promise<void>;
  countByWorld(worldId: WorldId): Promise<number>;
  /** Every live memory in a world. For consolidation and lab inspection only. */
  allByWorld(worldId: WorldId): Promise<Memory[]>;
}
