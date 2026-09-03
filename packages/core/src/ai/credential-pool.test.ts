import { describe, expect, it } from "vitest";
import {
  createCredentialState,
  headroom,
  isAvailable,
  recordFailure,
  recordRateLimited,
  recordRejected,
  recordSuccess,
  rollWindows,
  selectCredential,
  snapshotPool,
  type CredentialLimits,
  type CredentialState,
} from "./credential-pool.js";

const T0 = 1_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

// Groq's real per-key free-tier shape.
const GROQ: CredentialLimits = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 };

function pool(n: number, limits: CredentialLimits = GROQ): CredentialState[] {
  return Array.from({ length: n }, (_, i) =>
    createCredentialState(`groq-${String(i + 1)}`, "groq", limits, T0),
  );
}

describe("headroom", () => {
  it("is 1 for an untouched credential", () => {
    expect(headroom(pool(1)[0]!, T0)).toBe(1);
  });

  it("takes the MINIMUM across limits, not the average", () => {
    // Per-minute tokens spent but daily budget healthy: this credential is not
    // usable right now, and averaging would hide that.
    let c = pool(1)[0]!;
    c = { ...c, tokensThisMinute: 8000 };
    expect(headroom(c, T0)).toBe(0);
  });

  it("compares fairly across different budget sizes", () => {
    const big = createCredentialState("big", "p", { tpd: 1_000_000 }, T0);
    const small = createCredentialState("small", "p", { tpd: 200_000 }, T0);
    // Big has more tokens left in absolute terms but less as a fraction.
    const bigUsed = { ...big, tokensToday: 900_000 }; // 10% left
    const smallUsed = { ...small, tokensToday: 80_000 }; // 60% left
    expect(headroom(smallUsed, T0)).toBeGreaterThan(headroom(bigUsed, T0));
  });

  it("never goes negative", () => {
    const c = { ...pool(1)[0]!, tokensToday: 999_999 };
    expect(headroom(c, T0)).toBe(0);
  });

  it("is 1 when no limits are declared", () => {
    expect(headroom(createCredentialState("x", "p", {}, T0), T0)).toBe(1);
  });
});

describe("window rollover", () => {
  it("clears per-minute counters after a minute", () => {
    let c = recordSuccess(pool(1)[0]!, T0, 5000);
    c = rollWindows(c, T0 + MINUTE + 1);
    expect(c.tokensThisMinute).toBe(0);
    expect(c.requestsThisMinute).toBe(0);
  });

  it("keeps daily counters across a minute rollover", () => {
    let c = recordSuccess(pool(1)[0]!, T0, 5000);
    c = rollWindows(c, T0 + MINUTE + 1);
    expect(c.tokensToday).toBe(5000);
    expect(c.requestsToday).toBe(1);
  });

  it("clears daily counters after a day", () => {
    let c = recordSuccess(pool(1)[0]!, T0, 5000);
    c = rollWindows(c, T0 + DAY + 1);
    expect(c.tokensToday).toBe(0);
  });
});

