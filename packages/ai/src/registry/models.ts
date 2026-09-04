/**
 * MODEL REGISTRY — the single place a model identifier may appear.
 *
 * Enforced by lint (eslint.config.js, docs/08 § 4): no model string exists
 * anywhere else in the codebase. Application code names a TASK CLASS and lets
 * the router decide, which is what allows a provider to disappear without
 * taking the product with it.
 *
 * This file exists because the lint rule caught the Groq model list being
 * duplicated between the provider adapter and the credential config. Two copies
 * of a list that must agree is a drift bug waiting for the day someone adds a
 * model to one of them.
 */

/**
 * Groq dialogue models.
 *
 * Each is metered INDEPENDENTLY on the same credential — verified 2026-09-04,
 * four models on one key each reporting 999/1000 requests remaining. That fact
 * is why capacity is keyed per (credential x model); see ADR-021.
 */
export const GROQ_DIALOGUE_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
] as const;

/** Purpose-built safety models on the same free tier. */
export const GROQ_MODERATION_MODEL = "openai/gpt-oss-safeguard-20b";
export const GROQ_INJECTION_MODEL = "meta-llama/llama-prompt-guard-2-86m";

/** Cloudflare Workers AI embeddings — 768-dim, matches the halfvec schema. */
export const CLOUDFLARE_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/**
 * DEVELOPMENT-ONLY models.
 *
 * Listed here for capacity accounting only. `checkPoolEligibility` refuses them
 * outside a local environment with synthetic content, regardless of what any
 * caller asks for — NVIDIA's API Trial ToS forbids production outright
 * (ADR-013), and Gemini's unpaid terms train on submitted content (ADR-009).
 */
export const GEMINI_DEV_MODELS = ["gemini-2.5-flash"] as const;
export const NVIDIA_DEV_MODELS = ["nvidia/nemotron-3.5-lightning-30b-a3b"] as const;
