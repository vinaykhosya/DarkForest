/**
 * @darkforest/ai
 *
 * Provider adapters and (from Phase 3) the router.
 *
 * This is the ONLY package permitted to name a concrete model or import a vendor
 * SDK — enforced by lint (eslint.config.js, docs/08 § 3). Everything upstream
 * names a TASK CLASS and lets the router decide, which is what allows a provider
 * to disappear without taking the product with it.
 */

export { MockProvider, type MockConfig, type MockFailureMode } from "./providers/mock.js";
export { MockEmbeddingProvider, cosineSimilarity } from "./providers/mock-embeddings.js";
export { probePrompt, type PromptProbe } from "./providers/prompt-probe.js";
export { fnv1a, unitHash, pick } from "./providers/hash.js";
