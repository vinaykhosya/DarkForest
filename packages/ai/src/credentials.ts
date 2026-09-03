import {
  createCredentialState,
  recordFailure,
  recordRateLimited,
  recordRejected,
  recordSuccess,
  selectCredential,
  snapshotPool,
  type CredentialLimits,
  type CredentialState,
  type PoolSnapshot,
} from "@darkforest/core";

/**
 * Credential registry — the only module that holds key material.
 *
 * Everything above this layer works with a `CredentialId` ("groq-2"), which is
 * safe to log, trace and serialise. The key itself is handed to `fetch` and
 * nowhere else.
 *
 * Keys are read from environment variables that accept a comma-separated list:
 *
 *   GROQ_API_KEY=key1,key2,key3
 *
 * A single key is just a list of one, so the same code path serves both and
 * there is no "pooled" special case to get wrong.
 */

export interface ProviderCredentialConfig {
  providerId: string;
  envVar: string;
  /** Per-credential limits. Applied to each key independently. */
  limits: CredentialLimits;
}

/**
 * Observed free-tier limits per credential — verified 2026-09-03.
 * See docs/benchmarks/2026-09-03-provider-verification.md.
 */
export const PROVIDER_CREDENTIALS: readonly ProviderCredentialConfig[] = [
  {
    providerId: "groq",
    envVar: "GROQ_API_KEY",
    // Per model; the pool tracks the per-key envelope conservatively.
    limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 },
  },
  {
    providerId: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    // Free endpoints cap requests, not tokens — which is why they scale a beta
    // better than token-capped providers (ADR-011).
    limits: { rpm: 20, rpd: 50 },
  },
  {
    providerId: "gemini",
    envVar: "GEMINI_API_KEY",
    limits: { rpm: 15, rpd: 1500 },
  },
  {
    providerId: "nvidia",
    envVar: "NVIDIA_NIM_API_KEY",
    limits: { rpm: 40 },
  },
  {
    providerId: "cloudflare",
    envVar: "CF_API_TOKEN",
    // 10,000 neurons/day ≈ 1.65M embedding tokens at ~6 neurons/1K.
    limits: { tpd: 1_650_000 },
  },
];

interface StoredCredential {
  state: CredentialState;
  key: string;
}

export class CredentialRegistry {
  /** providerId → credentials. Keys never leave this map. */
  private readonly pools = new Map<string, StoredCredential[]>();

  constructor(env: Record<string, string | undefined>, now: number = Date.now()) {
    for (const config of PROVIDER_CREDENTIALS) {
      const raw = env[config.envVar];
      if (raw === undefined || raw.trim().length === 0) continue;

      const keys = raw
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      const stored = keys.map((key, i) => ({
        key,
        state: createCredentialState(
          `${config.providerId}-${String(i + 1)}`,
          config.providerId,
          config.limits,
          now,
        ),
      }));

      if (stored.length > 0) this.pools.set(config.providerId, stored);
    }
  }

  has(providerId: string): boolean {
    return (this.pools.get(providerId)?.length ?? 0) > 0;
  }

  providerIds(): string[] {
    return [...this.pools.keys()];
  }

  /**
   * Acquires a credential for one request.
   *
   * Returns the key alongside its id — the caller passes the key to `fetch` and
   * reports the outcome back by id. Never store or log the returned key.
   */
  acquire(
    providerId: string,
    estimatedTokens = 0,
    now: number = Date.now(),
  ):
    | { ok: true; id: string; key: string }
    | { ok: false; reason: string; retryAt?: number } {
    const stored = this.pools.get(providerId);
    if (!stored || stored.length === 0) {
      return { ok: false, reason: "no_credentials" };
    }

    const result = selectCredential(
      stored.map((s) => s.state),
      now,
      estimatedTokens,
    );

    if (result.credential === null) {
      return {
        ok: false,
        reason: result.reason ?? "unavailable",
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
      };
    }

    const selectedId = result.credential.id;
    const chosen = stored.find((s) => s.state.id === selectedId);
    if (!chosen) return { ok: false, reason: "internal_missing_credential" };

    return { ok: true, id: chosen.state.id, key: chosen.key };
  }

  reportSuccess(id: string, tokensUsed: number, now: number = Date.now()): void {
    this.update(id, (state) => recordSuccess(state, now, tokensUsed));
  }

  reportRateLimited(id: string, retryAfterMs: number | undefined, now: number = Date.now()): void {
    this.update(id, (state) => recordRateLimited(state, now, retryAfterMs));
  }

  reportFailure(id: string, now: number = Date.now()): void {
    this.update(id, (state) => recordFailure(state, now));
  }

  /** For 401/403 only. The credential is never retried. */
  reportRejected(id: string, reason: string): void {
    this.update(id, (state) => recordRejected(state, reason));
  }

  snapshot(providerId: string, now: number = Date.now()): PoolSnapshot | null {
    const stored = this.pools.get(providerId);
    if (!stored) return null;
    return snapshotPool(
      stored.map((s) => s.state),
      providerId,
      now,
    );
  }

  /** Every pool's snapshot. Safe to log — contains ids and counters only. */
  snapshotAll(now: number = Date.now()): PoolSnapshot[] {
    return [...this.pools.keys()]
      .map((id) => this.snapshot(id, now))
      .filter((s): s is PoolSnapshot => s !== null);
  }

  private update(id: string, fn: (state: CredentialState) => CredentialState): void {
    for (const stored of this.pools.values()) {
      const entry = stored.find((s) => s.state.id === id);
      if (entry) {
        entry.state = fn(entry.state);
        return;
      }
    }
  }
}

/**
 * Redacts anything key-shaped from a string before it reaches a log or an error
 * message.
 *
 * Belt and braces: nothing should be passing a key to a logger in the first
 * place, but provider SDKs and fetch errors sometimes echo request headers back
 * in exception messages, and that path is easy to miss in review.
 */
const KEY_PATTERNS = [
  /gsk_[A-Za-z0-9]{20,}/g,
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /nvapi-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /cfat_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
];

export function redactKeys(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
