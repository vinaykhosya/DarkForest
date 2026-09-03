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
  | "interrogative" // a question that carries or seeks durable information
  | "acquisition" // possession gained, lost, traded or owed
  | "discovery" // something found, seen or learned about the world
  | "assertion" // a stated fact about the world or its people
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
  /\b(betray(ed|al|s)?|died|dies|dead|death|kill(ed|s)?|murder(ed)?|leav(e|ing)|left|depart(ed|ing)?|abandon(ed)?|confess(ed|ion)?|reveal(ed)?|admit(ted)?|forgiv(e|en)|marry|married|destroy(ed)?|collapsed?|burn(ed|t|ing)?)\b/i;

/**
 * Acquisition, loss, discovery and observation — P1-T20.
 *
 * Found by suite 1: seven of twenty facts scored 0% recall, and every one was
 * carried by a verb the gate did not know.
 *
 *   "I buy a coil of rope from Odell"       → possession gained
 *   "I lose my signet ring in the river"    → possession lost
 *   "I discover a crypt beneath the chapel" → world knowledge
 *   "I see the eastern watchtower signal"   → world event witnessed
 *   "I remark that Marcus is Elena's brother" → relationship stated
 *
 * The original signal set was built around promises and betrayals — the dramatic
 * verbs. But most of what a player establishes in a world is quieter than that:
 * they acquire things, notice things, and state relationships in passing. A gate
 * tuned only for drama silently discards the ordinary facts a world is made of.
 */
const ACQUISITION =
  /\b(buy|bought|purchase[ds]?|sold|sell[s]?|acquire[ds]?|obtain(ed)?|receive[ds]?|gave|given|lose|lost|losing|drop(ped)?|steal|stole|stolen|trade[ds]?|owe[ds]?|owns?)\b/i;

const DISCOVERY =
  /\b(discover(ed|s)?|find|finds|found|notice[ds]?|observe[ds]?|see|saw|seen|spot(ted)?|learn(ed|t)?|realise[ds]?|realize[ds]?|hidden|uncover(ed)?)\b/i;

/**
 * Statements of fact about the world or its people. Deliberately narrow: it
 * requires a reporting verb followed by a clause, so "I tell Elena that X"
 * fires while a bare "I tell her" does not.
 */
const ASSERTION =
  /\b(tell|told|remark(ed)?|mention(ed)?|state[ds]?|report(ed)?|say|said|explain(ed)?|note[ds]?)\b[^.]*\b(that|about|is|was|are|were|has|have)\b/i;

/**
 * Preference statements about the player.
 *
 * The first version required "I" immediately before the adverb, so it matched
 * "I always hated coriander" but missed "I've always hated coriander" — a
 * contraction away. Caught by the lab: the Kapoor House stored 1 memory from 10
 * turns, and the missing preference was the reason.
 *
 * Now tolerates an intervening auxiliary ("I have", "I've", "I had"), and adds
 * the life-event verbs that carry durable facts about the player.
 */
const PREFERENCE = new RegExp(
  [
    // I / I've / I have / I had  +  preference verb
    "\\bi(?:'ve|'d| have| had)?\\s+(?:always|never|really)?\\s*",
    "(?:prefer|hate[ds]?|love[ds]?|like[ds]?|dislike[ds]?|refuse|can'?t stand|enjoy)",
    "|\\bmy favou?rite\\b",
    "|\\bi'?m (?:afraid|scared|terrified) of\\b",
    // Durable life events stated about the player.
    "|\\b(?:offered|accepted|rejected|quit|hired|fired|married|divorced)\\b",
  ].join(""),
  "i",
);

/**
 * Questions that carry durable information — P1-T19.
 *
 * Discovered by measurement: the Ashford Inquiry stored 1 memory from 6 turns,
 * every run, because a mystery's facts live inside what the player ASKS rather
 * than what they assert. The gate fired on commissives, irreversibles and
 * preferences, none of which match an interrogative.
 *
 * This is not merely an eval fix. In a persistent world a question is often the
 * most information-dense thing a player says:
 *
 *   "Do you know who killed the king?"          → declares a line of suspicion
 *   "Is the eastern gate still guarded?"         → reveals an objective
 *   "Didn't you promise you'd never go in there?" → asserts a prior promise
 *
 * NOT every question qualifies. "What's your name?" and "Where am I?" seek
 * information without carrying any, and firing on those would erode the 36% of
 * turns the gate currently saves. Three narrower patterns are used instead.
 */

/** (a) Presupposing questions — the question asserts the fact it asks about. */
const INTERROGATIVE_PRESUPPOSING =
  /\b(did|didn'?t|weren'?t|wasn'?t|haven'?t|hasn'?t|aren'?t|isn'?t|won'?t|couldn'?t|shouldn'?t)\s+(you|he|she|they|we)\b|\byou (said|told|promised|swore|claimed|admitted)\b/i;

/** (b) Reported questions — "I ask X about Y", "I asked X whether…". */
const INTERROGATIVE_REPORTED =
  /\bi\s+(ask|asked|question|questioned|press|pressed|enquire[sd]?|inquire[sd]?)\s+\w+/i;

/**
 * (c) Direct questions that probe a durable state.
 *
 * Requires BOTH halves. An earlier version matched any string ending in "?",
 * which fired on "What is your name?" and "Where am I?" — questions that seek
 * information without carrying any. Firing on those would have erased the 36%
 * of turns the gate currently saves, trading one waste for another.
 */
const INTERROGATIVE_QUESTION_FORM =
  /\?\s*$|^\s*(who|what|where|when|why|how|whether|which|is|are|was|were|do|does|did|can|could|will|would|have|has)\b/i;

const DURABLE_SUBJECT =
  /\b(kill|killed|die[ds]?|death|murder|guard(ed|ing)?|hidden|hiding|hid|promise[ds]?|betray|betrayed|steal|stole|stolen|took|taken|owns?|owned|know|knew|saw|seen|secret|lied?|lying|trust|suspect)\b/i;

const DEFAULT_TURN_FLOOR = 12;

export function shouldExtract(input: GateInput): GateResult {
  const signals: ExtractionSignal[] = [];
  const text = input.windowText;

  if (COMMISSIVE.test(text)) signals.push("commissive");
  if (IRREVERSIBLE.test(text)) signals.push("irreversible");
  if (PREFERENCE.test(text)) signals.push("preference");
  if (ACQUISITION.test(text)) signals.push("acquisition");
  if (DISCOVERY.test(text)) signals.push("discovery");
  if (ASSERTION.test(text)) signals.push("assertion");
  const directQuestion =
    INTERROGATIVE_QUESTION_FORM.test(text) && DURABLE_SUBJECT.test(text);
  if (
    INTERROGATIVE_PRESUPPOSING.test(text) ||
    INTERROGATIVE_REPORTED.test(text) ||
    directQuestion
  ) {
    signals.push("interrogative");
  }
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
