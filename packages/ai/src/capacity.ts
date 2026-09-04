import type { CapacityBucket } from "@darkforest/core";
import type { ModelDescriptor } from "@darkforest/contracts";
import { PROVIDER_CREDENTIALS } from "./credentials.js";
import type { CredentialRegistry } from "./credentials.js";

/**
 * Builds the scheduler's view of capacity from the credential registry.
 *
 * ONE owner of "what buckets exist", deliberately. Before this existed the
 * routing smoke test assembled buckets itself and, having no access to the
 * registry's real limits, hardcoded `{rpm: 30, rpd: 1000, tpm: 8000}` for every
 * provider. That is Groq's shape; it is wrong for the other three — NVIDIA
 * declares only an RPM, OpenRouter is account-wide at 50/day, Cloudflare is a
 * daily token budget. Suite 1 was about to become the second copy of that guess.
 *
 * A fabricated limit is indistinguishable from a measured one once it is inside
 * a data structure, which is what makes this worth centralising rather than
 * fixing in place: the limits here come from `PROVIDER_CREDENTIALS` and the live
 * counters come from the registry, so no caller is in a position to invent one.
 */

/** The part of a provider adapter this needs. Keeps adapters substitutable. */
export interface ModelSource {
  readonly id: string;
  readonly models: readonly ModelDescriptor[];
}

export interface BuildBucketsOptions {
  /**
   * Restrict to these providers. Omit for every configured provider.
   * Eligibility is NOT decided here — `schedule()` applies the terms and pool
   * guard. This is only about which adapters are wired up.
   */
  providerIds?: readonly string[];
}

/**
 * @throws if an account-wide provider offers several models — see below.
 */
export function buildCapacityBuckets(
  registry: CredentialRegistry,
  sources: readonly ModelSource[],
  options: BuildBucketsOptions = {},
): CapacityBucket[] {
  const byProvider = new Map(sources.map((s) => [s.id, s]));
  const meteredPerModel = new Set(
    PROVIDER_CREDENTIALS.filter((c) => c.perModelLimits === true).map((c) => c.providerId),
  );
  const buckets: CapacityBucket[] = [];

  for (const state of registry.states()) {
    if (options.providerIds !== undefined && !options.providerIds.includes(state.providerId)) {
      continue;
    }
    const source = byProvider.get(state.providerId);
    if (source === undefined) continue; // No adapter wired for this provider.

    if (state.modelId !== null) {
      // Per-model metering: this bucket meters exactly one model, and the
      // scheduler must not offer it for any other.
      const model = source.models.find((m) => m.id === state.modelId);
      if (model === undefined) continue;
      buckets.push({
        id: `${state.providerId}:${model.id}:${state.id}`,
        providerId: state.providerId,
        model,
        state,
      });
      continue;
    }

    /*
     * Account-wide metering: one budget per credential, shared by every model.
     *
     * Emitting one bucket per (credential x model) here would let the scheduler
     * see N independent buckets backed by ONE budget — inventing capacity that
     * does not exist. That is the mirror image of the Groq bug and the more
     * dangerous direction, because it fails as a confident 429 rather than as
     * unused headroom. Rather than silently pick a model, refuse: the fix is to
     * verify the provider's metering and set `perModelLimits`, not to guess.
     */
    if (source.models.length > 1 && !meteredPerModel.has(state.providerId)) {
      throw new Error(
        `${state.providerId} declares ${String(source.models.length)} models but is metered ` +
          `account-wide. Verify whether its limits are per-model and set perModelLimits ` +
          `in PROVIDER_CREDENTIALS; do not assume.`,
      );
    }
    const model = source.models[0];
    if (model === undefined) continue;
    buckets.push({
      id: `${state.providerId}:${model.id}:${state.id}`,
      providerId: state.providerId,
      model,
      state,
    });
  }

  return buckets;
}
