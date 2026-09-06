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
  type TaskClass,
  type ToolCall,
} from "@darkforest/contracts";
import { redactKeys } from "../credentials.js";
import { GROQ_DIALOGUE_MODELS } from "../registry/models.js";

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
  /**
   * Which reasoning_effort value this model accepts.
   *
   * "low"  — gpt-oss. Graded levels.
   * "none" — qwen. It rejects the graded levels, and a boolean
   *          `supportsEffortLevels` therefore meant "send nothing", which is
   *          how qwen3.6 came to burn 537 of 550 tokens on a <think> block and
   *          return no speech at all. Measured: with reasoning_effort=none the
   *          same prompt answers in 15 tokens, in character.
   *
   * The boolean could only express "graded or nothing" and the truth is three
   * states, so a model that needed a DIFFERENT value looked identical to one
   * that needed none.
   */
  reasoningEffort?: "low" | "none";
  /**
   * Task classes MEASURED to work on this model, not the ones it advertises.
   * Omitted means unrestricted.
   */
  verifiedTaskClasses?: readonly TaskClass[];
}

/**
 * Task classes whose output must parse and be schema-valid.
 *
 * Measured 2026-09-04 on the real extraction prompt, 15 attempts per model:
 *   gpt-oss-20b   17 memories stored, 0 dropped, 0 repairs
 *   gpt-oss-120b  15 memories stored, 0 dropped, 0 repairs
 *   qwen3.8-27b   12 memories stored, 0 dropped, 0 repairs
 *   qwen3.6-27b   verbose enough to exhaust its own TPM mid-probe; 2 repairs
 *
 * The qwen limitation was already known and written down here as prose — "they
 * are not used for structured-output task classes" — but prose does not route
 * traffic. Once the scheduler chose models by capacity it sent 34 of 62
 * extractions to qwen3.8 and Suite 1 dropped 19 of them. A constraint that
 * lives only in a comment is not a constraint.
 */
const STRUCTURED_VERIFIED: readonly TaskClass[] = [
  "dialogue",
  "extract",
  "plan",
  "classify",
  "consolidate",
];

/** qwen models: prose only. They write well and fail schemas. */
const PROSE_ONLY: readonly TaskClass[] = [
  "dialogue",
  "dialogue_reaction",
  "narrate",
  "summarize_chapter",
];

/**
 * The routable catalogue. Deliberately small: a model without a benchmarked
 * quality score is not routable in production (docs/08 § 4), and every entry
 * here has had its capabilities confirmed by a real call.
 */
const [GPT_OSS_120B, GPT_OSS_20B, QWEN_36, QWEN_38] = GROQ_DIALOGUE_MODELS;

const MODELS: GroqModelSpec[] = [
  {
    id: GPT_OSS_120B,
    tier: "standard",
    reasoning: true,
    reasoningEffort: "low",
    verifiedTaskClasses: STRUCTURED_VERIFIED,
  },
  {
    id: GPT_OSS_20B,
    tier: "fast",
    reasoning: true,
    reasoningEffort: "low",
    verifiedTaskClasses: STRUCTURED_VERIFIED,
  },
  // qwen models reject reasoning_effort levels and failed JSON-mode validation
  // in testing. That is now DECLARED rather than merely described, so the
  // scheduler excludes them from structured tasks instead of discovering it.
  // qwen takes reasoning_effort "none" and rejects the graded levels. Sending
  // nothing let qwen3.6 spend an entire budget on a <think> block; 15 tokens
  // and an in-character answer with it set.
  { id: QWEN_36, tier: "standard", reasoning: true, reasoningEffort: "none", verifiedTaskClasses: PROSE_ONLY },
  { id: QWEN_38, tier: "standard", reasoning: true, reasoningEffort: "none", verifiedTaskClasses: PROSE_ONLY },
];

/*
 * STRUCTURED_TASKS used to live here, gating reasoning_effort. It is gone
 * rather than left unused: reasoning is now minimised on every task class, and
 * a constant that implies a distinction the provider no longer makes is worse
 * than no constant. The reasoning headroom keys off the model spec, and JSON
 * mode keys off the caller passing a responseSchema.
 */

/**
 * Extra output budget for reasoning models.
 *
 * Without it the reasoning trace eats the answer. Measured: ~230 characters of
 * reasoning at effort=low, ~410 at default.
 */
