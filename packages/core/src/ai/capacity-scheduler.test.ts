import { describe, expect, it } from "vitest";
import { poolsFor, type ModelDescriptor, type ModelPolicy } from "@darkforest/contracts";
import { createCredentialState, recordSuccess, recordRejected } from "./credential-pool.js";
import { overview, schedule, type CapacityBucket } from "./capacity-scheduler.js";

const T0 = 1_000_000;

const PRODUCTION: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  retentionDays: 30,
  source: "test",
  verifiedOn: "2026-09-04",
};

const DEV_ONLY: ModelPolicy = {
  eligibility: "development_only",
  trainsOnInput: true,
  forbidsPersonalData: true,
  retentionDays: 30,
  source: "NVIDIA API Trial ToS §1.2/§1.4",
  verifiedOn: "2026-09-03",
};

function model(
  id: string,
  policy: ModelPolicy,
  over: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    id,
    tier: "fast",
    pools: poolsFor(policy),
    policy,
    contextWindow: 8_000,
    maxOutput: 2048,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    isFree: true,
    qualityScore: 7,
    ...over,
  };
}

function bucket(
  providerId: string,
  modelId: string,
  credIndex: number,
  policy: ModelPolicy = PRODUCTION,
  modelOver: Partial<ModelDescriptor> = {},
): CapacityBucket {
  return {
    id: `${providerId}:${modelId}:${providerId}-${String(credIndex)}`,
    providerId,
    model: model(modelId, policy, modelOver),
    state: createCredentialState(
      `${providerId}-${String(credIndex)}`,
      providerId,
      { rpm: 30, rpd: 1000, tpm: 8000 },
      T0,
      modelId,
    ),
  };
}

const intent = {
  pool: "standard" as const,
  environment: "local" as const,
  estimatedTokens: 1000,
};

describe("schedule — capacity is keyed per model, not per credential", () => {
  it("treats the same credential on two models as two independent buckets", () => {
    // The measured fact this whole change rests on: four Groq models on ONE
    // credential each reported 999/1000 remaining. Exhausting one must not
    // exhaust the other.
    let a = bucket("groq", "model-a", 1);
    const b = bucket("groq", "model-b", 1);

    // Drain model-a's minute budget entirely.
    for (let i = 0; i < 30; i++) a = { ...a, state: recordSuccess(a.state, T0, 10) };

    const d = schedule([a, b], intent, T0);
    expect(d.bucket?.model.id).toBe("model-b");
    expect(d.rejected.find((r) => r.bucketId === a.id)?.reason).toBe("no_capacity");
  });

  it("spreads independent requests across every bucket instead of draining one", () => {
    let buckets = [
      bucket("groq", "g1", 1),
      bucket("groq", "g2", 1),
      bucket("gemini", "gem1", 1),
      bucket("openrouter", "or1", 1),
    ];

    const chosenBuckets: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = schedule(buckets, intent, T0);
      expect(d.bucket).not.toBeNull();
      chosenBuckets.push(d.bucket!.id);
      buckets = buckets.map((b) =>
        b.id === d.bucket!.id ? { ...b, state: recordSuccess(b.state, T0, 500) } : b,
      );
    }

    // Distribution is per BUCKET, not per provider. Groq legitimately carries
    // twice the load here because it contributes two of the four buckets —
    // that is the point of metering per model.
    const counts = new Map<string, number>();
    for (const id of chosenBuckets) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.size).toBe(4);
    for (const n of counts.values()) expect(n).toBe(3);
  });

  it("does not stall when one provider is exhausted — it routes onward", () => {
    // The specific behaviour asked for: Groq unavailable must not block.
    let groq = bucket("groq", "g1", 1);
    for (let i = 0; i < 30; i++) groq = { ...groq, state: recordSuccess(groq.state, T0, 10) };
    const nvidia = bucket("nvidia", "nv1", 1, DEV_ONLY);

    // Dev-only models live ONLY in the development pool, so a development
    // workload must ask for it by name. That is deliberate: it forces the
    // production boundary to be explicit at the call site rather than implied.
    const d = schedule(
      [groq, nvidia],
      { ...intent, pool: "development", isSyntheticContent: true },
      T0,
    );
    expect(d.bucket?.providerId).toBe("nvidia");
  });
});

