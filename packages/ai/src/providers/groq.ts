import {
  AIError,
  poolsFor,
  TASK_TIER,
  type AIProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ModelDescriptor,
  type ModelPolicy,
  type ProviderHealth,
  type StreamChunk,
  type ToolCall,
} from "@darkforest/contracts";
import { redactKeys } from "../credentials.js";

/**
 * Groq — the primary production provider. ADR-009.
 *
 * Verified 2026-09-03/04:
 *   · tool calling      ✅
 *   · JSON mode         ✅ (response_format) — better than the docs suggested
 *   · 262 ms for a trivial completion
 *   · does not train on Inputs or Outputs, contractually, free tier included
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING (ADR-020):
 * 8000 tokens is a hard ceiling on a SINGLE request, not merely a rate. Groq
 * rejects anything larger outright and compares against the LIMIT rather than
 * the remaining bucket, so waiting does not help. The `full` context profile
 * (~11.3K) cannot run here and must route to OpenRouter.
 *
 * We therefore pre-flight the size ourselves: a rejected oversize request still
 * costs one of 1000 daily requests, so failing locally is strictly cheaper.
 */

const BASE_URL = "https://api.groq.com/openai/v1";

/** Hard per-request ceiling on the free tier. ADR-020. */
export const GROQ_FREE_REQUEST_CEILING = 8_000;

const GROQ_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  // Not retained by default; up to 30 days for reliability/abuse unless ZDR is on.
  retentionDays: 30,
  source:
    "Groq Services Agreement: licence to make the service available to End Users through " +
    "Customer Applications; Groq is not permitted to use Inputs or Outputs for training " +
    "or fine-tuning without permission. No evaluation-only restriction. Verified 2026-09-03.",
  verifiedOn: "2026-09-03",
};

interface GroqModelSpec {
  id: string;
  tier: "fast" | "standard" | "deep";
  qualityScore?: number;
  /**
   * Emits a `reasoning` field before `content`, and those tokens count against
   * BOTH max_tokens and the 8000 TPM ceiling.
   *
   * Measured 2026-09-04: gpt-oss-20b spends 400+ characters reasoning by
   * default. With max_tokens set for the answer alone, the reasoning consumes
   * the budget and the content is truncated mid-JSON — which surfaces as
   * Groq's opaque "Failed to validate JSON", not as a length error.
   */
  reasoning?: boolean;
  /** Accepts reasoning_effort: low|medium|high. qwen accepts only none|default. */
  supportsEffortLevels?: boolean;
}

/**
 * The routable catalogue. Deliberately small: a model without a benchmarked
 * quality score is not routable in production (docs/08 § 4), and every entry
 * here has had its capabilities confirmed by a real call.
 */
const MODELS: GroqModelSpec[] = [
  { id: "openai/gpt-oss-120b", tier: "standard", reasoning: true, supportsEffortLevels: true },
  { id: "openai/gpt-oss-20b", tier: "fast", reasoning: true, supportsEffortLevels: true },
  // qwen models reject reasoning_effort levels and failed JSON-mode validation
  // in testing, so they are not used for structured-output task classes.
  { id: "qwen/qwen3.6-27b", tier: "standard", reasoning: true },
  { id: "qwen/qwen3.8-27b", tier: "standard", reasoning: true },
];

/** Task classes whose output must parse. These need JSON mode and a token headroom. */
const STRUCTURED_TASKS = new Set(["extract", "plan", "classify", "moderate", "inject_scan", "consolidate"]);

/**
 * Extra output budget for reasoning models.
 *
 * Without it the reasoning trace eats the answer. Measured: ~230 characters of
 * reasoning at effort=low, ~410 at default.
 */
const REASONING_HEADROOM_TOKENS = 400;

