/**
 * SCHEDULER-BACKED ROUTER — ADR-021.
 *
 * Replaces the benchmark's Groq-primary/OpenRouter-fallback chain with the
 * capacity scheduler, so a run draws on every eligible bucket rather than
 * draining one provider and then failing over.
 *
 * WHY THIS MATTERS TO A MEMORY BENCHMARK
 * Suite 1 run 3 scored 70% recall against 91% and 84%, with six rate-limit
 * retries and Groq down to 2/8 credentials. Every rate-limited extraction call
 * permanently loses a fact, so the number was partly measuring the rate limiter.
 * A benchmark contaminated by capacity is worse than no benchmark, because it
 * looks like a memory-quality result.
 *
 * The old wiring had a second, quieter version of the same fault: it pinned ONE
 * Groq model for every call while acquiring credentials without naming it, so
 * the bucket it debited could be metering a different model's budget. It used
 * 8 of Groq's 32 buckets and mis-attributed the ones it did use.
 *
 * NOT REQUEST FAN-OUT. One request still goes to exactly one provider. What is
 * parallel is the utilisation of independent capacity across INDEPENDENT
 * requests.
 */

import {
  buildCapacityBuckets,
  type CredentialRegistry,
  type ModelSource,
} from "@darkforest/ai";
import { AIError } from "@darkforest/contracts";
import type {
  AIProvider,
  FallbackReason,
  GenerateRequest,
  GenerateResponse,
  ModelDescriptor,
  ProviderHealth,
  StreamChunk,
} from "@darkforest/contracts";
import { overview, schedule, type CapacityBucket } from "@darkforest/core";

/** One attempt against one bucket. This is the telemetry record. */
export interface RoutingAttempt {
  run: number;
  turnIndex: number;
  taskClass: "dialogue" | "extract";
  attempt: number;
  bucketId: string;
  providerId: string;
  modelId: string;
  /** Why the scheduler chose this bucket — the score components. */
  capacityDecision: Record<string, number>;
  /** Buckets eligible at selection time. Distinguishes "starved" from "unlucky". */
  bucketsAvailable: number;
  status: "ok" | FallbackReason;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  /** Set when this attempt followed a failure on another bucket. */
  fallbackFrom?: string;
  fallbackReason?: FallbackReason;
  detail?: string;
}

export interface ProviderUsageMetrics {
  dialogueCalls: number;
  dialogueTokens: number;
  extractCalls: number;
  extractTokens: number;
}

export interface SchedulerRouterConfig {
  registry: CredentialRegistry;
  /** Callable adapters, keyed by provider id. */
  adapters: Record<string, AIProvider>;
  /**
   * Providers whose adapters are wired. A provider with credentials but no
   * adapter is simply absent from the bucket list rather than silently skipped
   * at call time.
   */
  providerIds: readonly string[];
  /**
   * Narrows a provider to a subset of its models. Required for an account-wide
   * provider that offers several, since one budget must not be presented as
   * several buckets — see `buildCapacityBuckets`.
   */
  modelsByProvider?: Record<string, readonly ModelDescriptor[]>;
  /** Max buckets to try for one request before giving up. */
  maxAttempts?: number;
  sleep: (ms: number) => Promise<void>;

  /**
   * WHOSE CONTENT THIS ROUTER CARRIES. There is no default, deliberately.
   *
   * These three values were hardcoded to `development` / `local` /
   * `isSyntheticContent: true` when this class lived in the eval harness, where
   * all three were true: benchmark fixtures are synthetic and nobody's private
   * roleplay was at stake.
   *
   * The moment the product uses this router, all three are FALSE, and every one
   * of them gates something that matters. `isSyntheticContent` is what keeps
   * real user text away from providers whose terms let them train on it —
   * Gemini and NVIDIA NIM both warn against submitting personal data (ADR-013),
   * and Groq's agreement is why it can carry real content at all (ADR-009).
   *
   * Left as a default, a caller who forgot would silently ship user
   * conversations to a development-only provider. So it is required, and the
   * eval harness now states its own answer rather than inheriting it.
   */
  content: {
    /**
     * The inference pool (ADR-014). `development` admits providers that may
     * train on what they are sent; `standard` and `private` do not.
     */
    pool: "standard" | "private" | "development";
    environment: "local" | "staging" | "production";
    /**
     * True ONLY for fixtures and benchmarks. Anything a person typed is false,
     * including a test account's messages.
     */
    isSyntheticContent: boolean;
  };
}

function reasonFor(e: unknown): FallbackReason {
  if (!(e instanceof AIError)) return "PROVIDER_ERROR";
  if (e.code === "RATE_LIMITED") return "RATE_LIMITED";
  if (e.code === "BUDGET_EXCEEDED") return "BUDGET_EXCEEDED";
  if (e.code === "AUTH_FAILED") return "NO_CREDENTIAL";
  return "PROVIDER_ERROR";
}

export class SchedulerRouter implements AIProvider {
  readonly id = "scheduler";
  readonly enabled = true;
  readonly models: readonly ModelDescriptor[];

  currentRun = 1;
  currentTurn = 0;
  readonly attempts: RoutingAttempt[] = [];
  readonly usageByProvider: Record<string, ProviderUsageMetrics> = {};

