import type { InferencePool, ModelDescriptor } from "@darkforest/contracts";

/**
 * Pool eligibility enforcement — ADR-013 / ADR-014.
 *
 * This is the code that makes provider policy a property of the system rather
 * than a paragraph in a document. Every routing decision passes through it.
 *
 * The rule it exists to enforce:
 *
 *   A provider whose terms restrict use to internal testing and evaluation may
 *   never serve a real end user — no matter how good, how free, or how well
 *   disclosed. A disclaimer shown to OUR users cannot discharge an obligation
 *   WE owe the provider, because our users are not party to that contract.
 *
 * The escape hatch is deliberately narrow: development-only models are reachable
 * exclusively from `local`, and only for traffic explicitly marked synthetic.
 */

export type Environment = "local" | "staging" | "production";

export interface RoutingIntent {
  /** Which pool the caller's plan entitles them to. */
  pool: InferencePool;
  environment: Environment;
  /**
   * True only for benchmark fixtures and seeded eval worlds — never for anything
   * a person typed. Defaults to false, so forgetting to set it fails closed.
   */
  isSyntheticContent?: boolean;
}

export type PoolRejection =
  | { reason: "terms_forbid_production"; detail: string }
  | { reason: "not_in_pool"; detail: string }
  | { reason: "not_benchmarked"; detail: string };

/**
 * Returns null when routing is permitted, or a structured rejection.
 *
 * Returning a reason rather than throwing keeps this usable inside the router's
 * candidate filter, where a rejected model is a normal event, not an error.
 */
export function checkPoolEligibility(
  model: ModelDescriptor,
  intent: RoutingIntent,
): PoolRejection | null {
  const synthetic = intent.isSyntheticContent ?? false;

  // Gate 1 — contractual eligibility. Checked FIRST and independently of privacy:
  // a provider can be privacy-clean and still forbid production use.
  if (model.policy.eligibility === "development_only") {
    const allowed = intent.environment === "local" && synthetic;
    if (!allowed) {
      return {
        reason: "terms_forbid_production",
        detail:
          `${model.id}: provider terms restrict use to internal testing and evaluation. ` +
          `Reachable only from the local environment with synthetic content. ` +
          `Governing clause: ${model.policy.source}`,
      };
    }
  }

  // Gate 2 — pool membership.
  if (!model.pools.includes(intent.pool)) {
    return {
      reason: "not_in_pool",
      detail: `${model.id} is not a member of the '${intent.pool}' pool (member of: ${model.pools.join(", ")}).`,
    };
  }

  // Gate 3 — docs/08 § 4: an unbenchmarked model is not routable to real users.
  // "It's free" is a cost input, not a quality argument.
  if (model.qualityScore === undefined && intent.environment === "production") {
    return {
      reason: "not_benchmarked",
      detail: `${model.id} has no recorded eval score. See docs/15 § 4.`,
    };
  }

  return null;
}

export function eligibleModels(
  models: readonly ModelDescriptor[],
  intent: RoutingIntent,
): ModelDescriptor[] {
  return models.filter((m) => checkPoolEligibility(m, intent) === null);
}

/**
 * The disclosure a user must see before their content is routed to a `standard`
 * pool provider that trains on input.
 *
 * Consent belongs to the pool, not to a named provider: the set of providers in
 * a pool changes, and re-consenting every user on each change is unworkable.
 * What the user agrees to is the PROPERTY ("may be used to improve their models"),
 * which stays true whoever is serving.
 */
export function poolRequiresDisclosure(models: readonly ModelDescriptor[]): boolean {
  return models.some((m) => m.policy.trainsOnInput);
}
