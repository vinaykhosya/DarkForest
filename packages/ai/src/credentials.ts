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
import { GEMINI_DEV_MODELS, GROQ_DIALOGUE_MODELS } from "./registry/models.js";

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
  /** Limits for ONE bucket. See `perModelLimits` for what a bucket covers. */
  limits: CredentialLimits;
  /**
   * True when the provider meters each MODEL independently on the same
   * credential — one bucket per (credential x model) rather than per credential.
   *
   * Must be VERIFIED, never assumed. The test: call several models on one
   * credential and read the returned remaining-counters. If they fall
   * monotonically the budget is shared; if each reports its own near-full
   * budget, they are independent.
   *
   * Verified 2026-09-04 — Groq, four models, one credential:
   *   gpt-oss-20b   999/1000 requests, 7760/8000 tokens
   *   gpt-oss-120b  999/1000 requests, 7760/8000 tokens
   *   qwen3.6-27b   999/1000 requests, 7822/8000 tokens
   *   qwen3.8-27b   999/1000 requests, 7820/8000 tokens
   * Shared buckets would have shown 996 requests by the fourth call.
   */
  perModelLimits?: boolean;
  /** Models metered separately. Required when perModelLimits is true. */
  models?: readonly string[];
}

/**
 * Observed free-tier limits per credential — verified 2026-09-03.
 * See docs/benchmarks/2026-09-03-provider-verification.md.
 */
export const PROVIDER_CREDENTIALS: readonly ProviderCredentialConfig[] = [
  {
    providerId: "groq",
    envVar: "GROQ_API_KEY",
    /*
     * PER MODEL, verified. 8 credentials x 4 dialogue models = 32 independent
     * buckets. Metering this as one bucket per credential used 25% of Groq.
     *
     * `tpd` is deliberately ABSENT: Groq exposes no tokens-per-day header, and
     * the previous 200_000 value was invented. An imaginary ceiling throttles
     * real capacity, so a limit we cannot observe is not declared.
     */
    limits: { rpm: 30, rpd: 1000, tpm: 8000 },
    perModelLimits: true,
    models: GROQ_DIALOGUE_MODELS,
  },
  {
    providerId: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    /*
     * ACCOUNT-WIDE, not per model. The 50/day free allowance is shared across
     * every :free endpoint on the account, so splitting it per model would
     * invent capacity that does not exist — the mirror image of the Groq bug,
     * and the more dangerous direction to get wrong.
     *
     * Free endpoints cap requests rather than tokens, which is why they scale a
     * beta better than token-capped providers (ADR-011).
     */
    limits: { rpm: 20, rpd: 50 },
  },
  {
    providerId: "gemini",
    envVar: "GEMINI_API_KEY",
    // Per model per project. DEVELOPMENT ONLY — Gemini unpaid terms use
    // submitted content for training (ADR-009), so checkPoolEligibility keeps
    // it out of any pool that serves users.
    limits: { rpm: 15, rpd: 1500 },
    perModelLimits: true,
    models: GEMINI_DEV_MODELS,
  },
  {
    providerId: "nvidia",
    envVar: "NVIDIA_NIM_API_KEY",
    /*
     * DEVELOPMENT ONLY — the API Trial ToS forbids production outright
     * (ADR-013, §1.2 and §1.4), independently of the privacy question.
     *
     * Not declared per-model: NVIDIA publishes no per-model limits we have
     * verified, and inventing them would overstate capacity.
     */
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
  /** The underlying credential, shared by every model bucket that uses it. */
  credentialName: string;
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

      /*
       * One bucket per (credential x model) where the provider meters that way,
       * otherwise one per credential. This is the whole fix: capacity identity
       * must match how the provider actually meters, or we either waste real
       * capacity (Groq) or invent capacity that is not there (OpenRouter).
       */
      const stored: StoredCredential[] = [];
      for (const [i, key] of keys.entries()) {
        const credName = `${config.providerId}-${String(i + 1)}`;
        if (config.perModelLimits === true && config.models !== undefined) {
          for (const modelId of config.models) {
            stored.push({
              key,
              credentialName: credName,
              state: createCredentialState(
                `${credName}::${modelId}`,
                config.providerId,
                config.limits,
                now,
                modelId,
              ),
            });
          }
        } else {
          stored.push({
            key,
            credentialName: credName,
            state: createCredentialState(credName, config.providerId, config.limits, now, null),
          });
        }
      }

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
    modelId?: string,
  ):
    | { ok: true; id: string; key: string }
    | { ok: false; reason: string; retryAt?: number } {
    const all = this.pools.get(providerId);
    if (!all || all.length === 0) {
      return { ok: false, reason: "no_credentials" };
    }

    /*
     * Narrow to one model's buckets when the caller names a model and this
     * provider meters per model. Without this the pool could hand back a bucket
     * metering a DIFFERENT model's budget, and the accounting would drift from
     * what the provider actually enforces.
     */
    const stored =
      modelId === undefined
        ? all
        : all.filter((s) => s.state.modelId === null || s.state.modelId === modelId);
    if (stored.length === 0) return { ok: false, reason: "no_bucket_for_model" };

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
