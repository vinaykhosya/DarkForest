import type { InferencePool, ModelDescriptor } from "@darkforest/contracts";
import { checkPoolEligibility, type Environment } from "./pool-guard.js";
import { headroom, isAvailable, type CredentialState } from "./credential-pool.js";

/**
 * Capacity-aware multi-provider scheduler — ADR-021.
 *
 * WHAT CHANGED AND WHY
 * The router previously thought in terms of `provider → credential`, with Groq
 * as primary and everything else as fallback. Two things were wrong with that:
 *
 *  1. Groq's rate limits are PER MODEL, verified 2026-09-04: four models on one
 *     credential each reported 999/1000 requests remaining. Metering them as a
 *     single per-credential bucket used 25% of Groq's real capacity.
 *
 *  2. Treating other providers as fallback means they sit idle until Groq is
 *     exhausted, then absorb a thundering herd. Suite 1 run 3 scored 70% (vs 91%
 *     and 84%) with six rate-limit retries and Groq down to 2/8 credentials —
 *     capacity pressure was measurably degrading RECALL.
 *
 * So capacity is now keyed:
 *
 *     provider → model → credential → bucket
 *
 * and independent requests are spread across all eligible buckets concurrently.
 *
 * WHAT THIS IS NOT
 * This does not fan one request out to several providers. That would multiply
 * cost for a single answer. It distributes INDEPENDENT requests across
 * INDEPENDENT capacity.
 *
 * Pure: no I/O, no clock of its own. `now` is always passed in.
 */

export interface CapacityBucket {
  /** Stable identity: "groq:openai/gpt-oss-20b:groq-3". Safe to log. */
  id: string;
  providerId: string;
  model: ModelDescriptor;
  /** The metered state for this (provider, model, credential) triple. */
  state: CredentialState;
}

export interface SchedulingIntent {
  /** Which inference pool the caller's plan entitles them to. */
  pool: InferencePool;
  environment: Environment;
  isSyntheticContent?: boolean;
  estimatedTokens: number;
  /** Model must support tool calling. */
  needsTools?: boolean;
  /** Model must support schema-constrained output. */
  needsStructuredOutput?: boolean;
  /** Reject models whose per-request ceiling cannot fit this request. */
  requiredContextWindow?: number;
  /** Restrict to these tiers, in order of preference. Empty = any tier. */
  tiers?: readonly ModelDescriptor["tier"][];
}

export type RejectionReason =
  | "terms_forbid_production"
  | "not_in_pool"
  | "not_benchmarked"
  | "missing_tools"
  | "missing_structured_output"
  | "context_too_small"
  | "wrong_tier"
  | "no_capacity";

export interface BucketRejection {
  bucketId: string;
  reason: RejectionReason;
  detail: string;
}

export interface SchedulingDecision {
  bucket: CapacityBucket | null;
  /** Score components for the chosen bucket. Recorded in telemetry. */
  score?: Record<string, number>;
  /** Every bucket that was considered and why it lost. Explains "why this one?". */
  rejected: BucketRejection[];
  /** Ranked runners-up. The caller retries down this list on failure. */
  alternatives: CapacityBucket[];
  /** When nothing is available, the earliest moment something frees up. */
  retryAt?: number;
}

/**
 * Scoring weights.
 *
 * Headroom dominates deliberately: the whole point is to spread load rather
 * than drain one bucket. Quality is a tiebreak, not a preference — an idle
 * lower-quality model beats a saturated better one, because a request that
 * cannot run has no quality at all.
 */
export interface SchedulerWeights {
  headroom: number;
  quality: number;
  tierPreference: number;
  /** Penalty for a bucket that recently failed, even though it is not cooling. */
  recentFailure: number;
}

export const DEFAULT_SCHEDULER_WEIGHTS: Readonly<SchedulerWeights> = Object.freeze({
  headroom: 0.55,
  quality: 0.2,
  tierPreference: 0.2,
  recentFailure: 0.25,
});

function capabilityRejection(
  bucket: CapacityBucket,
  intent: SchedulingIntent,
): BucketRejection | null {
  const m = bucket.model;

  if (intent.needsTools === true && !m.supportsTools) {
    return { bucketId: bucket.id, reason: "missing_tools", detail: `${m.id} has no tool calling` };
  }
  if (intent.needsStructuredOutput === true && !m.supportsStructuredOutput) {
    return {
      bucketId: bucket.id,
      reason: "missing_structured_output",
      detail: `${m.id} has no response_format`,
    };
  }
  // A request larger than the model's per-request ceiling is rejected here
  // rather than spent: an oversize call still consumes a daily request.
  const needed = intent.requiredContextWindow ?? intent.estimatedTokens;
  if (needed > m.contextWindow) {
    return {
      bucketId: bucket.id,
      reason: "context_too_small",
      detail: `needs ${String(needed)} tok, ${m.id} ceiling is ${String(m.contextWindow)}`,
    };
  }
  if (intent.tiers !== undefined && intent.tiers.length > 0 && !intent.tiers.includes(m.tier)) {
    return {
      bucketId: bucket.id,
      reason: "wrong_tier",
      detail: `${m.tier} not in [${intent.tiers.join(", ")}]`,
    };
  }
  return null;
}