export interface GroqConfig {
  /** Acquired per-call from the CredentialRegistry. Never held on the instance. */
  getCredential: (estimatedTokens: number) => { id: string; key: string } | null;
  onSuccess?: (credentialId: string, tokens: number) => void;
  onRateLimited?: (credentialId: string, retryAfterMs: number | undefined) => void;
  onRejected?: (credentialId: string, reason: string) => void;
  onFailure?: (credentialId: string) => void;
  timeoutMs?: number;
}

interface GroqChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string;
}

interface GroqResponse {
  choices?: GroqChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: {
    message?: string;
    code?: string;
    type?: string;
    /**
     * When JSON mode rejects a generation, Groq returns what the model actually
     * produced here. Discarding it — as the first version of this provider did —
     * turns a diagnosable failure into "Failed to validate JSON", which says
     * nothing about why.
     */
    failed_generation?: string;
  };
}

export class GroqProvider implements AIProvider {
  readonly id = "groq";
  readonly enabled = true;
  readonly models: readonly ModelDescriptor[];

  private readonly config: GroqConfig;
  private readonly specs = new Map<string, GroqModelSpec>();

  constructor(config: GroqConfig) {
    this.config = config;
    for (const spec of MODELS) this.specs.set(spec.id, spec);
    this.models = MODELS.map((spec) => ({
      id: spec.id,
      tier: spec.tier,
      pools: poolsFor(GROQ_POLICY),
      policy: GROQ_POLICY,
      // The ceiling that actually binds is per-request, not the model's window.
      contextWindow: GROQ_FREE_REQUEST_CEILING,
      maxOutput: 2048,
      supportsTools: true,
      supportsStreaming: true,
      supportsStructuredOutput: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      isFree: true,
      rateLimit: { rpm: 30, rpd: 1000, tpm: 8000 },
      ...(spec.qualityScore === undefined ? {} : { qualityScore: spec.qualityScore }),
    }));
  }

  health(): ProviderHealth {
    // Per-credential health lives in the CredentialRegistry; this provider is
    // stateless so that credentials can rotate underneath it.
    return {
      state: "closed",
      recentFailures: 0,
      recentRequests: 0,
      lastFailureAt: null,
      cooldownUntil: null,
    };
  }

