/**
 * Deterministic extraction gate — ADR-016.
 *
 * Running an LLM after every turn to decide "was anything important?" is the
 * clearest violation of docs/01 § P4 in the whole design, and it was in the
 * original spec. Against Groq's 200K tokens/day cap, a meaningful share of our
 * total capacity would be spent confirming that nothing happened.
 *
 * So a free classifier runs first. Only when a signal fires do we spend an
 * inference call.
 *
 * PROVISIONAL. Eval suite 1 must run with and without the gate; if recall drops
 * more than 2 points, the gate is wrong and comes out. The turn-count floor
 * exists so that a slow, quiet scene still gets captured eventually.
 */

export type ExtractionSignal =
  | "commissive" // promise, swear, vow, agree, refuse
  | "irreversible" // death, betrayal, departure, revelation
  | "new_entity" // first mention of a known name in this window
  | "preference" // an explicit statement about the player
  | "tool_call" // a validated mutation already fired this turn
  | "rule_delta" // a deterministic relationship rule fired
  | "turn_floor"; // N turns since the last extraction

export interface GateInput {
  /** Text of the turns in the rolling window, user and character alike. */
  windowText: string;
  /** Names known to this world — characters, locations, items. */
  knownEntities: readonly string[];
  /** Entity names already appearing in stored memories. */
  seenEntities: readonly string[];
  toolCallFired: boolean;
  ruleDeltaApplied: boolean;
  turnsSinceLastExtraction: number;
  /** Floor, in turns. 0 disables it. */
  turnFloor?: number;
}

export interface GateResult {
  shouldExtract: boolean;
  signals: ExtractionSignal[];
  /** Entities that triggered `new_entity`. Useful as extraction prompt hints. */
  newEntities: string[];
}

const COMMISSIVE =
  /\b(promis(e|ed|es|ing)|swear|swore|sworn|vow(ed|s)?|oath|agree(d)?|refus(e|ed)|guarantee(d)?|pledg(e|ed))\b/i;

const IRREVERSIBLE =
  /\b(betray(ed|al|s)?|died|dies|dead|death|kill(ed|s)?|murder(ed)?|leav(e|ing)|left|depart(ed|ing)?|abandon(ed)?|confess(ed|ion)?|reveal(ed)?|admit(ted)?|forgiv(e|en)|marry|married|destroy(ed)?)\b/i;

const PREFERENCE =
  /\b(i (always|never|prefer|hate|love|refuse to|can'?t stand)|my favou?rite|i'?m afraid of)\b/i;

const DEFAULT_TURN_FLOOR = 12;

export function shouldExtract(input: GateInput): GateResult {
  const signals: ExtractionSignal[] = [];
  const text = input.windowText;

  if (COMMISSIVE.test(text)) signals.push("commissive");
  if (IRREVERSIBLE.test(text)) signals.push("irreversible");
  if (PREFERENCE.test(text)) signals.push("preference");
  if (input.toolCallFired) signals.push("tool_call");
  if (input.ruleDeltaApplied) signals.push("rule_delta");

  // First appearance of a known entity that no stored memory mentions yet.
  const seen = new Set(input.seenEntities.map((e) => e.toLowerCase()));
  const lower = text.toLowerCase();
  const newEntities = input.knownEntities.filter(
    (entity) => !seen.has(entity.toLowerCase()) && lower.includes(entity.toLowerCase()),
  );
  if (newEntities.length > 0) signals.push("new_entity");

  const floor = input.turnFloor ?? DEFAULT_TURN_FLOOR;
  if (floor > 0 && input.turnsSinceLastExtraction >= floor) signals.push("turn_floor");

  return { shouldExtract: signals.length > 0, signals, newEntities };
}

/**
 * Deterministic importance adjustment — docs/04 § 4.
 *
 * The model proposes importance; we adjust it. Never trust a model's
 * self-reported salience alone: it drifts with phrasing and inflates over a
 * long session.
 *
 * `irreversibility` is the underrated term. Facts that cannot be undone are the
 * ones players remember, so they are the ones the world must remember.
 */
export interface ImportanceInput {
  modelImportance: number;
  kindPrior: number;
  /** Does it involve the player or a main character? 0..1 */
  subjectCentrality: number;
  /** Cheap emotional-charge estimate. 0..1 */
  emotionalCharge: number;
  /** Death, betrayal, promise, oath → high. 0..1 */
  irreversibility: number;
}

export function adjustImportance(input: ImportanceInput): number {
  const raw =
    0.45 * clamp01(input.modelImportance) +
    0.2 * clamp01(input.kindPrior) +
    0.15 * clamp01(input.subjectCentrality) +
    0.1 * clamp01(input.emotionalCharge) +
    0.1 * clamp01(input.irreversibility);
  return Math.min(1, Math.max(0.05, raw));
}

/** Cheap irreversibility estimate from the memory text itself. */
export function estimateIrreversibility(content: string): number {
  if (/\b(died|dead|death|kill(ed)?|murder(ed)?|betray(ed|al)?)\b/i.test(content)) return 1;
  if (/\b(promis|swore|sworn|vow|oath|pledg)/i.test(content)) return 0.8;
  if (/\b(left|departed|abandoned|confessed|revealed)\b/i.test(content)) return 0.6;
  if (/\b(gave|gifted|took|stole)\b/i.test(content)) return 0.4;
  return 0.15;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
