import { z } from "zod";

/**
 * AI contracts — docs/08-ai-router.md.
 *
 * Nothing outside packages/ai names a model. Application code names a TASK CLASS;
 * the router maps task class → tier → concrete model at runtime. That indirection
 * is the reason a provider can disappear without taking the product with it.
 */

export const ModelTierSchema = z.enum(["fast", "standard", "deep"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const TaskClassSchema = z.enum([
  "moderate", // fast — cheapest possible screening
  "inject_scan", // fast — prompt-injection detection
  "classify", // fast — intent, emotion, addressing
  "plan", // fast — responder selection, only when ambiguous
  "extract", // fast — memory extraction, structured output required
  "dialogue", // standard — the default path, and the bulk of traffic
  "dialogue_reaction", // fast — 2nd/3rd responder in a turn
  "narrate", // standard
  "world_create", // deep — high intent, worth spending on
  "character_create", // deep
  "consolidate", // deep — background, latency irrelevant
  "reflect", // deep — background
  "summarize_chapter", // deep — background
  "dialogue_deep", // deep — user-requested or a dramatic beat
]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

/** ADR-012 — context size is an economic lever, not only a quality one. */
export const ContextProfileSchema = z.enum(["full", "compact"]);
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

export const TASK_TIER: Readonly<Record<TaskClass, ModelTier>> = {
  moderate: "fast",
  inject_scan: "fast",
  classify: "fast",
  plan: "fast",
  extract: "fast",
  dialogue: "standard",
  dialogue_reaction: "fast",
  narrate: "standard",
  world_create: "deep",
  character_create: "deep",
  consolidate: "deep",
  reflect: "deep",
  summarize_chapter: "deep",
  dialogue_deep: "deep",
};

// ─── Messages ─────────────────────────────────────────────────────────────────

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  /** Idempotency key — a retried generation must not double-apply. docs/05 § 5. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ─── Requests ─────────────────────────────────────────────────────────────────

export interface GenerateRequest {
  taskClass: TaskClass;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /**
   * When set, the response must satisfy this schema.
   * Note: neither Nemotron endpoint supports `response_format`, so the router
   * falls back to tool-calling for these. docs/08 § 9.
   */
  responseSchema?: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  stopSequences?: string[];
  timeoutMs: number;
  /** Routing metadata. Never sent to the provider. */
  meta: {
    requestId: string;
    userId?: string;
    worldId?: string;
    turnId?: string;
    characterId?: string;
  };
}

export interface GenerateResponse {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
  tier: ModelTier;
  latencyMs: number;
  ttfbMs: number | null;
  attempt: number;
  fallbackFrom: string | null;
}

export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; response: GenerateResponse };

// ─── Providers ────────────────────────────────────────────────────────────────

/**
 * Inference pools — ADR-014.
 *
 * Tiers do NOT map to providers. A plan selects a POOL; the router decides which
 * provider currently serves it. "Free tier = NVIDIA" is the shape of statement
 * that turns a provider's terms change into a product outage; "free tier =
 * standard pool" does not.
 */
export const InferencePoolSchema = z.enum([
  /** Providers whose terms permit production AND who do not train on input. */
  "private",
  /** Providers whose terms permit production. May train on input — disclosed to the user. */
  "standard",
  /** Evaluation/benchmarking only. NEVER reachable by end-user traffic. */
  "development",
]);
export type InferencePool = z.infer<typeof InferencePoolSchema>;

/**
 * Whether a provider's TERMS permit us to serve real end users through DarkForest.
 *
 * This is a contractual question, entirely separate from privacy. A provider can
 * be privacy-clean and still forbid production use (or vice versa). Both are
 * checked independently — see ADR-013 for the case that forced the distinction.
 */
export type TermsEligibility =
  /** Terms explicitly permit embedding in a customer application serving end users. */
  | "production"
  /** Terms restrict use to internal testing/evaluation. Hard-blocked outside local dev. */
  | "development_only";

/**
 * The compliance facts about a model, recorded as DATA so the router can enforce
 * them rather than relying on a developer remembering. Every field must be
 * traceable to a cited clause — see `source`.
 */
export interface ModelPolicy {
  eligibility: TermsEligibility;
  /** Does the provider use submitted content to train or improve models? */
  trainsOnInput: boolean;
  /**
   * Does the provider's contract oblige US not to submit personal data?
   *
   * This is the field people get wrong. It is an obligation WE owe the provider.
   * Our users are not party to that agreement, so no disclaimer we show them can
   * discharge it — if a user types personal data and we forward it, we are the
   * party in breach.
   */
  forbidsPersonalData: boolean;
  /** Maximum retention of inputs/outputs in days. 0 = not retained by default. */
  retentionDays: number;
  /** Content restrictions in the provider's terms that could affect roleplay. */
  contentRestrictions?: string;
  /** Citation, so every claim above is auditable rather than remembered. */
  source: string;
  /** Terms change. An unverified-in-6-months entry is a stale entry. */
  verifiedOn: string;
}

export interface ModelDescriptor {
  /** Provider-native id. The ONLY place a model string may appear is the registry. */
  id: string;
  tier: ModelTier;
  /** Which pools this model may serve. Derived from `policy`, never hand-set. */
  pools: readonly InferencePool[];
  policy: ModelPolicy;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  /** Micro-rupees per million tokens. Zero for free endpoints — which is not the same as free of cost. */
  costPerMTokIn: number;
  costPerMTokOut: number;
  isFree: boolean;
  rateLimit?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
  /** From our own eval suite (docs/15 § 4). Undefined = not yet benchmarked = not routable. */
  qualityScore?: number;
}

/**
 * Derives pool membership from policy. Single source of truth: a model's pools
 * are a FUNCTION of its terms, never an independently editable field. Making
 * these separately settable is how a development-only model eventually ends up
 * serving a paying customer.
 */
export function poolsFor(policy: ModelPolicy): InferencePool[] {
  if (policy.eligibility === "development_only") return ["development"];
  return policy.trainsOnInput ? ["standard", "development"] : ["private", "standard", "development"];
}

export type BreakerState = "closed" | "open" | "half_open";

export interface ProviderHealth {
  state: BreakerState;
  recentFailures: number;
  recentRequests: number;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
}

export interface AIProvider {
  readonly id: string;
  readonly models: readonly ModelDescriptor[];
  readonly enabled: boolean;
  generate(req: GenerateRequest, model: ModelDescriptor): Promise<GenerateResponse>;
  stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void>;
  health(modelId: string): ProviderHealth;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly version: number;
  /** Embeddings are derived from user content, so the same policy gate applies. */
  readonly policy: ModelPolicy;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type AIErrorCode =
  | "RATE_LIMITED" // 429 — never retry the same model. docs/08 § 6.
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "AUTH_FAILED"
  | "CONTENT_FILTER" // a provider refusal — do NOT shop it to another provider
  | "MALFORMED_OUTPUT"
  | "CAPABILITY_MISSING"
  | "NO_CANDIDATES"
  | "BUDGET_EXCEEDED";

export class AIError extends Error {
  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly model?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIError";
  }

  /** Whether it is worth trying a DIFFERENT model. Not whether to retry this one. */
  get shouldFallback(): boolean {
    return this.code !== "CONTENT_FILTER" && this.code !== "BUDGET_EXCEEDED";
  }
}