describe("selectCredential", () => {
  it("spreads load instead of draining one credential", () => {
    // The behaviour ADR-017 exists for: without it, credential 1 is exhausted by
    // mid-afternoon while three others sit untouched.
    let credentials = pool(4);
    const picks: string[] = [];

    for (let i = 0; i < 8; i++) {
      const { credential } = selectCredential(credentials, T0, 1000);
      expect(credential).not.toBeNull();
      picks.push(credential!.id);
      credentials = credentials.map((c) =>
        c.id === credential!.id ? recordSuccess(c, T0, 1000) : c,
      );
    }

    // Eight requests over four credentials should be even, not 8-0-0-0.
    const counts = new Map<string, number>();
    for (const id of picks) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.size).toBe(4);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it("prefers the credential with the most fractional headroom", () => {
    const credentials = pool(3);
    credentials[0] = { ...credentials[0]!, tokensToday: 150_000 };
    credentials[1] = { ...credentials[1]!, tokensToday: 10_000 };
    credentials[2] = { ...credentials[2]!, tokensToday: 90_000 };
    expect(selectCredential(credentials, T0, 100).credential?.id).toBe("groq-2");
  });

  it("skips a credential that cannot fit this request, without a round trip", () => {
    const credentials = pool(2);
    credentials[0] = { ...credentials[0]!, tokensThisMinute: 7_900 };
    // Needs 500 tokens; credential 1 has only 100 left this minute.
    expect(selectCredential(credentials, T0, 500).credential?.id).toBe("groq-2");
  });

  it("skips a cooling credential", () => {
    const credentials = pool(2);
    credentials[0] = { ...credentials[0]!, cooldownUntil: T0 + 30_000 };
    expect(selectCredential(credentials, T0, 100).credential?.id).toBe("groq-2");
  });

  it("uses a credential again once its cooldown expires", () => {
    const credentials = pool(1);
    credentials[0] = { ...credentials[0]!, cooldownUntil: T0 + 30_000 };
    expect(selectCredential(credentials, T0, 100).credential).toBeNull();
    expect(selectCredential(credentials, T0 + 31_000, 100).credential?.id).toBe("groq-1");
  });

  it("never returns a disabled credential", () => {
    const credentials = pool(2);
    credentials[0] = recordRejected(credentials[0]!, "401");
    expect(selectCredential(credentials, T0, 100).credential?.id).toBe("groq-2");
  });

  it("reports why nothing is available, and when to retry", () => {
    const credentials = pool(2).map((c) => ({ ...c, cooldownUntil: T0 + 20_000 }));
    const result = selectCredential(credentials, T0, 100);
    expect(result.credential).toBeNull();
    expect(result.reason).toBe("all_cooling");
    expect(result.retryAt).toBe(T0 + 20_000);
  });

  it("distinguishes exhausted from cooling from disabled", () => {
    expect(selectCredential([], T0).reason).toBe("empty_pool");

    const allDisabled = pool(2).map((c) => recordRejected(c, "401"));
    expect(selectCredential(allDisabled, T0).reason).toBe("all_disabled");

    const exhausted = pool(2).map((c) => ({ ...c, requestsToday: 1000 }));
    expect(selectCredential(exhausted, T0).reason).toBe("all_exhausted");
  });

  it("is deterministic on ties, so tests stay reproducible", () => {
    const credentials = pool(3);
    expect(selectCredential(credentials, T0, 100).credential?.id).toBe("groq-1");
    expect(selectCredential(credentials, T0, 100).credential?.id).toBe("groq-1");
  });
});

describe("outcome recording", () => {
  it("counts a successful request against both windows", () => {
    const c = recordSuccess(pool(1)[0]!, T0, 1234);
    expect(c.requestsToday).toBe(1);
    expect(c.tokensToday).toBe(1234);
    expect(c.tokensThisMinute).toBe(1234);
  });

  it("clears failures and cooldown on success", () => {
    let c = recordFailure(pool(1)[0]!, T0);
    c = recordSuccess(c, T0, 10);
    expect(c.consecutiveFailures).toBe(0);
    expect(c.cooldownUntil).toBeNull();
  });

  it("parks a rate-limited credential for the stated retry-after", () => {
    const c = recordRateLimited(pool(1)[0]!, T0, 45_000);
    expect(c.cooldownUntil).toBe(T0 + 45_000);
  });

  it("falls back to a minute when no retry-after is given", () => {
    expect(recordRateLimited(pool(1)[0]!, T0, undefined).cooldownUntil).toBe(T0 + MINUTE);
  });

  it("still counts the request that got rate-limited", () => {
    // It reached the provider, so it consumed budget even though it failed.
    expect(recordRateLimited(pool(1)[0]!, T0, 1000).requestsToday).toBe(1);
  });

  it("backs off exponentially, capped", () => {
    let c = pool(1)[0]!;
    const backoffs: number[] = [];
    for (let i = 0; i < 12; i++) {
      c = recordFailure(c, T0);
      backoffs.push((c.cooldownUntil ?? 0) - T0);
    }
    expect(backoffs[0]).toBe(2_000);
    expect(backoffs[1]).toBe(4_000);
    expect(backoffs[2]).toBe(8_000);
    expect(backoffs.at(-1)).toBe(15 * MINUTE); // capped
  });

  it("disables permanently on rejection, with no auto-recovery", () => {
    const c = recordRejected(pool(1)[0]!, "401 Unauthorized");
    expect(c.disabled).toBe(true);
    expect(c.disabledReason).toBe("401 Unauthorized");
    // A revoked key never starts working again; retrying it forever is a
    // permanent latency tax.
    expect(isAvailable(c, T0 + DAY * 30)).toBe(false);
  });
});

describe("snapshotPool", () => {
  it("counts availability by category", () => {
    const credentials = pool(4);
    credentials[0] = recordRejected(credentials[0]!, "401");
    credentials[1] = { ...credentials[1]!, cooldownUntil: T0 + 30_000 };

    const snap = snapshotPool(credentials, "groq", T0);
    expect(snap.total).toBe(4);
    expect(snap.disabled).toBe(1);
    expect(snap.cooling).toBe(1);
    expect(snap.available).toBe(2);
  });

  it("excludes disabled credentials from aggregate headroom", () => {
    // A dead key must not drag the number down and trigger degradation that a
    // healthy pool does not need (ADR-018 reads this value).
    const credentials = pool(2);
    credentials[0] = recordRejected(credentials[0]!, "401");
    expect(snapshotPool(credentials, "groq", T0).aggregateHeadroom).toBe(1);
  });

  it("reports zero headroom when every credential is disabled", () => {
    const credentials = pool(2).map((c) => recordRejected(c, "401"));
    expect(snapshotPool(credentials, "groq", T0).aggregateHeadroom).toBe(0);
  });

  it("exposes credential IDs but never key material", () => {
    const snap = snapshotPool(pool(2), "groq", T0);
    const serialised = JSON.stringify(snap);
    expect(serialised).toContain("groq-1");
    expect(serialised).not.toMatch(/gsk_|sk-or-|nvapi-|AIzaSy/);
  });
});
