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

export interface ModelDescriptor {
  /** Provider-native id. The ONLY place a model string may appear is the registry. */
  id: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  /** Micro-rupees per million tokens. Zero for free endpoints — which is not the same as free of cost. */
  costPerMTokIn: number;
  costPerMTokOut: number;
  isFree: boolean;
  /**
   * ADR-009: providers that train on submitted content are development-only.
   * The router refuses to route real user content to a model where this is false.
   */
  privacySafe: boolean;
  rateLimit?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
  /** From our own eval suite (docs/15 § 4). Undefined = not yet benchmarked = not routable. */
  qualityScore?: number;
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
  readonly privacySafe: boolean;
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