  async generate(req: GenerateRequest, model: ModelDescriptor): Promise<GenerateResponse> {
    const estimated = this.estimateTokens(req);

    // Pre-flight the ceiling. A rejected oversize request still burns one of
    // 1000 daily requests, so failing here is strictly cheaper than a round trip.
    if (estimated + req.maxTokens > GROQ_FREE_REQUEST_CEILING) {
      throw new AIError(
        "CAPABILITY_MISSING",
        `Request ~${String(estimated + req.maxTokens)} tokens exceeds Groq's ` +
          `${String(GROQ_FREE_REQUEST_CEILING)}-token per-request ceiling. ` +
          `Use the compact context profile, or route to a provider without this limit (ADR-020).`,
        model.id,
      );
    }

    const credential = this.config.getCredential(estimated);
    if (!credential) {
      throw new AIError("BUDGET_EXCEEDED", "No Groq credential available", model.id);
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.key}`,
        },
        body: JSON.stringify(this.buildBody(req, model)),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      });
    } catch (cause) {
      this.config.onFailure?.(credential.id);
      throw new AIError("TIMEOUT", redactKeys((cause as Error).message), model.id);
    }

    if (response.status === 401 || response.status === 403) {
      this.config.onRejected?.(credential.id, `HTTP ${String(response.status)}`);
      throw new AIError("AUTH_FAILED", `Groq rejected credential ${credential.id}`, model.id);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryMs = retryAfter === null ? undefined : Number(retryAfter) * 1000;
      this.config.onRateLimited?.(credential.id, retryMs);
      // docs/08 § 6 — never retry the same credential; the router advances.
      throw new AIError("RATE_LIMITED", "Groq rate limit", model.id, retryMs);
    }

    const body = (await response.json()) as GroqResponse;

    if (!response.ok || body.error) {
      this.config.onFailure?.(credential.id);

      /*
       * JSON-mode rejection is recoverable and worth distinguishing.
       *
       * Groq validates JSON-mode output server-side and returns the offending
       * text in `failed_generation`. Treating that as MALFORMED_OUTPUT lets the
       * caller run its repair pass on real content (docs/08 § 9) instead of
       * discarding a batch over a formatting slip.
       */
      const failed = body.error?.failed_generation;
      if (failed !== undefined && failed.length > 0) {
        throw new AIError(
          "MALFORMED_OUTPUT",
          redactKeys(`Groq JSON-mode rejection. Model produced: ${failed.slice(0, 800)}`),
          model.id,
        );
      }

      throw new AIError(
        "SERVER_ERROR",
        redactKeys(body.error?.message ?? `HTTP ${String(response.status)}`),
        model.id,
      );
    }

    const choice = body.choices?.[0];
    const usage = body.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? estimated;
    const outputTokens = usage.completion_tokens ?? 0;

    this.config.onSuccess?.(credential.id, inputTokens + outputTokens);

    return {
      text: choice?.message?.content ?? "",
      toolCalls: this.parseToolCalls(choice),
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: { inputTokens, outputTokens },
      model: model.id,
      provider: this.id,
      tier: TASK_TIER[req.taskClass],
      latencyMs: Date.now() - started,
      ttfbMs: null,
      attempt: 1,
      fallbackFrom: null,
    };
  }

  async *stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void> {
    // Non-streaming for now: the lab and evals do not need token-by-token, and
    // an SSE parser written without a consumer is a parser written blind.
    // Phase 9 adds real streaming when the UI can exercise it.
    const complete = await this.generate(req, model);
    if (complete.text.length > 0) yield { type: "text", delta: complete.text };
    for (const call of complete.toolCalls) yield { type: "tool_call", call };
    yield { type: "done", response: complete };
  }

  private buildBody(req: GenerateRequest, model: ModelDescriptor): Record<string, unknown> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const spec = this.specs.get(model.id);
    const structured = STRUCTURED_TASKS.has(req.taskClass);

    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      // Reasoning tokens are emitted before content and counted here, so a
      // budget sized for the answer alone truncates the answer.
      max_tokens:
        spec?.reasoning === true ? req.maxTokens + REASONING_HEADROOM_TOKENS : req.maxTokens,
      temperature: req.temperature,
    };

    // Minimise reasoning on structured tasks: extraction is transcription, not
    // deliberation, and every reasoning token is a token of TPM spent.
    if (spec?.supportsEffortLevels === true && structured) {
      body["reasoning_effort"] = "low";
    }

    if (req.stopSequences && req.stopSequences.length > 0) {
      body["stop"] = req.stopSequences;
    }

    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body["tool_choice"] = "auto";
    }

    // Native JSON mode — verified working. Preferred over the tool-calling
    // fallback, which stays for providers that lack response_format (docs/08 § 9).
    if (req.responseSchema !== undefined) {
      body["response_format"] = { type: "json_object" };
    }

    return body;
  }

  private parseToolCalls(choice: GroqChoice | undefined): ToolCall[] {
    const raw = choice?.message?.tool_calls ?? [];
    const calls: ToolCall[] = [];
    for (const call of raw) {
      const name = call.function?.name;
      if (name === undefined) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        // A tool call with unparseable arguments is dropped rather than applied.
        // docs/08 § 9: never feed unvalidated model output into a write path.
        continue;
      }
      calls.push({ id: call.id, name, arguments: args });
    }
    return calls;
  }

  private mapFinishReason(reason: string | undefined): GenerateResponse["finishReason"] {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "tool_calls":
      case "function_call":
        return "tool_calls";
      case "content_filter":
        return "content_filter";
      default:
        return "stop";
    }
  }

  /** Conservative estimate — over-estimating wastes budget, under-estimating truncates. */
  private estimateTokens(req: GenerateRequest): number {
    const chars =
      req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    return Math.ceil(chars / 3.6);
  }
}
