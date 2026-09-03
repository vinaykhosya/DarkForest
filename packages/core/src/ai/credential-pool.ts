/**
 * Credential pool — multiple API credentials per provider, ADR-019.
 *
 * Selection is by FRACTIONAL remaining headroom, the same rule ADR-017 applies
 * across models: the pool should drain evenly rather than exhausting credential
 * 1 before touching credential 2. Even draining means every user in a given hour
 * gets comparable service, instead of the day splitting into "fast" and
 * "degraded" halves.
 *
 * Pure. No I/O, no clock of its own — `now` is always passed in, which is what
 * makes cooldown and window-rollover behaviour testable without waiting.
 *
 * SECURITY: this module handles credential IDs, never key material. Keys live in
 * the adapter layer and are never logged, never traced, never serialised into a
 * result. A `CredentialId` is safe to put in a log line; a key never is.
 */

export type CredentialId = string;

export interface CredentialLimits {
  /** Requests per minute. */
  rpm?: number;
  /** Requests per day. */
  rpd?: number;
  /** Tokens per minute. */
  tpm?: number;
  /** Tokens per day. Usually the binding constraint for us. */
  tpd?: number;
}

export interface CredentialState {
  id: CredentialId;
  providerId: string;
  limits: CredentialLimits;
  /** Rolling counters. Reset when their window rolls over. */
  requestsThisMinute: number;
  requestsToday: number;
  tokensThisMinute: number;
  tokensToday: number;
  minuteWindowStart: number;
  dayWindowStart: number;
  /** Epoch ms until which this credential is skipped. */
  cooldownUntil: number | null;
  consecutiveFailures: number;
  /** Set when a credential is rejected outright (401/403). Never auto-recovers. */
  disabled: boolean;
  disabledReason: string | null;
}

