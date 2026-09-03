/**
 * @darkforest/core
 *
 * Pure domain logic. No I/O, no clock, no randomness, no database.
 *
 * Everything here is a function of its arguments, which is what makes the hardest
 * parts of this system — ranking, decay, relationship dynamics, responder selection —
 * testable in milliseconds without a model, a network or a database.
 *
 * Enforced by lint: this package may not import node builtins, fetch, or any
 * database client. See eslint.config.js and docs/02 § 2.
 */

export * from "./ai/pool-guard.js";
export * from "./memory/weights.js";
export * from "./memory/text.js";
export * from "./memory/scoring.js";
export * from "./memory/fusion.js";
export * from "./memory/mmr.js";
export * from "./memory/budget.js";