describe("schedule — eligibility is settled before capacity", () => {
  it("never selects a development-only model in production, however idle", () => {
    const nvidia = bucket("nvidia", "nv1", 1, DEV_ONLY);
    const d = schedule([nvidia], { ...intent, environment: "production" }, T0);
    expect(d.bucket).toBeNull();
    expect(d.rejected[0]?.reason).toBe("terms_forbid_production");
  });

  it("allows a development-only model in the development pool, locally, with synthetic content", () => {
    const nvidia = bucket("nvidia", "nv1", 1, DEV_ONLY);
    const d = schedule(
      [nvidia],
      { ...intent, pool: "development", isSyntheticContent: true },
      T0,
    );
    expect(d.bucket?.providerId).toBe("nvidia");
  });

  it("refuses a development-only model even in the development pool without the synthetic flag", () => {
    // Fails closed: forgetting the flag must deny, never allow.
    const nvidia = bucket("nvidia", "nv1", 1, DEV_ONLY);
    const d = schedule([nvidia], { ...intent, pool: "development" }, T0);
    expect(d.bucket).toBeNull();
    expect(d.rejected[0]?.reason).toBe("terms_forbid_production");
  });

  it("refuses a development-only model in the standard pool, even locally", () => {
    // NVIDIA must never leak into a pool that serves users.
    const nvidia = bucket("nvidia", "nv1", 1, DEV_ONLY);
    const d = schedule([nvidia], { ...intent, pool: "standard", isSyntheticContent: true }, T0);
    expect(d.bucket).toBeNull();
    expect(d.rejected[0]?.reason).toBe("not_in_pool");
  });

  it("keeps a training provider out of the private pool", () => {
    const training: ModelPolicy = { ...PRODUCTION, trainsOnInput: true };
    const gem = bucket("gemini", "gem1", 1, training);
    const d = schedule([gem], { ...intent, pool: "private" }, T0);
    expect(d.bucket).toBeNull();
    expect(d.rejected[0]?.reason).toBe("not_in_pool");
  });
});

describe("schedule — capability filtering", () => {
  it("skips a model without structured output when the task needs it", () => {
    const noJson = bucket("openrouter", "nemotron", 1, PRODUCTION, {
      supportsStructuredOutput: false,
    });
    const withJson = bucket("groq", "gpt-oss", 1);
    const d = schedule([noJson, withJson], { ...intent, needsStructuredOutput: true }, T0);
    expect(d.bucket?.providerId).toBe("groq");
    expect(d.rejected[0]?.reason).toBe("missing_structured_output");
  });

  it("skips a model whose ceiling cannot fit the request", () => {
    // An oversize call still consumes a daily request, so rejecting locally is
    // strictly cheaper than a round trip.
    const small = bucket("groq", "small", 1, PRODUCTION, { contextWindow: 8_000 });
    const large = bucket("openrouter", "large", 1, PRODUCTION, { contextWindow: 1_000_000 });
    const d = schedule([small, large], { ...intent, requiredContextWindow: 30_000 }, T0);
    expect(d.bucket?.providerId).toBe("openrouter");
    expect(d.rejected[0]?.reason).toBe("context_too_small");
  });

  it("honours a tier restriction", () => {
    const deep = bucket("openrouter", "deep1", 1, PRODUCTION, { tier: "deep" });
    const fast = bucket("groq", "fast1", 1, PRODUCTION, { tier: "fast" });
    const d = schedule([deep, fast], { ...intent, tiers: ["deep"] }, T0);
    expect(d.bucket?.model.tier).toBe("deep");
  });
});

