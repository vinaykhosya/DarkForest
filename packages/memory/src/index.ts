/**
 * @darkforest/memory
 *
 * The memory engine — docs/04-memory-engine.md. This is the product's moat;
 * everything else can be adequate, this must be excellent.
 *
 * Knowledge isolation lives in the STORE, not here. Every retrieval query
 * applies it as part of the query, so no caller can accidentally receive a
 * memory a character was never told (docs/04 § 5, CLAUDE.md § 5).
 */

export type {
  MemoryStore,
  MemoryCandidate,
  NewMemory,
  StructuralQuery,
} from "./store.js";

export { InMemoryMemoryStore, __resetMemoryIds } from "./in-memory-store.js";

export {
  retrieve,
  buildQuery,
  type RetrievalInput,
  type RetrievalOutput,
} from "./retrieval.js";

export {
  extractMemories,
  type ExtractionInput,
  type ExtractionOutcome,
} from "./extraction.js";
