import {
  AIError,
  poolsFor,
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
 * OpenRouter provider adapter.
 *
 * Exposes production-eligible models available through OpenRouter.
 * Supports OpenAI-compatible chat completions and native JSON mode.
 */

const BASE_URL = "https://openrouter.ai/api/v1";

const OPENROUTER_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  retentionDays: 30,
  source:
    "OpenRouter Terms of Service: Customer retains rights to inputs/outputs; " +
    "opt-out ensures inputs are not used for training. Verified 2026-09-03.",
  verifiedOn: "2026-09-03",
};

interface OpenRouterModelSpec {
  id: string;
  tier: "fast" | "standard" | "deep";
  contextWindow: number;
  qualityScore?: number;
}

const MODELS: OpenRouterModelSpec[] = [
  {
    id: "openrouter/free",
    tier: "fast",
    contextWindow: 128_000,
  },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    tier: "standard",
    contextWindow: 1_000_000,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    tier: "deep",
    contextWindow: 1_000_000,
  },
];

const STRUCTURED_TASKS = new Set(["extract", "plan", "classify", "moderate", "inject_scan", "consolidate"]);

export interface OpenRouterConfig {
  /**
   * `modelId` is passed for symmetry with per-model-metered providers. For
   * OpenRouter the registry ignores it: the 50/day free allowance is
   * account-wide, so narrowing by model would invent capacity (ADR-021).
   */
  getCredential: (estimatedTokens: number, modelId: string) => { id: string; key: string } | null;
  onSuccess?: (credentialId: string, tokens: number) => void;
  onRateLimited?: (credentialId: string, retryAfterMs: number | undefined) => void;
  onRejected?: (credentialId: string, reason: string) => void;
  onFailure?: (credentialId: string) => void;
  timeoutMs?: number;
}

interface OpenRouterChoice {
  message?: {
    content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: {
    message?: string;
    code?: number | string;
  };
}

export class OpenRouterProvider implements AIProvider {
  readonly id = "openrouter";
  readonly enabled = true;
  readonly models: readonly ModelDescriptor[];

  private readonly config: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    this.config = config;
    this.models = MODELS.map((spec) => ({
      id: spec.id,
      tier: spec.tier,
      pools: poolsFor(OPENROUTER_POLICY),
      policy: OPENROUTER_POLICY,
      contextWindow: spec.contextWindow,
      maxOutput: 4096,
      supportsTools: true,
      supportsStreaming: true,
      supportsStructuredOutput: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      isFree: true,
      rateLimit: { rpm: 20, rpd: 50 },
      ...(spec.qualityScore === undefined ? {} : { qualityScore: spec.qualityScore }),
    }));
  }

  health(): ProviderHealth {
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
    const credential = this.config.getCredential(estimated, model.id);
    if (!credential) {
      throw new AIError("BUDGET_EXCEEDED", "No OpenRouter credential available", model.id);
    }

    const started = Date.now();
    let response: Response;
    let body: OpenRouterResponse;
    const timeout = Math.max(req.timeoutMs, this.config.timeoutMs ?? 45_000);
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.key}`,
          "http-referer": "https://darkforest.local",
          "x-title": "DarkForest AI Lab",
        },
        body: JSON.stringify(this.buildBody(req, model)),
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status === 401 || response.status === 403) {
        this.config.onRejected?.(credential.id, `HTTP ${String(response.status)}`);
        throw new AIError("AUTH_FAILED", `OpenRouter rejected credential ${credential.id}`, model.id);
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryMs = retryAfter === null ? undefined : Number(retryAfter) * 1000;
        this.config.onRateLimited?.(credential.id, retryMs);
        throw new AIError("RATE_LIMITED", "OpenRouter rate limit", model.id, retryMs);
      }

      body = (await response.json()) as OpenRouterResponse;
    } catch (cause) {
      if (cause instanceof AIError) throw cause;
      this.config.onFailure?.(credential.id);
      throw new AIError("TIMEOUT", redactKeys((cause as Error).message), model.id);
    }

    if (!response.ok || body.error) {
      this.config.onFailure?.(credential.id);
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
    const reasoningText = choice?.message?.reasoning ?? "";
    const reasoningTokens = Math.ceil(reasoningText.length / 3.6);

    this.config.onSuccess?.(credential.id, inputTokens + outputTokens);

    return {
      text: choice?.message?.content ?? "",
      toolCalls: this.parseToolCalls(choice),
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens,
        outputTokens,
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      },
      model: model.id,
      provider: this.id,
      tier: model.tier,
      latencyMs: Date.now() - started,
      ttfbMs: null,
      attempt: 1,
      fallbackFrom: null,
    };
  }

  async *stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void> {
    const res = await this.generate(req, model);
    yield { type: "text", delta: res.text };
    for (const call of res.toolCalls) {
      yield { type: "tool_call", call };
    }
    yield { type: "done", response: res };
  }

  private buildBody(req: GenerateRequest, model: ModelDescriptor): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system.length > 0) {
      messages.push({ role: "system", content: req.system });
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };

    if (STRUCTURED_TASKS.has(req.taskClass) || req.responseSchema !== undefined) {
      body["response_format"] = { type: "json_object" };
    }

    if (req.tools !== undefined && req.tools.length > 0) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    return body;
  }

  private parseToolCalls(choice?: OpenRouterChoice): ToolCall[] {
    const calls = choice?.message?.tool_calls;
    if (!calls) return [];
    const out: ToolCall[] = [];
    for (const c of calls) {
      const fn = c.function;
      if (!fn?.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      out.push({
        id: c.id,
        name: fn.name,
        arguments: args,
      });
    }
    return out;
  }

  private mapFinishReason(
    reason?: string,
  ): "stop" | "length" | "tool_calls" | "content_filter" | "error" {
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

  private estimateTokens(req: GenerateRequest): number {
    const totalChars =
      req.system.length +
      req.messages.reduce((acc, m) => acc + m.content.length, 0) +
      (req.tools ? JSON.stringify(req.tools).length : 0);
    return Math.ceil(totalChars / 3.6);
  }
}
