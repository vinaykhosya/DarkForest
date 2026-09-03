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
import { pick, unitHash } from "./hash.js";
import { probePrompt, type PromptProbe } from "./prompt-probe.js";

/**
 * The mock provider — docs/08-ai-router.md § 10.
 *
 * NOT a test double. A first-class provider, and a Phase 1 deliverable.
 *
 * What it buys:
 *   · every UI and product feature developable at zero inference cost
 *   · a test suite that runs offline, free, in milliseconds
 *   · deterministic tests of retry, fallback and circuit-breaker paths, which
 *     are otherwise nearly impossible to exercise reliably
 *   · a working demo when every real provider is down
 *
 * The rule it enforces on us: if a feature cannot be demonstrated with
 * MOCK_AI=true, that feature has a hidden dependency on model behaviour — and
 * that is worth discovering now rather than during a provider outage.
 *
 * Determinism: every response is a pure function of (task class, last user
 * message, character, seed). Same input, same output, always.
 */

export type MockFailureMode =
  | "none"
  | "rate_limited"
  | "timeout"
  | "server_error"
  | "malformed_output"
  | "content_filter"
  | "empty";

export interface MockConfig {
  seed?: string;
  /** Simulated wall-clock latency. Zero in tests; raise it for realistic UI work. */
  latencyMs?: number;
  ttfbMs?: number;
  failureMode?: MockFailureMode;
  /**
   * 0..1. Decided per-request by hash, so a given request either always fails
   * or always succeeds — a flaky mock would make the retry tests worthless.
   */
  failureRate?: number;
  /** Substring that triggers a content_filter refusal. For moderation tests. */
  blockPhrase?: string;
}

/**
 * The mock's own policy. Honest rather than convenient: nothing leaves the
 * process, so it genuinely trains on nothing and retains nothing.
 */
const MOCK_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  retentionDays: 0,
  source: "In-process mock. No network egress; nothing is transmitted or stored.",
  verifiedOn: "2026-09-03",
};

const DIALOGUE_LINES = [
  "I wondered when you'd get around to saying that.",
  "You always arrive at exactly the wrong moment.",
  "Say it again. Slowly.",
  "That isn't what you told me before.",
  "And you expect me to simply accept that?",
  "Fine. But we are not finished with this.",
  "You should have come to me sooner.",
  "Careful. That's a dangerous thing to say out loud.",
];

const NARRATION_LINES = [
  "The room settles into an uneasy quiet.",
  "Somewhere beyond the door, a floorboard shifts.",
  "The light has gone thin and grey at the window.",
  "Nobody moves for a moment longer than is comfortable.",
];

export class MockProvider implements AIProvider {
  readonly id = "mock";
  readonly enabled = true;
  readonly models: readonly ModelDescriptor[];

  private readonly config: Required<Omit<MockConfig, "blockPhrase">> &
    Pick<MockConfig, "blockPhrase">;

  /** Call counts per model, so tests can assert distribution and fallback. */
  private readonly calls = new Map<string, number>();

  constructor(config: MockConfig = {}) {
    this.config = {
      seed: config.seed ?? "darkforest",
      latencyMs: config.latencyMs ?? 0,
      ttfbMs: config.ttfbMs ?? 0,
      failureMode: config.failureMode ?? "none",
      failureRate: config.failureRate ?? 0,
      ...(config.blockPhrase === undefined ? {} : { blockPhrase: config.blockPhrase }),
    };

    // One descriptor per tier so tier-routing and downgrade paths are testable.
    this.models = (["fast", "standard", "deep"] as const).map((tier) => ({
      id: `mock-${tier}`,
      tier,
      pools: poolsFor(MOCK_POLICY),
      policy: MOCK_POLICY,
      contextWindow: 128_000,
      maxOutput: 4096,
      supportsTools: true,
      supportsStreaming: true,
      supportsStructuredOutput: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      isFree: true,
      qualityScore: tier === "deep" ? 9 : tier === "standard" ? 8 : 7,
    }));
  }

  callCount(modelId?: string): number {
    if (modelId !== undefined) return this.calls.get(modelId) ?? 0;
    let total = 0;
    for (const n of this.calls.values()) total += n;
    return total;
  }

