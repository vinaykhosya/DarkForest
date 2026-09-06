import { describe, expect, it } from "vitest";
import { TaskClassSchema, type ModelDescriptor } from "@darkforest/contracts";
import { buildCapacityBuckets } from "./capacity.js";
import { CredentialRegistry } from "./credentials.js";
import { GROQ_DIALOGUE_MODELS } from "./registry/models.js";

const T0 = 2_000_000;

const ENV = {
  GROQ_API_KEY: "gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  OPENROUTER_API_KEY: "sk-or-v1-dddddddddddddddddddddddddddddd",
};

function model(id: string): ModelDescriptor {
  return {
    id,
    tier: "fast",
    pools: ["standard"],
    policy: {
      eligibility: "production",
      trainsOnInput: false,
      forbidsPersonalData: false,
      retentionDays: 0,
      source: "test",
      verifiedOn: "2026-09-04",
    },
    contextWindow: 8_000,
    maxOutput: 1024,
    supportsTools: true,
    supportsStreaming: true,
    verifiedTaskClasses: TaskClassSchema.options,
    supportsStructuredOutput: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    isFree: true,
    qualityScore: 7,
  };
}

const GROQ_SOURCE = { id: "groq", models: GROQ_DIALOGUE_MODELS.map(model) };
const OPENROUTER_SOURCE = { id: "openrouter", models: [model("some/free-model")] };

describe("buildCapacityBuckets", () => {
  it("uses the provider's declared limits, never a hardcoded default", () => {
    // The bug this function exists to prevent: callers assembling buckets
    // themselves and guessing {rpm:30, rpd:1000, tpm:8000} for every provider.
    // That is Groq's shape; OpenRouter is 20/min and 50/day with no token cap.
    const reg = new CredentialRegistry(ENV, T0);
    const buckets = buildCapacityBuckets(reg, [GROQ_SOURCE, OPENROUTER_SOURCE]);

    const groq = buckets.find((b) => b.providerId === "groq");
    const or = buckets.find((b) => b.providerId === "openrouter");
    expect(groq?.state.limits).toEqual({ rpm: 30, rpd: 1000, tpm: 8000 });
    expect(or?.state.limits).toEqual({ rpm: 20, rpd: 50 });
    // Groq's tpd is deliberately absent — no observable header supports one.
    expect(groq?.state.limits.tpd).toBeUndefined();
  });

  it("creates one bucket per credential x model for a per-model-metered provider", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const buckets = buildCapacityBuckets(reg, [GROQ_SOURCE]);
    expect(buckets).toHaveLength(2 * GROQ_DIALOGUE_MODELS.length);
    expect(new Set(buckets.map((b) => b.id)).size).toBe(buckets.length);
    // Each bucket meters exactly the model it names.
    for (const b of buckets) expect(b.state.modelId).toBe(b.model.id);
  });

  it("creates one bucket per credential for an account-wide provider", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const buckets = buildCapacityBuckets(reg, [OPENROUTER_SOURCE]);
    expect(buckets).toHaveLength(1);
  });

  it("REFUSES to split an account-wide provider across several models", () => {
    /*
     * The dangerous direction. Splitting a shared 50/day budget per model would
     * show the scheduler N independent buckets backed by one budget — inventing
     * capacity, which fails as a confident 429 rather than as unused headroom.
     * Refusing is correct: the fix is to verify the metering and declare it.
     */
    const reg = new CredentialRegistry(ENV, T0);
    expect(() =>
      buildCapacityBuckets(reg, [
        { id: "openrouter", models: [model("free/a"), model("free/b")] },
      ]),
    ).toThrow(/metered account-wide/);
  });

  it("omits providers that have credentials but no wired adapter", () => {
    // Absent rather than silently failing at call time.
    const reg = new CredentialRegistry({ ...ENV, NVIDIA_NIM_API_KEY: "nvapi-x" }, T0);
    const buckets = buildCapacityBuckets(reg, [GROQ_SOURCE]);
    expect(buckets.every((b) => b.providerId === "groq")).toBe(true);
  });

  it("carries live counters, so a drained bucket is visible to the scheduler", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const first = reg.acquire("groq", 500, T0, GROQ_DIALOGUE_MODELS[0]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    reg.reportSuccess(first.id, 500, T0);

    const buckets = buildCapacityBuckets(reg, [GROQ_SOURCE]);
    const used = buckets.find((b) => b.state.id === first.id);
    expect(used?.state.tokensThisMinute).toBe(500);
    expect(used?.state.requestsToday).toBe(1);
  });

  it("never carries key material into a bucket", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const serialised = JSON.stringify(buildCapacityBuckets(reg, [GROQ_SOURCE, OPENROUTER_SOURCE]));
    expect(serialised).not.toMatch(/gsk_|sk-or-/);
  });
});
