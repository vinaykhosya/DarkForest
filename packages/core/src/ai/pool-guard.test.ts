import { describe, expect, it } from "vitest";
import { poolsFor, type ModelDescriptor, type ModelPolicy } from "@darkforest/contracts";
import { checkPoolEligibility, eligibleModels, poolRequiresDisclosure } from "./pool-guard.js";

/**
 * These tests encode the three real provider situations we verified on
 * 2026-09-03. They are not hypothetical fixtures — if a future change lets the
 * NVIDIA case route to a real user, that is a compliance failure, and this file
 * is what catches it.
 */

const GROQ_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  retentionDays: 30,
  source: "Groq Services Agreement — End User license grant; no-training clause",
  verifiedOn: "2026-09-03",
};

const NVIDIA_POLICY: ModelPolicy = {
  eligibility: "development_only",
  trainsOnInput: true,
  forbidsPersonalData: true,
  retentionDays: 30,
  contentRestrictions: "§2.6(d) prohibits obscene, pornographic, vulgar or offensive content",
  source: "NVIDIA API Trial ToS §1.2, §1.4, §2.6(a), §3.3 (verified 2026-09-03)",
  verifiedOn: "2026-09-03",
};

const GEMINI_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: true,
  forbidsPersonalData: true,
  retentionDays: 30,
  source: "Gemini API Additional Terms — Unpaid Services",
  verifiedOn: "2026-09-03",
};

function model(id: string, policy: ModelPolicy, qualityScore?: number): ModelDescriptor {
  return {
    id,
    tier: "standard",
    pools: poolsFor(policy),
    policy,
    contextWindow: 128_000,
    maxOutput: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    isFree: true,
    ...(qualityScore === undefined ? {} : { qualityScore }),
  };
}

describe("poolsFor", () => {
  it("puts a production + no-training provider in every pool", () => {
    expect(poolsFor(GROQ_POLICY)).toEqual(["private", "standard", "development"]);
  });

  it("keeps a training provider out of the private pool", () => {
    expect(poolsFor(GEMINI_POLICY)).toEqual(["standard", "development"]);
  });

  it("confines a development-only provider to the development pool", () => {
    expect(poolsFor(NVIDIA_POLICY)).toEqual(["development"]);
  });

  it("ignores training status when terms forbid production entirely", () => {
    // Contractual eligibility is checked first and independently. A provider that
    // forbids production stays development-only even with a perfect privacy stance.
    const privateButDevOnly: ModelPolicy = { ...NVIDIA_POLICY, trainsOnInput: false };
    expect(poolsFor(privateButDevOnly)).toEqual(["development"]);
  });
});

describe("checkPoolEligibility — the NVIDIA case", () => {
  const nvidia = model("nv", NVIDIA_POLICY, 8.0);

  it("blocks a development-only model from production, however good it is", () => {
    const result = checkPoolEligibility(nvidia, { pool: "standard", environment: "production" });
    expect(result?.reason).toBe("terms_forbid_production");
  });

  it("blocks it in staging too", () => {
    expect(
      checkPoolEligibility(nvidia, { pool: "standard", environment: "staging" })?.reason,
    ).toBe("terms_forbid_production");
  });

  it("blocks it even from the private pool", () => {
    expect(
      checkPoolEligibility(nvidia, { pool: "private", environment: "production" })?.reason,
    ).toBe("terms_forbid_production");
  });

  it("blocks real content locally — local is not a blanket exemption", () => {
    expect(
      checkPoolEligibility(nvidia, { pool: "development", environment: "local" })?.reason,
    ).toBe("terms_forbid_production");
  });

  it("permits it only for synthetic content in local development", () => {
    expect(
      checkPoolEligibility(nvidia, {
        pool: "development",
        environment: "local",
        isSyntheticContent: true,
      }),
    ).toBeNull();
  });

  it("fails closed when the synthetic flag is omitted", () => {
    // Forgetting the flag must deny, not allow.
    expect(
      checkPoolEligibility(nvidia, { pool: "development", environment: "local" }),
    ).not.toBeNull();
  });

  it("cites the governing clause in the rejection", () => {
    const result = checkPoolEligibility(nvidia, { pool: "standard", environment: "production" });
    expect(result?.detail).toContain("§1.2");
  });
});

describe("checkPoolEligibility — pools", () => {
  it("admits a privacy-clean production provider to the private pool", () => {
    expect(
      checkPoolEligibility(model("groq", GROQ_POLICY, 8.2), {
        pool: "private",
        environment: "production",
      }),
    ).toBeNull();
  });

  it("keeps a training provider out of the private pool", () => {
    expect(
      checkPoolEligibility(model("gem", GEMINI_POLICY, 8.5), {
        pool: "private",
        environment: "production",
      })?.reason,
    ).toBe("not_in_pool");
  });

  it("admits a training provider to the standard pool", () => {
    expect(
      checkPoolEligibility(model("gem", GEMINI_POLICY, 8.5), {
        pool: "standard",
        environment: "production",
      }),
    ).toBeNull();
  });
});

describe("checkPoolEligibility — benchmark requirement", () => {
  it("refuses an unbenchmarked model in production", () => {
    expect(
      checkPoolEligibility(model("new", GROQ_POLICY), {
        pool: "standard",
        environment: "production",
      })?.reason,
    ).toBe("not_benchmarked");
  });

  it("allows an unbenchmarked model locally, so it can be benchmarked", () => {
    expect(
      checkPoolEligibility(model("new", GROQ_POLICY), { pool: "standard", environment: "local" }),
    ).toBeNull();
  });
});

describe("eligibleModels", () => {
  it("filters a mixed registry down to what may actually serve the request", () => {
    const registry = [
      model("groq", GROQ_POLICY, 8.2),
      model("gemini", GEMINI_POLICY, 8.5),
      model("nvidia", NVIDIA_POLICY, 8.0),
    ];

    const priv = eligibleModels(registry, { pool: "private", environment: "production" });
    expect(priv.map((m) => m.id)).toEqual(["groq"]);

    const std = eligibleModels(registry, { pool: "standard", environment: "production" });
    expect(std.map((m) => m.id)).toEqual(["groq", "gemini"]);
    expect(std.map((m) => m.id)).not.toContain("nvidia");
  });
});

describe("poolRequiresDisclosure", () => {
  it("requires disclosure when any pool member trains on input", () => {
    expect(poolRequiresDisclosure([model("groq", GROQ_POLICY), model("gem", GEMINI_POLICY)])).toBe(
      true,
    );
  });

  it("requires none when every member is privacy-clean", () => {
    expect(poolRequiresDisclosure([model("groq", GROQ_POLICY)])).toBe(false);
  });
});