export function createCredentialState(
  id: CredentialId,
  providerId: string,
  limits: CredentialLimits,
  now: number,
): CredentialState {
  return {
    id,
    providerId,
    limits,
    requestsThisMinute: 0,
    requestsToday: 0,
    tokensThisMinute: 0,
    tokensToday: 0,
    minuteWindowStart: now,
    dayWindowStart: now,
    cooldownUntil: null,
    consecutiveFailures: 0,
    disabled: false,
    disabledReason: null,
  };
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Rolls expired windows. Returns a new state; never mutates the input. */
export function rollWindows(state: CredentialState, now: number): CredentialState {
  let next = state;
  if (now - state.minuteWindowStart >= MINUTE) {
    next = { ...next, requestsThisMinute: 0, tokensThisMinute: 0, minuteWindowStart: now };
  }
  if (now - state.dayWindowStart >= DAY) {
    next = { ...next, requestsToday: 0, tokensToday: 0, dayWindowStart: now };
  }
  return next;
}

/**
 * Fractional headroom, 0..1 — the minimum across all four limits.
 *
 * Fractional rather than absolute so credentials with different budgets compare
 * fairly: a key with 1M tokens/day and 10% left has less usable capacity than
 * one with 200K and 60% left, and absolute comparison would pick wrong.
 *
 * Taking the MINIMUM matters: a credential with plenty of daily tokens but a
 * spent per-minute budget is not available right now, and averaging would hide
 * that.
 */
export function headroom(state: CredentialState, now: number): number {
  const s = rollWindows(state, now);
  const fractions: number[] = [];

  if (s.limits.rpm !== undefined && s.limits.rpm > 0) {
    fractions.push(1 - s.requestsThisMinute / s.limits.rpm);
  }
  if (s.limits.rpd !== undefined && s.limits.rpd > 0) {
    fractions.push(1 - s.requestsToday / s.limits.rpd);
  }
  if (s.limits.tpm !== undefined && s.limits.tpm > 0) {
    fractions.push(1 - s.tokensThisMinute / s.limits.tpm);
  }
  if (s.limits.tpd !== undefined && s.limits.tpd > 0) {
    fractions.push(1 - s.tokensToday / s.limits.tpd);
  }

  if (fractions.length === 0) return 1; // no declared limits
  return Math.max(0, Math.min(...fractions));
}

export function isAvailable(state: CredentialState, now: number, estimatedTokens = 0): boolean {
  if (state.disabled) return false;
  if (state.cooldownUntil !== null && now < state.cooldownUntil) return false;

  const s = rollWindows(state, now);
  if (s.limits.rpm !== undefined && s.requestsThisMinute >= s.limits.rpm) return false;
  if (s.limits.rpd !== undefined && s.requestsToday >= s.limits.rpd) return false;
  // Pre-emptive: skip a credential that cannot fit THIS request rather than
  // spending a round trip to be told 429 (docs/08 § 6).
  if (s.limits.tpm !== undefined && s.tokensThisMinute + estimatedTokens > s.limits.tpm) {
    return false;
  }
  if (s.limits.tpd !== undefined && s.tokensToday + estimatedTokens > s.limits.tpd) return false;

  return true;
}

export interface SelectionResult {
  credential: CredentialState | null;
  /** Why nothing was selected. Distinguishes "wait" from "give up". */
  reason?: "all_exhausted" | "all_cooling" | "all_disabled" | "empty_pool";
  /** Earliest epoch ms at which some credential becomes available again. */
  retryAt?: number;
}

/**
 * Picks the credential with the most fractional headroom.
 *
 * Not round-robin: round-robin ignores that credentials drift apart when
 * requests differ in size, and one large request can leave a credential far
 * behind while the rotation keeps handing it work.
 */
export function selectCredential(
  pool: readonly CredentialState[],
  now: number,
  estimatedTokens = 0,
): SelectionResult {
  if (pool.length === 0) return { credential: null, reason: "empty_pool" };

  const available = pool.filter((c) => isAvailable(c, now, estimatedTokens));

  if (available.length === 0) {
    if (pool.every((c) => c.disabled)) return { credential: null, reason: "all_disabled" };

    const cooling = pool.filter(
      (c) => !c.disabled && c.cooldownUntil !== null && now < c.cooldownUntil,
    );
    if (cooling.length > 0) {
      const retryAt = Math.min(...cooling.map((c) => c.cooldownUntil ?? Infinity));
      return { credential: null, reason: "all_cooling", retryAt };
    }

    // Exhausted on quota: the earliest relief is the next window rollover.
    const active = pool.filter((c) => !c.disabled);
    const retryAt =
      active.length === 0
        ? now + MINUTE
        : Math.min(...active.map((c) => c.minuteWindowStart + MINUTE));
    return { credential: null, reason: "all_exhausted", retryAt };
  }

  let best: CredentialState | null = null;
  let bestHeadroom = -1;
  for (const candidate of available) {
    const h = headroom(candidate, now);
    // Strict >, so ties keep the earlier credential and selection stays
    // deterministic for a given pool order — which makes tests reproducible.
    if (h > bestHeadroom) {
      best = candidate;
      bestHeadroom = h;
    }
  }
  // `available` is non-empty here (checked above), so `best` is always set —
  // but expressed as a narrowing rather than an assertion.
  return best === null ? { credential: null, reason: "all_exhausted" } : { credential: best };
}

// ── outcome recording ────────────────────────────────────────────────────────

export function recordSuccess(
  state: CredentialState,
  now: number,
  tokensUsed: number,
): CredentialState {
  const s = rollWindows(state, now);
  return {
    ...s,
    requestsThisMinute: s.requestsThisMinute + 1,
    requestsToday: s.requestsToday + 1,
    tokensThisMinute: s.tokensThisMinute + tokensUsed,
    tokensToday: s.tokensToday + tokensUsed,
    consecutiveFailures: 0,
    cooldownUntil: null,
  };
}

export function recordRateLimited(
  state: CredentialState,
  now: number,
  retryAfterMs: number | undefined,
): CredentialState {
  const s = rollWindows(state, now);
  // A 429 means this credential's window is spent. Park it for the stated
  // duration and move on — never retry the same credential (docs/08 § 6).
  return {
    ...s,
    requestsThisMinute: s.requestsThisMinute + 1,
    requestsToday: s.requestsToday + 1,
    cooldownUntil: now + (retryAfterMs ?? MINUTE),
  };
}

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15 * MINUTE;

export function recordFailure(state: CredentialState, now: number): CredentialState {
  const s = rollWindows(state, now);
  const failures = s.consecutiveFailures + 1;
  // Exponential backoff, capped. Matches the circuit-breaker shape in docs/08 § 6.
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  return { ...s, consecutiveFailures: failures, cooldownUntil: now + backoff };
}

/**
 * Permanently disables a credential. For 401/403 only.
 *
 * Deliberately not auto-recovering: a revoked or mistyped key will never start
 * working on its own, and retrying it forever turns one dead credential into a
 * permanent latency tax on every request that reaches it.
 */
export function recordRejected(state: CredentialState, reason: string): CredentialState {
  return { ...state, disabled: true, disabledReason: reason, cooldownUntil: null };
}

// ── observability ────────────────────────────────────────────────────────────

export interface PoolSnapshot {
  providerId: string;
  total: number;
  available: number;
  cooling: number;
  disabled: number;
  /** 0..1 across the whole pool. Drives the ADR-018 degradation thresholds. */
  aggregateHeadroom: number;
  perCredential: Array<{
    id: CredentialId;
    headroom: number;
    requestsToday: number;
    tokensToday: number;
    disabled: boolean;
    disabledReason: string | null;
  }>;
}

export function snapshotPool(
  pool: readonly CredentialState[],
  providerId: string,
  now: number,
): PoolSnapshot {
  const active = pool.filter((c) => !c.disabled);
  return {
    providerId,
    total: pool.length,
    available: pool.filter((c) => isAvailable(c, now)).length,
    cooling: pool.filter((c) => !c.disabled && c.cooldownUntil !== null && now < c.cooldownUntil)
      .length,
    disabled: pool.filter((c) => c.disabled).length,
    // Mean over ACTIVE credentials: a disabled key should not drag the number
    // down and trigger degradation that a healthy pool does not need.
    aggregateHeadroom:
      active.length === 0
        ? 0
        : active.reduce((sum, c) => sum + headroom(c, now), 0) / active.length,
    perCredential: pool.map((c) => ({
      id: c.id,
      headroom: headroom(c, now),
      requestsToday: c.requestsToday,
      tokensToday: c.tokensToday,
      disabled: c.disabled,
      disabledReason: c.disabledReason,
    })),
  };
}