  reset(): void {
    this.calls.clear();
  }

  health(): ProviderHealth {
    return {
      state: "closed",
      recentFailures: 0,
      recentRequests: this.callCount(),
      lastFailureAt: null,
      cooldownUntil: null,
    };
  }

  async generate(req: GenerateRequest, model: ModelDescriptor): Promise<GenerateResponse> {
    this.calls.set(model.id, (this.calls.get(model.id) ?? 0) + 1);

    const fingerprint = this.fingerprint(req, model);
    this.maybeFail(req, fingerprint, model);

    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    const probe = probePrompt(req.system);
    const text =
      this.config.failureMode === "empty" ? "" : this.compose(req, probe, fingerprint);

    return this.respond(req, model, text);
  }

  async *stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void> {
    const complete = await this.generate(req, model);
    // Word-at-a-time, so streaming UI work has something realistic to render.
    const words = complete.text.split(/(\s+)/).filter((w) => w.length > 0);
    for (const word of words) {
      yield { type: "text", delta: word };
    }
    for (const call of complete.toolCalls) {
      yield { type: "tool_call", call };
    }
    yield { type: "done", response: complete };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private fingerprint(req: GenerateRequest, model: ModelDescriptor): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return [
      this.config.seed,
      req.taskClass,
      model.tier,
      req.meta.characterId ?? "",
      lastUser,
    ].join("");
  }

  private maybeFail(req: GenerateRequest, fingerprint: string, model: ModelDescriptor): void {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    if (
      this.config.blockPhrase !== undefined &&
      lastUser.toLowerCase().includes(this.config.blockPhrase.toLowerCase())
    ) {
      throw new AIError("CONTENT_FILTER", "Mock refused: blockPhrase matched.", model.id);
    }

    const mode = this.config.failureMode;
    if (mode === "none" || mode === "empty" || mode === "malformed_output") return;

    // Deterministic: a given request always fails or always succeeds.
    if (this.config.failureRate > 0 && unitHash(fingerprint) >= this.config.failureRate) return;

    switch (mode) {
      case "rate_limited":
        // retryAfterMs is set, but per docs/08 § 6 the router must advance to the
        // NEXT model rather than retrying this one. The test asserts that.
        throw new AIError("RATE_LIMITED", "Mock rate limit.", model.id, 60_000);
      case "timeout":
        throw new AIError("TIMEOUT", "Mock timeout.", model.id);
      case "server_error":
        throw new AIError("SERVER_ERROR", "Mock upstream error.", model.id);
      case "content_filter":
        throw new AIError("CONTENT_FILTER", "Mock content filter.", model.id);
    }
  }

  private compose(req: GenerateRequest, probe: PromptProbe, fingerprint: string): string {
    if (this.config.failureMode === "malformed_output" && this.needsJson(req.taskClass)) {
      // Truncated JSON — exercises the repair path in docs/08 § 9.
      return '{"memories": [{"kind": "episodic", "content": "trunca';
    }

    switch (req.taskClass) {
      case "dialogue":
      case "dialogue_reaction":
      case "dialogue_deep":
        return this.composeDialogue(probe, fingerprint);
      case "narrate":
        return pick(NARRATION_LINES, fingerprint);
      case "extract":
        return JSON.stringify(this.composeExtraction(req, probe));
      case "plan":
        return JSON.stringify({
          responders: probe.presentCharacters.slice(0, 2),
          reason: "mock: first present characters",
        });
      case "classify":
        return JSON.stringify({ intent: "statement", emotion: "neutral", addressed: null });
      case "moderate":
      case "inject_scan":
        return JSON.stringify({ verdict: "allow", categories: [], score: 0.01 });
      case "world_create":
      case "character_create":
      case "consolidate":
      case "reflect":
      case "summarize_chapter":
        return JSON.stringify({ ok: true, taskClass: req.taskClass, note: "mock output" });
    }
  }