  private readonly sources: ModelSource[];

  constructor(private readonly config: SchedulerRouterConfig) {
    this.sources = config.providerIds
      .map((id) => config.adapters[id])
      .filter((a): a is AIProvider => a !== undefined)
      .map((a) => ({ id: a.id, models: config.modelsByProvider?.[a.id] ?? a.models }));
    this.models = this.sources.flatMap((s) => s.models);
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

  /**
   * Current capacity across every wired provider. Rebuilt on demand because
   * `CredentialState` is immutable — the registry swaps in a new object on every
   * outcome, so a bucket list captured earlier holds stale counters.
   */
  buckets(): CapacityBucket[] {
    return buildCapacityBuckets(this.config.registry, this.sources, {
      providerIds: this.config.providerIds,
    });
  }

  capacityOverview(): ReturnType<typeof overview> {
    return overview(this.buckets(), Date.now());
  }

  async generate(req: GenerateRequest, _model: ModelDescriptor): Promise<GenerateResponse> {
    const taskClass = req.taskClass === "extract" ? "extract" : "dialogue";
    const maxAttempts = this.config.maxAttempts ?? 4;
    const estimatedTokens = estimateTokens(req);

    let fallbackFrom: string | undefined;
    let fallbackReason: FallbackReason | undefined;
    let lastError: unknown = null;
    const tried = new Set<string>();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const now = Date.now();
      // Rebuilt every attempt so a bucket that just 429'd is already cooling.
      const all = this.buckets().filter((b) => !tried.has(b.id));
      const decision = schedule(
        all,
        {
          pool: this.config.content.pool,
          environment: this.config.content.environment,
          isSyntheticContent: this.config.content.isSyntheticContent,
          estimatedTokens,
          needsStructuredOutput: taskClass === "extract",
          // Capability before capacity: a model not verified for this task is
          // excluded outright rather than merely scored lower. See ADR-022.
          taskClass: req.taskClass,
        },
        now,
      );

      if (decision.bucket === null) {
        /*
         * Every bucket is cooling or exhausted. This is our OWN pool applying
         * backpressure with a retryAt, not a provider refusal — treating it as
         * fatal is what made earlier runs score 0%. Wait and re-schedule.
         */
        const waitMs = Math.min(
          15_000,
          Math.max(1_000, (decision.retryAt ?? now + 2_000) - now),
        );
        if (attempt === maxAttempts) break;
        process.stdout.write(`\n        [BACKPRESSURE] waiting ${String(waitMs)}ms `);
        await this.config.sleep(waitMs);
        continue;
      }

      const bucket = decision.bucket;
      tried.add(bucket.id);
      const adapter = this.config.adapters[bucket.providerId];
      if (adapter === undefined) continue;

      const record: RoutingAttempt = {
        run: this.currentRun,
        turnIndex: this.currentTurn,
        taskClass,
        attempt,
        bucketId: bucket.id,
        providerId: bucket.providerId,
        modelId: bucket.model.id,
        capacityDecision: decision.score ?? {},
        bucketsAvailable: decision.alternatives.length + 1,
        status: "ok",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
      };

      try {
        const res = await adapter.generate(req, bucket.model);
        const reasoning = res.usage.reasoningTokens ?? 0;
        const total = res.usage.inputTokens + res.usage.outputTokens + reasoning;

        record.inputTokens = res.usage.inputTokens;
        record.outputTokens = res.usage.outputTokens;
        record.reasoningTokens = reasoning;
        record.latencyMs = res.latencyMs;
        this.attempts.push(record);

        const stats = (this.usageByProvider[bucket.providerId] ??= {
          dialogueCalls: 0,
          dialogueTokens: 0,
          extractCalls: 0,
          extractTokens: 0,
        });
        if (taskClass === "extract") {
          stats.extractCalls += 1;
          stats.extractTokens += total;
        } else {
          stats.dialogueCalls += 1;
          stats.dialogueTokens += total;
        }

        return fallbackFrom === undefined
          ? res
          : { ...res, fallbackFrom, fallbackReason: fallbackReason ?? null };
      } catch (e) {
        lastError = e;
        const reason = reasonFor(e);
        record.status = reason;
        record.detail = e instanceof Error ? e.message.slice(0, 160) : String(e);
        this.attempts.push(record);

        // The adapter has already reported the outcome to the registry, so the
        // next iteration's schedule() sees this bucket cooling and picks another.
        fallbackFrom = bucket.providerId;
        fallbackReason = reason;
        process.stdout.write(
          `\n        [REROUTE] turn ${String(this.currentTurn)} ${taskClass}: ${bucket.id} → next (${reason}) `,
        );
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new AIError("BUDGET_EXCEEDED", `No capacity for ${taskClass} after ${String(maxAttempts)} attempts`);
  }

  async *stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void> {
    const res = await this.generate(req, model);
    yield { type: "text", delta: res.text };
    for (const call of res.toolCalls) yield { type: "tool_call", call };
    yield { type: "done", response: res };
  }
}

/** Rough, and deliberately so — it feeds admission control, not billing. */
function estimateTokens(req: GenerateRequest): number {
  const chars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4) + req.maxTokens;
}
