import { describe, expect, it } from "vitest";
import { CredentialRegistry, redactKeys } from "./credentials.js";

const T0 = 2_000_000;

// Fake keys, shaped like the real ones so the redaction patterns are exercised.
const ENV = {
  GROQ_API_KEY: "gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,gsk_cccccccccccccccccccccccccccccc",
  OPENROUTER_API_KEY: "sk-or-v1-dddddddddddddddddddddddddddddd",
  GEMINI_API_KEY: "AIzaeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

describe("CredentialRegistry", () => {
  it("parses a comma-separated list into separate credentials", () => {
    const reg = new CredentialRegistry(ENV, T0);
    expect(reg.snapshot("groq", T0)?.total).toBe(3);
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
    expect(reg.snapshot("groq", T0)?.total).toBe(2);
  });

  it("hands back a key with its id", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const got = reg.acquire("groq", 100, T0);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.id).toBe("groq-1");
      expect(got.key).toMatch(/^gsk_/);
    }
  });

  it("spreads successive requests across the pool", () => {
    const reg = new CredentialRegistry(ENV, T0);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const got = reg.acquire("groq", 1000, T0);
      expect(got.ok).toBe(true);
      if (got.ok) {
        seen.add(got.id);
        reg.reportSuccess(got.id, 1000, T0);
      }
    }
    expect(seen).toEqual(new Set(["groq-1", "groq-2", "groq-3"]));
  });

  it("routes around a rate-limited credential", () => {
    const reg = new CredentialRegistry(ENV, T0);
    reg.reportRateLimited("groq-1", 60_000, T0);
    const got = reg.acquire("groq", 100, T0);
    expect(got.ok && got.id).not.toBe("groq-1");
  });

  it("stops using a rejected credential permanently", () => {
    const reg = new CredentialRegistry(ENV, T0);
    reg.reportRejected("groq-1", "401 Unauthorized");
    for (let i = 0; i < 5; i++) {
      const got = reg.acquire("groq", 100, T0 + i * 86_400_000);
      expect(got.ok && got.id).not.toBe("groq-1");
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

  it("enforces the per-minute limit within a single minute", () => {
    // 3 credentials x 30 rpm = 90 requests available in one minute, then the
    // pool is legitimately out until the window rolls. An earlier version of
    // this test froze the clock and expected the DAILY limit — the failure was
    // the rate limiter working correctly.
    const reg = new CredentialRegistry(ENV, T0);
    let served = 0;
    for (let i = 0; i < 500; i++) {
      const got = reg.acquire("groq", 0, T0);
      if (!got.ok) {
        expect(got.reason).toBe("all_exhausted");
        break;
      }
      reg.reportSuccess(got.id, 0, T0);
      served += 1;
    }
    expect(served).toBe(90);
    for (const c of reg.snapshot("groq", T0)?.perCredential ?? []) {
      expect(c.requestsToday).toBe(30);
    }
  });

  it("recovers capacity when the minute window rolls", () => {
    const reg = new CredentialRegistry(ENV, T0);
    for (let i = 0; i < 90; i++) {
      const got = reg.acquire("groq", 0, T0);
      if (got.ok) reg.reportSuccess(got.id, 0, T0);
    }
    expect(reg.acquire("groq", 0, T0).ok).toBe(false);
    expect(reg.acquire("groq", 0, T0 + 61_000).ok).toBe(true);
  });

  it("reaches the daily limit across the whole pool when time advances", () => {
    const reg = new CredentialRegistry(ENV, T0);
    let served = 0;
    let now = T0;
    // 3 credentials x 1000 rpd = 3000, at 90 per minute.
    for (let minute = 0; minute < 60; minute++) {
      for (let i = 0; i < 200; i++) {
        const got = reg.acquire("groq", 0, now);
        if (!got.ok) break;
        reg.reportSuccess(got.id, 0, now);
        served += 1;
      }
      now += 61_000;
    }
    expect(served).toBe(3000);
    // Evenly drained, not 1000-1000-1000 in sequence.
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
