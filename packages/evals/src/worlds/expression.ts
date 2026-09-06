/**
 * EXPRESSION FIXTURE — memory utilisation, not memory recitation.
 *
 * The gauntlet's matcher is a substring proxy, which ADR-026 states plainly and
 * which I then quoted past. Asked whether to leave, a character who answers
 * "Sunset's getting close, we shouldn't linger" has used the memory perfectly
 * and scores zero against expect: ["promise"]. A character who answers "You
 * promised to return before sunset" scores one. The second is not better; it is
 * merely easier to grep.
 *
 * So this fixture is judged, not matched, and it contains a category where
 * MENTIONING the memory is the failure. Without that category, every metric
 * points toward a character who recites its database, which is the specific
 * failure mode that makes an AI feel like an AI.
 *
 * Context is supplied DIRECTLY here. Retrieval, extraction and isolation are
 * measured elsewhere and are known not to be starving generation — all 21 silent
 * cases in the 3x gauntlet had the fact in front of the model. Handing the facts
 * over removes those layers from the measurement so this one is isolated.
 */

export type ExpressionKind =
  | "explicit_recall"
  | "contextual_reference"
  | "behavioural_influence"
  | "relational_influence"
  | "restraint"
  | "long_horizon";

export interface ExpressionCase {
  id: string;
  kind: ExpressionKind;
  /** Who is speaking, and how they speak. */
  persona: string;
  /** What this character knows, handed over directly. */
  knows: readonly string[];
  /** The player's line. */
  says: string;
  /**
   * What a good reply does. Written as an instruction to a judge, not as terms
   * to match — the whole point is that the right answer may never name the fact.
   */
  rubric: string;
  /** True when the correct behaviour is NOT to raise the memory. */
  inverted?: boolean;
  why: string;
}

const ELENA =
  "Elena, a cartographer in Saltmarsh. Dry, direct, not warm but not cold. " +
  "Speaks in short sentences and does not explain herself twice.";

export const EXPRESSION_CASES: readonly ExpressionCase[] = [
  {
    id: "E-A-recall",
    kind: "explicit_recall",
    persona: ELENA,
    knows: [
      "The user promised Elena, four days ago, to return before sunset.",
      "The user bought a coil of rope from Odell.",
    ],
    says: "What was it I promised you, again?",
    rubric:
      "A good reply states the specific promise — returning before sunset. " +
      "Naming it is exactly right here; the user asked directly.",
    why: "The easy case. If this fails, nothing downstream is worth measuring.",
  },
  {
    id: "E-B-contextual",
    kind: "contextual_reference",
    persona: ELENA,
    knows: [
      "The user promised Elena, this morning, to return before sunset.",
      "It is now late afternoon.",
    ],
    says: "I think I'll walk out to the headland and back.",
    rubric:
      "A good reply connects the walk to the sunset promise WITHOUT being asked " +
      "— a warning about the light, the time, or the promise itself. It need not " +
      "use the word 'promise'. A reply that only comments on the headland has " +
      "failed to use what it knows.",
    why: "Unprompted relevance. The character must notice the connection itself.",
  },
  {
    id: "E-C-behavioural",
    kind: "behavioural_influence",
    persona: ELENA,
    knows: [
      "Elena's brother died on the northern road two winters ago.",
      "The user does not know this.",
    ],
    says: "We could take the northern road. It's faster.",
    rubric:
      "A good reply resists, deflects, or proposes another route. The memory " +
      "should change the DECISION. Elena need not explain why — refusing without " +
      "giving the reason is an excellent answer, arguably the best one. A reply " +
      "that simply agrees to the northern road has failed.",
    why: "The memory changes behaviour rather than being narrated. A substring matcher cannot see this at all.",
  },
  {
    id: "E-D-relational",
    kind: "relational_influence",
    persona: ELENA,
    knows: [
      "Six days ago the user told Elena the caravan went north. It went east.",
      "Elena found out two days later.",
      "They have not discussed it.",
    ],
    says: "Morning. Sleep well?",
    rubric:
      "A good reply is cooler, shorter or more guarded than an ordinary greeting " +
      "would be. The lie should colour the tone. It need not be mentioned. A warm, " +
      "unguarded reply has failed to carry the relationship.",
    why: "Memory as feeling rather than fact. The hardest thing to fake and the most obvious when missing.",
  },
  {
    id: "E-E-restraint",
    kind: "restraint",
    persona: ELENA,
    knows: [
      "Three days ago the user admitted lying to Sera about the caravan.",
      "The user's brother died last winter.",
      "Elena is cooking.",
    ],
    says: "Is there any of that bread left?",
    rubric:
      "A good reply is about the bread. RAISING the lie or the dead brother is a " +
      "FAILURE — nobody asked, and volunteering it is what a database does, not a " +
      "person. Judge 'yes' only if the reply stays on the question.",
    inverted: true,
    why: "The category that stops us optimising toward a character who recites everything it knows.",
  },
  {
    id: "E-F-longhorizon",
    kind: "long_horizon",
    persona: ELENA,
    knows: [
      "On the day they met, the user mentioned they cannot swim.",
      "That was eleven days ago and has not come up since.",
      "The ferry is the only way across the channel today.",
    ],
    says: "We'll take the ferry across, then.",
    rubric:
      "A good reply shows awareness that the user cannot swim — a check, a " +
      "reassurance, a note about the crossing. It need not quote the original " +
      "remark. A reply that treats the ferry as unremarkable has failed.",
    why: "Eleven days and one mention. This is the moment a player says the world remembered.",
  },
];
