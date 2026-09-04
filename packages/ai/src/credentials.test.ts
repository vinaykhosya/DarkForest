import { describe, expect, it } from "vitest";
import { CredentialRegistry, redactKeys } from "./credentials.js";

const T0 = 2_000_000;

// Fake keys, shaped like the real ones so the redaction patterns are exercised.
const ENV = {
  GROQ_API_KEY: "gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,gsk_cccccccccccccccccccccccccccccc",
  OPENROUTER_API_KEY: "sk-or-v1-dddddddddddddddddddddddddddddd",
  GEMINI_API_KEY: "AIzaeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

/**
 * ADR-021: Groq meters PER MODEL, so 3 keys x 4 models = 12 independent
 * buckets. Verified 2026-09-04 — four models on one credential each reported
 * 999/1000 requests remaining, where a shared budget would have shown 996.
 *
 * The numbers below are 4x their pre-ADR-021 values. That multiplication IS the
 * fix: the old model used 25% of Groq's real capacity.
 */
const GROQ_MODELS_METERED = 4;

describe("CredentialRegistry", () => {
  it("creates one bucket per credential x model where the provider meters that way", () => {
    const reg = new CredentialRegistry(ENV, T0);
    expect(reg.snapshot("groq", T0)?.total).toBe(3 * GROQ_MODELS_METERED);
  });

  it("keeps account-wide providers as one bucket per credential", () => {
    // OpenRouter's 50/day is shared across every :free endpoint. Splitting it
    // per model would INVENT capacity — the mirror image of the Groq bug, and
    // the more dangerous direction to get wrong.
    const reg = new CredentialRegistry(ENV, T0);
    expect(reg.snapshot("openrouter", T0)?.total).toBe(1);
  });

  it("labels each bucket with its model, so telemetry can tell them apart", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const ids = reg.snapshot("groq", T0)?.perCredential.map((c) => c.id) ?? [];
    expect(ids.every((id) => id.includes("::"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("treats a single key as a pool of one — no special case", () => {
    const reg = new CredentialRegistry(ENV, T0);
    expect(reg.snapshot("openrouter", T0)?.total).toBe(1);
  });

  it("ignores absent and blank env vars", () => {
    const reg = new CredentialRegistry({ GROQ_API_KEY: "   ", NVIDIA_NIM_API_KEY: undefined }, T0);
    expect(reg.has("groq")).toBe(false);
    expect(reg.has("nvidia")).toBe(false);
  });

  it("tolerates stray whitespace and trailing commas", () => {
    const reg = new CredentialRegistry({ GROQ_API_KEY: " gsk_one , gsk_two ,, " }, T0);
    expect(reg.snapshot("groq", T0)?.total).toBe(2 * GROQ_MODELS_METERED);
  });

  it("hands back a key with its bucket id", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const got = reg.acquire("groq", 100, T0);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.id).toMatch(/^groq-1::/);
      expect(got.key).toMatch(/^gsk_/);
    }
  });

  it("narrows to one model's buckets when a model is named", () => {
    // Without this the pool could hand back a bucket metering a DIFFERENT
    // model's budget, and local accounting would drift from what Groq enforces.
    const reg = new CredentialRegistry(ENV, T0);
    const got = reg.acquire("groq", 100, T0, "openai/gpt-oss-20b");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.id).toContain("openai/gpt-oss-20b");
  });

  it("spreads successive requests across every bucket", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const got = reg.acquire("groq", 1000, T0);
      expect(got.ok).toBe(true);
      if (got.ok) {
        seen.add(got.id);
        reg.reportSuccess(got.id, 1000, T0);
      }
    }
    // All 12 buckets, not just the 3 underlying credentials.
    expect(seen.size).toBe(3 * GROQ_MODELS_METERED);
  });

  it("routes around a rate-limited bucket", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const first = reg.acquire("groq", 100, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    reg.reportRateLimited(first.id, 60_000, T0);
    const next = reg.acquire("groq", 100, T0);
    expect(next.ok && next.id).not.toBe(first.id);
  });

  it("rate-limiting one model does not disable the same credential's other models", () => {
    // The property the whole per-model change rests on.
    const reg = new CredentialRegistry(ENV, T0);
    reg.reportRateLimited("groq-1::openai/gpt-oss-20b", 60_000, T0);
    const other = reg.acquire("groq", 100, T0, "openai/gpt-oss-120b");
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.id).toBe("groq-1::openai/gpt-oss-120b");
  });

  it("stops using a rejected bucket permanently", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const dead = "groq-1::openai/gpt-oss-20b";
    reg.reportRejected(dead, "401 Unauthorized");
    for (let i = 0; i < 5; i++) {
      const got = reg.acquire("groq", 100, T0 + i * 86_400_000, "openai/gpt-oss-20b");
      expect(got.ok && got.id).not.toBe(dead);
    }
    expect(reg.snapshot("groq", T0)?.disabled).toBe(1);
  });

  it("reports why it cannot serve, and when to retry", () => {
    const reg = new CredentialRegistry({ OPENROUTER_API_KEY: "sk-or-v1-x" }, T0);
    reg.reportRateLimited("openrouter-1", 30_000, T0);
    const got = reg.acquire("openrouter", 100, T0);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe("all_cooling");
      expect(got.retryAt).toBe(T0 + 30_000);
    }
  });

  it("reports no_credentials for an unconfigured provider", () => {
    const reg = new CredentialRegistry({}, T0);
    const got = reg.acquire("groq", 100, T0);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("no_credentials");
  });

  it("enforces the per-minute limit across all buckets within a single minute", () => {
    // 3 credentials x 30 rpm = 90 requests available in one minute, then the
    // pool is legitimately out until the window rolls. An earlier version of
    // this test froze the clock and expected the DAILY limit — the failure was
    // the rate limiter working correctly.
    const reg = new CredentialRegistry(ENV, T0);
    let served = 0;
    for (let i = 0; i < 2000; i++) {
      const got = reg.acquire("groq", 0, T0);
      if (!got.ok) {
        expect(got.reason).toBe("all_exhausted");
        break;
      }
      reg.reportSuccess(got.id, 0, T0);
      served += 1;
    }
    // 3 credentials x 4 models x 30 rpm = 360, not 90. That 4x is the fix.
    expect(served).toBe(3 * GROQ_MODELS_METERED * 30);
    for (const c of reg.snapshot("groq", T0)?.perCredential ?? []) {
      expect(c.requestsToday).toBe(30);
    }
  });

  it("recovers capacity when the minute window rolls", () => {
    const reg = new CredentialRegistry(ENV, T0);
    for (let i = 0; i < 3 * GROQ_MODELS_METERED * 30; i++) {
      const got = reg.acquire("groq", 0, T0);
      if (got.ok) reg.reportSuccess(got.id, 0, T0);
    }
    expect(reg.acquire("groq", 0, T0).ok).toBe(false);
    expect(reg.acquire("groq", 0, T0 + 61_000).ok).toBe(true);
  });

  it("reaches the daily limit across every bucket when time advances", () => {
    const reg = new CredentialRegistry(ENV, T0);
    let served = 0;
    let now = T0;
    // 3 credentials x 4 models x 1000 rpd = 12,000, at 360 per minute.
    for (let minute = 0; minute < 40; minute++) {
      for (let i = 0; i < 400; i++) {
        const got = reg.acquire("groq", 0, now);
        if (!got.ok) break;
        reg.reportSuccess(got.id, 0, now);
        served += 1;
      }
      now += 61_000;
    }
    expect(served).toBe(3 * GROQ_MODELS_METERED * 1000);
    // Evenly drained across every bucket, not one at a time.
    for (const c of reg.snapshot("groq", now)?.perCredential ?? []) {
      expect(c.requestsToday).toBe(1000);
    }
  });

  it("never exposes key material in a snapshot", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const serialised = JSON.stringify(reg.snapshotAll(T0));
    expect(serialised).toContain("groq-1");
    expect(serialised).not.toMatch(/gsk_|sk-or-|AIza/);
  });
});

describe("redactKeys", () => {
  it("redacts every provider key format we use", () => {
    const cases = [
      "gsk_EXAMPLEONLYnotarealkey00000000000000",
      "sk-or-v1-EXAMPLEONLYnotarealkey0000000000000000",
      "nvapi-EXAMPLEONLYnotarealkey000000000000",
      "AIzaEXAMPLEONLYnotarealkey0000000000",
      "cfat_EXAMPLEONLYnotarealkey0000000000",
    ];
    for (const key of cases) {
      const out = redactKeys(`request failed with Authorization: ${key} oh dear`);
      expect(out, key).not.toContain(key);
      expect(out).toContain("[redacted]");
    }
  });

  it("redacts a bearer header echoed back in an error message", () => {
    const out = redactKeys('fetch failed: {"authorization":"Bearer abcdefghijklmnopqrstuvwxyz123"}');
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123");
  });

  it("leaves ordinary text alone", () => {
    const text = "Elena hid the cloak beneath the floorboards.";
    expect(redactKeys(text)).toBe(text);
  });
});