/**
 * Chooses the best currently-available capacity bucket across ALL providers.
 *
 * Order of checks matters: eligibility (terms, pool, benchmarking) is settled
 * before capability, and capability before capacity. A model we may not legally
 * use should never appear in a capacity comparison at all.
 */
export function schedule(
  buckets: readonly CapacityBucket[],
  intent: SchedulingIntent,
  now: number,
  weights: Partial<SchedulerWeights> = {},
): SchedulingDecision {
  const w: SchedulerWeights = { ...DEFAULT_SCHEDULER_WEIGHTS, ...weights };
  const rejected: BucketRejection[] = [];
  const viable: Array<{ bucket: CapacityBucket; score: number; parts: Record<string, number> }> = [];

  for (const bucket of buckets) {
    // 1. Terms and pool eligibility — ADR-013 / ADR-014, unchanged.
    const eligibility = checkPoolEligibility(bucket.model, {
      pool: intent.pool,
      environment: intent.environment,
      ...(intent.isSyntheticContent === undefined
        ? {}
        : { isSyntheticContent: intent.isSyntheticContent }),
    });
    if (eligibility !== null) {
      rejected.push({
        bucketId: bucket.id,
        reason: eligibility.reason,
        detail: eligibility.detail,
      });
      continue;
    }

    // 2. Capability.
    const capability = capabilityRejection(bucket, intent);
    if (capability !== null) {
      rejected.push(capability);
      continue;
    }

    // 3. Capacity.
    if (!isAvailable(bucket.state, now, intent.estimatedTokens)) {
      rejected.push({
        bucketId: bucket.id,
        reason: "no_capacity",
        detail: bucket.state.disabled
          ? `disabled: ${bucket.state.disabledReason ?? "unknown"}`
          : bucket.state.cooldownUntil !== null && now < bucket.state.cooldownUntil
            ? `cooling for ${String(bucket.state.cooldownUntil - now)}ms`
            : "quota exhausted",
      });
      continue;
    }

    const h = headroom(bucket.state, now);
    // Unbenchmarked models are permitted outside production by the guard above;
    // score them mid-range so they are usable but not preferred.
    const quality = (bucket.model.qualityScore ?? 5) / 10;
    const tierRank =
      intent.tiers === undefined || intent.tiers.length === 0
        ? 1
        : 1 - intent.tiers.indexOf(bucket.model.tier) / Math.max(1, intent.tiers.length);
    const failurePenalty = Math.min(1, bucket.state.consecutiveFailures / 3);

    const parts = {
      headroom: w.headroom * h,
      quality: w.quality * quality,
      tierPreference: w.tierPreference * tierRank,
      recentFailure: -w.recentFailure * failurePenalty,
    };
    const score = Object.values(parts).reduce((a, b) => a + b, 0);
    viable.push({ bucket, score, parts });
  }

  if (viable.length === 0) {
    // Earliest relief across everything that is merely cooling or exhausted,
    // ignoring buckets that are permanently disabled or structurally ineligible.
    const recoverable = buckets.filter((b) => !b.state.disabled);
    const retryAt =
      recoverable.length === 0
        ? undefined
        : Math.min(
            ...recoverable.map((b) =>
              b.state.cooldownUntil !== null && b.state.cooldownUntil > now
                ? b.state.cooldownUntil
                : b.state.minuteWindowStart + 60_000,
            ),
          );
    return {
      bucket: null,
      rejected,
      alternatives: [],
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }

  viable.sort((a, b) => b.score - a.score);
  const winner = viable[0];
  // viable is non-empty here (checked above), expressed as narrowing rather
  // than an assertion.
  if (winner === undefined) return { bucket: null, rejected, alternatives: [] };

  return {
    bucket: winner.bucket,
    score: winner.parts,
    rejected,
    alternatives: viable.slice(1).map((v) => v.bucket),
  };
}

/**
 * Aggregate view across every bucket, for the capacity report and for ADR-018's
 * degradation thresholds.
 */
export interface CapacityOverview {
  totalBuckets: number;
  availableBuckets: number;
  byProvider: Record<
    string,
    { buckets: number; available: number; headroom: number; models: string[] }
  >;
  /** Mean headroom across every non-disabled bucket. */
  aggregateHeadroom: number;
}

export function overview(buckets: readonly CapacityBucket[], now: number): CapacityOverview {
  const byProvider: CapacityOverview["byProvider"] = {};
  let headroomSum = 0;
  let active = 0;
  let available = 0;

  for (const b of buckets) {
    const entry = (byProvider[b.providerId] ??= {
      buckets: 0,
      available: 0,
      headroom: 0,
      models: [],
    });
    entry.buckets += 1;
    if (!entry.models.includes(b.model.id)) entry.models.push(b.model.id);

    if (b.state.disabled) continue;
    active += 1;
    const h = headroom(b.state, now);
    headroomSum += h;
    entry.headroom += h;
    if (isAvailable(b.state, now)) {
      entry.available += 1;
      available += 1;
    }
  }

  for (const entry of Object.values(byProvider)) {
    entry.headroom = entry.buckets === 0 ? 0 : entry.headroom / entry.buckets;
  }

  return {
    totalBuckets: buckets.length,
    availableBuckets: available,
    byProvider,
    aggregateHeadroom: active === 0 ? 0 : headroomSum / active,
  };
}