describe("schedule — scoring", () => {
  it("prefers an idle lower-quality model over a saturated better one", () => {
    // A request that cannot run has no quality at all.
    let good = bucket("groq", "good", 1, PRODUCTION, { qualityScore: 9 });
    for (let i = 0; i < 25; i++) good = { ...good, state: recordSuccess(good.state, T0, 250) };
    const idle = bucket("gemini", "ok", 1, PRODUCTION, { qualityScore: 6 });

    expect(schedule([good, idle], intent, T0).bucket?.providerId).toBe("gemini");
  });

  it("prefers higher quality when headroom is equal", () => {
    const better = bucket("groq", "better", 1, PRODUCTION, { qualityScore: 9 });
    const worse = bucket("gemini", "worse", 1, PRODUCTION, { qualityScore: 4 });
    expect(schedule([better, worse], intent, T0).bucket?.model.id).toBe("better");
  });

  it("penalises a bucket with recent failures", () => {
    const flaky = {
      ...bucket("groq", "flaky", 1),
      state: { ...bucket("groq", "flaky", 1).state, consecutiveFailures: 3 },
    };
    const healthy = bucket("gemini", "healthy", 1);
    expect(schedule([flaky, healthy], intent, T0).bucket?.providerId).toBe("gemini");
  });

  it("returns ranked alternatives for the caller to retry down", () => {
    const d = schedule(
      [bucket("groq", "a", 1), bucket("gemini", "b", 1), bucket("openrouter", "c", 1)],
      intent,
      T0,
    );
    expect(d.alternatives).toHaveLength(2);
    expect(d.alternatives.map((a) => a.id)).not.toContain(d.bucket?.id);
  });

  it("explains every rejection, so 'why this one?' is answerable", () => {
    const d = schedule(
      [bucket("nvidia", "nv", 1, DEV_ONLY), bucket("groq", "g", 1)],
      { ...intent, environment: "production" },
      T0,
    );
    expect(d.rejected).toHaveLength(1);
    expect(d.rejected[0]?.detail).toContain("§1.2");
  });
});

describe("schedule — exhaustion", () => {
  it("reports retryAt rather than failing silently", () => {
    let b = bucket("groq", "g", 1);
    for (let i = 0; i < 30; i++) b = { ...b, state: recordSuccess(b.state, T0, 10) };
    const d = schedule([b], intent, T0);
    expect(d.bucket).toBeNull();
    expect(d.retryAt).toBeGreaterThan(T0);
  });

  it("ignores permanently disabled buckets when computing retryAt", () => {
    const dead = { ...bucket("groq", "g", 1) };
    dead.state = recordRejected(dead.state, "401");
    const d = schedule([dead], intent, T0);
    expect(d.bucket).toBeNull();
    expect(d.retryAt).toBeUndefined();
  });

  it("handles an empty bucket list", () => {
    const d = schedule([], intent, T0);
    expect(d.bucket).toBeNull();
    expect(d.alternatives).toEqual([]);
  });
});

describe("overview", () => {
  it("reports capacity per provider with the models each contributes", () => {
    const o = overview(
      [
        bucket("groq", "g1", 1),
        bucket("groq", "g2", 1),
        bucket("groq", "g1", 2),
        bucket("gemini", "gem", 1),
      ],
      T0,
    );
    expect(o.totalBuckets).toBe(4);
    expect(o.availableBuckets).toBe(4);
    expect(o.byProvider["groq"]?.buckets).toBe(3);
    expect(o.byProvider["groq"]?.models.sort()).toEqual(["g1", "g2"]);
    expect(o.aggregateHeadroom).toBeCloseTo(1, 5);
  });

  it("excludes disabled buckets from aggregate headroom", () => {
    const dead = { ...bucket("groq", "g", 1) };
    dead.state = recordRejected(dead.state, "401");
    const o = overview([dead, bucket("gemini", "gem", 1)], T0);
    expect(o.aggregateHeadroom).toBe(1);
  });
});