const REASONING_HEADROOM_TOKENS = 400;

export interface GroqConfig {
  /**
   * Acquired per-call from the CredentialRegistry. Never held on the instance.
   *
   * `modelId` is not optional in practice: Groq meters each model separately
   * (ADR-021), so a registry that does not know the model can hand back a bucket
   * metering a DIFFERENT model's budget. Local accounting then drifts from what
   * Groq actually enforces, and the drift surfaces as an unexplained 429.
   */
  getCredential: (estimatedTokens: number, modelId: string) => { id: string; key: string } | null;
  onSuccess?: (credentialId: string, tokens: number) => void;
  onRateLimited?: (credentialId: string, retryAfterMs: number | undefined) => void;
  onRejected?: (credentialId: string, reason: string) => void;
  onFailure?: (credentialId: string) => void;
  timeoutMs?: number;
}

interface GroqChoice {
  message?: {
    content?: string | null;
    /** Present on reasoning models. Billed against output and TPM. */
    reasoning?: string | null;
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

/**
 * Removes a reasoning trace that leaked into `content`.
 *
 * gpt-oss normally returns reasoning in its own `reasoning` field — verified
 * against the raw API, which puts it there even at reasoning_effort=low. Under
 * sustained load it sometimes emits the trace into content instead, opening with
 * "<think>" or "Here's a thinking process:".
 *
 * That artefact corrupted three separate measurements across two gauntlet runs,
 * twice being counted as a knowledge LEAK because the trace quoted words the
 * probe had forbidden. Stripping it belongs here rather than in each harness:
 * it is provider output normalisation, and every caller otherwise reimplements
 * it slightly differently — which is exactly how the isolation rule went wrong.
 *
 * Deliberately conservative. Only a trace at the START of the response is
 * removed, and only when what follows is non-empty, so a reply that merely
 * discusses thinking is untouched.
 */
export function stripReasoningTrace(text: string): string {
  let out = text;

  const tagged = /^\s*<think>[\s\S]*?<\/think>\s*/i.exec(out);
  if (tagged !== null) out = out.slice(tagged[0].length);

  // An unterminated trace: the response was cut off mid-thought and there is no
  // answer to recover. Better an empty string, which reads as a failure, than a
  // paragraph of deliberation presented as a character's words.
  if (/^\s*<think>/i.test(out)) return "";
  if (/^\s*(here's|here is) (a |my )?thinking process/i.test(out)) return "";

  return out.trim().length > 0 ? out : text;
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
      ...(spec.verifiedTaskClasses === undefined
        ? {}
        : { verifiedTaskClasses: spec.verifiedTaskClasses }),
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

    const credential = this.config.getCredential(estimated, model.id);
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

    // Groq folds reasoning into completion_tokens but does not break it out, so
    // estimate from the returned text. Approximate, but it is the only way to
    // see what share of the output budget thinking consumed.
    const reasoningText = choice?.message?.reasoning ?? "";
    const reasoningTokens = Math.ceil(reasoningText.length / 3.6);

    this.config.onSuccess?.(credential.id, inputTokens + outputTokens);

    return {
      text: stripReasoningTrace(choice?.message?.content ?? ""),
      toolCalls: this.parseToolCalls(choice),
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: { inputTokens, outputTokens, reasoningTokens },
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

    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      // Reasoning tokens are emitted before content and counted here, so a
      // budget sized for the answer alone truncates the answer.
      max_tokens:
        spec?.reasoning === true ? req.maxTokens + REASONING_HEADROOM_TOKENS : req.maxTokens,
      temperature: req.temperature,
    };

    /*
     * Minimise reasoning on EVERY task class, not only structured ones.
     *
     * This used to be gated on `structured`, which excluded `dialogue` — the one
     * task class a user actually sees. With max_tokens sized for a character's
     * reply, a default-effort trace consumed the whole budget and the model
     * returned reasoning and no speech. In the gauntlet that produced eight
     * empty answers out of eleven end-to-end misses, every one of them on a
     * probe where the character DID hold the right facts. It read as a memory
     * failure and was a token-budget failure.
     *
     * Extraction is transcription and dialogue is performance; neither is
     * deliberation. Removing the special case removes the hole rather than
     * adding `dialogue` to a list that will be incomplete again next time.
     */
    if (spec?.reasoningEffort !== undefined) {
      body["reasoning_effort"] = spec.reasoningEffort;
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
