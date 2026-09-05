/**
 * THE EVALUATION CONTRACT — frozen 2026-09-05 (ADR-026).
 *
 * One definition of every term a benchmark result depends on, in one file, with
 * regression tests for each historical failure. Imports TYPES only: nothing here
 * may depend on the extraction, retrieval or projection code it judges, so the
 * evaluator cannot drift toward the implementation it is meant to check.
 *
 * WHY THIS EXISTS
 * Four consecutive measurement bugs, each in the instrumentation written to
 * validate the previous change, each UNDER-reporting a working system:
 *
 *   1. recall@k conflated with answer accuracy    Ravenhold read 0%, was 100%
 *   2. validity divided by responses that PARSED  66 failures read 100%
 *   3. a correct empty extraction scored as fail  85% capture read 15%
 *   4. the matcher never read `quantity`          a perfect event read MISSED
 *
 * The pattern is more dangerous than a benchmark that breaks: each produced a
 * PLAUSIBLE wrong number, in the range where it gets believed and acted on.
 * ADR-023 made a benchmark refuse to report when it cannot measure. This makes
 * the definitions themselves unable to change quietly.
 *
 * Changing anything here invalidates comparisons against earlier runs. That is
 * the point — a definition change must be as visible as an architecture change.
 */

/** A fixture fact. Structural only: no behaviour, no dependencies. */
export interface PlantedFact {
  id: string;
  /** 0-based script index where the fact enters the world. */
  plantedAt: number;
  kind: string;
  /**
   * Surface forms that count as having captured this fact.
   *
   * At least one must appear in the canonical rendering of whatever the system
   * produced. Deliberately a disjunction: extraction rephrases, and demanding
   * one exact string measures phrasing rather than memory.
   */
  expect: readonly string[];
}

/** Small numbers written as words, so `quantity: 9` satisfies `expect: ["nine"]`. */
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
] as const;

/**
 * Renders a number in every form an expectation might use.
 *
 * Bug 4 was narrower than it looked: `quantity` was absent from the match blob
 * entirely. But even present as "9" it would still miss `expect: ["nine"]`, so
 * the fix is both — read the field, and render it in both forms.
 */
export function renderNumber(n: number): string {
  const digits = String(n);
  const word = Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : undefined;
  return word === undefined ? digits : `${digits} ${word}`;
}

/**
 * The canonical text of a produced artifact, for matching only.
 *
 * EVERY field an expectation could land in must appear. A field omitted here is
 * a silent false negative — which is exactly what bug 4 was. When a new field is
 * added to an event or memory, it goes in this function or the contract is lying.
 */
export function renderForMatching(artifact: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(artifact)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number") parts.push(renderNumber(value));
    else if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) {
      parts.push(value.filter((v) => typeof v === "string").join(" "));
    }
  }
  return parts.join(" ").toLowerCase();
}

/**
 * THE matcher. Every benchmark uses this one and no other.
 *
 * Case-insensitive substring over the canonical rendering. This is a PROXY for
 * semantic correctness, not a measure of it: a system could store "the user
 * dislikes coriander" and satisfy `expect: ["coriander"]` while having inverted
 * the sentiment. The contract states the limitation rather than implying a
 * rigour it does not have. Semantic correctness needs a judge; see § below.
 */
export function capturesFact(artifacts: readonly Record<string, unknown>[], fact: PlantedFact): boolean {
  const blob = artifacts.map(renderForMatching).join(" ");
  return fact.expect.some((term) => blob.includes(term.toLowerCase()));
}

/**
 * What one extraction attempt did.
 *
 * `empty_valid` is a SUCCESS. A turn carrying nothing durable should produce
 * nothing, and Suite 1's script is roughly 80 filler turns to 20 fact-bearing
 * ones. Scoring silence as failure capped achievable validity near 20% and
 * produced the "15%" that read as a broken extractor.
 */
export type AttemptOutcome =
  | "accepted"
  | "empty_valid"
  | "truncated"
  | "unparseable"
  | "schema"
  | "all_rejected"
  | "call_failed";

/** Outcomes that mean the system behaved correctly. */
export const CORRECT_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "accepted",
  "empty_valid",
]);

/** Outcomes caused by the model or transport, not by comprehension. */
export const FORMAT_FAILURES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "truncated",
  "unparseable",
  "schema",
]);

export interface ExtractionHealth {
  /** Correct behaviour over every attempt. The headline reliability number. */
  health: number;
  /** Failures attributable to output format rather than understanding. */
  formatFailureRate: number;
  attempts: number;
}

/**
 * Extraction health.
 *
 * Denominator is every attempt INCLUDING those that never parsed. Bug 2 divided
 * by responses that had already parsed, so 66 failures and 1 success reported
 * 100%. A rate whose denominator excludes its own failures is not a rate.
 */
export function extractionHealth(outcomes: readonly AttemptOutcome[]): ExtractionHealth {
  const attempts = outcomes.length;
  if (attempts === 0) return { health: 0, formatFailureRate: 0, attempts: 0 };
  const correct = outcomes.filter((o) => CORRECT_OUTCOMES.has(o)).length;
  const format = outcomes.filter((o) => FORMAT_FAILURES.has(o)).length;
  return {
    health: (correct / attempts) * 100,
    formatFailureRate: (format / attempts) * 100,
    attempts,
  };
}

/**
 * Fact capture: of the facts planted, how many the system actually holds.
 *
 * Reported separately from health on purpose. A system can be perfectly
 * well-behaved — never malformed, never truncated — and still capture nothing,
 * because declining to extract is well-behaved. Health measures the pipeline;
 * capture measures the product.
 */
export function factCaptureRate(
  results: readonly { factId: string; captured: boolean }[],
): { captured: number; total: number; rate: number } {
  const total = results.length;
  const captured = results.filter((r) => r.captured).length;
  return { captured, total, rate: total === 0 ? 0 : (captured / total) * 100 };
}

/**
 * RECALL@K — measured against the RETRIEVED SET, never against the reply text.
 *
 * Bug 1. Scoring the model's prose answer measures phrasing and instruction
 * following, not memory: Ravenhold read 0% recall while retrieval was returning
 * the right memory every time, and went to 100% after the split with no
 * retrieval change. docs/15 § 3 separates these deliberately.
 */
export function recallAtK(probes: readonly { recalled: boolean }[]): number {
  if (probes.length === 0) return 0;
  return (probes.filter((p) => p.recalled).length / probes.length) * 100;
}

/**
 * What this contract does NOT measure, stated so nobody infers it does:
 *
 *  - SEMANTIC CORRECTNESS. `capturesFact` is a substring proxy. An inverted
 *    sentiment or a wrong actor can pass. Establishing real correctness needs a
 *    judge over the stored artifact, which is a separate suite.
 *  - ASSOCIATIVE RECALL. Every Suite 1 fact is typed and has an exact answer, so
 *    a structured store answers it by lookup. That makes Suite 1 a test of
 *    EXTRACTION once structured resolution is in play, not of retrieval. The
 *    questions that keep the product from feeling brittle — "what happened that
 *    night by the river" — are not represented here at all.
 *  - PRODUCTION CONCURRENCY. Runs here are sequential and unthrottled by real
 *    traffic.
 */
export const CONTRACT_VERSION = 1;