  /**
   * Dialogue echoes a retrieved memory when one is present.
   *
   * This is the assertion surface: a test plants a fact, runs a turn, and checks
   * the response references it. If retrieval or budget packing silently drops
   * every memory, there is nothing to echo and the test fails — which is exactly
   * the failure we want surfaced in Phase 1.
   */
  private composeDialogue(probe: PromptProbe, fingerprint: string): string {
    const line = pick(DIALOGUE_LINES, fingerprint);
    const name = probe.characterName ?? "Someone";

    if (probe.memories.length === 0) {
      return `${line} [mock:${name}:no-memories]`;
    }

    const memory = pick(probe.memories, `${fingerprint}mem`);
    const dayTag = memory.day === null ? "" : ` day ${String(memory.day)}:`;
    return `${line} I haven't forgotten —${dayTag} ${memory.content} [mock:${name}:mem=${String(probe.memories.length)}]`;
  }

  /**
   * Keyword-driven extraction. Crude on purpose: it must produce schema-valid
   * output that a real model would plausibly produce, so the extraction
   * pipeline, validation and dedupe paths can all be exercised offline.
   *
   * Importance values mirror the irreversibility weighting in docs/04 § 4 —
   * commitments and betrayals rank high because they cannot be undone.
   */
  private composeExtraction(
    req: GenerateRequest,
    probe: PromptProbe,
  ): {
    memories: Array<Record<string, unknown>>;
    relationshipDeltas: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    contradictions: never[];
  } {
    const transcript = req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");
    const lower = transcript.toLowerCase();
    const day = probe.worldDay;

    const memories: Array<Record<string, unknown>> = [];
    const relationshipDeltas: Array<Record<string, unknown>> = [];

    const signals: Array<[RegExp, string, number]> = [
      [/\bpromis/, "The user made a promise.", 0.85],
      [/\b(swear|swore|vow)/, "The user swore an oath.", 0.9],
      [/\bbetray/, "A betrayal occurred.", 0.95],
      [/\b(gave|gift|handed)/, "The user gave something away.", 0.6],
      [/\b(leaving|leave|depart)/, "The user announced a departure.", 0.75],
      [/\b(kill|died|dead|death)/, "A death was discussed.", 0.9],
    ];

    for (const [pattern, content, importance] of signals) {
      if (!pattern.test(lower)) continue;
      memories.push({
        kind: "episodic",
        content,
        subjects: [],
        importance,
        confidence: 0.9,
        worldDay: day,
        knownBy: [],
        visibility: "world",
      });
    }

    if (/\bbetray/.test(lower)) {
      relationshipDeltas.push({
        from: "narrator",
        to: "narrator",
        deltas: { trust: -12 },
        reason: "Mock: a betrayal was detected in the transcript.",
      });
    }

    return { memories, relationshipDeltas, events: [], contradictions: [] };
  }

  private needsJson(taskClass: TaskClass): boolean {
    return (
      taskClass === "extract" ||
      taskClass === "plan" ||
      taskClass === "classify" ||
      taskClass === "moderate" ||
      taskClass === "inject_scan" ||
      taskClass === "consolidate"
    );
  }

  private respond(
    req: GenerateRequest,
    model: ModelDescriptor,
    text: string,
  ): GenerateResponse {
    const inputTokens = Math.ceil(
      (req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 3.6,
    );
    const toolCalls = this.toolCallsFor(req);
    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 3.6) },
      model: model.id,
      provider: this.id,
      tier: TASK_TIER[req.taskClass],
      latencyMs: this.config.latencyMs,
      ttfbMs: this.config.ttfbMs,
      attempt: 1,
      fallbackFrom: null,
    };
  }

  /**
   * Emits a tool call when the request offers `record_event` and the transcript
   * suggests something happened. Enough to exercise validation, mutation caps
   * and idempotency (docs/05 § 5) without a real model.
   */
  private toolCallsFor(req: GenerateRequest): ToolCall[] {
    const available = new Set((req.tools ?? []).map((t) => t.name));
    if (!available.has("record_event")) return [];

    const transcript = req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();
    if (!/\b(betray|promis|died|leaving|swear)/.test(transcript)) return [];

    return [
      {
        // Stable id derived from the turn, so a retried generation repeats the
        // same tool_call_id and the idempotency check can suppress it.
        id: `mock-tc-${req.meta.turnId ?? req.meta.requestId}`,
        name: "record_event",
        arguments: {
          title: "Mock recorded event",
          eventType: "story",
          importance: 0.7,
        },
      },
    ];
  }
}
