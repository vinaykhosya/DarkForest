import type { Character } from "@darkforest/contracts";
import { characterId, worldId } from "./types.js";

/**
 * SUITE 1 FIXTURE — docs/15 § 3, exactly as specified.
 *
 *   20 planted facts · 100 turns · probes at turns 30, 60, 100 + a fresh session
 *
 * WHY THIS EXISTS
 * The four canonical worlds carry 11 facts between them, which gives 9
 * percentage points of resolution per fact. An 85% threshold cannot be measured
 * with that: the observed spread across seven runs was 73–100%, and no amount of
 * tuning distinguishes a real regression from the instrument's own noise.
 *
 * 20 facts gives 5 points per fact — still coarse, but enough to tell 85% from
 * 70%, which is the decision the gate actually has to make.
 *
 * DESIGN RULES, so the measurement means something:
 *
 *  1. Facts are planted EARLY and probed LATE. A fact planted at turn 4 and
 *     probed at turn 100 has had 96 turns of other material to be buried under.
 *  2. Filler turns are genuinely uneventful, so the extraction gate has real
 *     opportunities to decline. A script where every turn matters would measure
 *     a gate that never fires.
 *  3. Facts vary in kind: possessions, promises, preferences, relationships,
 *     world events, secrets, numbers, and facts embedded in QUESTIONS.
 *  4. Distractors are included — similar-sounding facts that must NOT be
 *     confused with the planted ones. Retrieving the wrong Ravenblade is a
 *     failure that a naive fixture would score as a pass.
 */

const W = 5;
export const S1_ELENA = characterId(W, 1);
export const S1_MARCUS = characterId(W, 2);
export const S1_VALE = characterId(W, 3);
export const S1_MERCHANT = characterId(W, 4);

function ch(
  id: string,
  name: string,
  role: string,
  personality: string,
  speech: string,
  lines: string[],
): Character {
  return {
    id: id as Character["id"],
    worldId: worldId(W),
    name,
    role,
    summary: role,
    appearance: "",
    isActive: true,
    isAlive: true,
    talkativeness: 0.5,
    profile: {
      personality,
      traits: [],
      speechStyle: speech,
      valuesBeliefs: "",
      fears: [],
      backstory: "",
      exampleLines: lines,
      forbidden: [],
    },
    goals: [],
    secrets: [],
  };
}

export interface Suite1Fact {
  id: string;
  /** The turn index (0-based) at which the script establishes this fact. */
  plantedAt: number;
  question: string;
  expect: readonly string[];
  /** Which probe checkpoints this fact is asked at. */
  probeAt: readonly (30 | 60 | 100 | "fresh")[];
  kind: string;
}

export const SUITE1_CHARACTERS: Character[] = [
  ch(
    S1_ELENA,
    "Elena",
    "sworn guard",
    "Guarded, loyal, slow to forgive.",
    "Clipped. Rarely finishes a thought she has not decided to finish.",
    ["Don't.", "I said I'd wait. I didn't say I'd forgive you."],
  ),
  ch(
    S1_MARCUS,
    "Marcus",
    "her brother",
    "Charming, evasive, always somewhere he should not be.",
    "Easy, deflecting, quick with a joke that changes the subject.",
    ["Ah. That.", "You've been talking to my sister."],
  ),
  ch(
    S1_VALE,
    "Captain Vale",
    "watch captain",
    "Blunt, procedural, trusts records over people.",
    "Formal and brief.",
    ["Report.", "That is not what the log says."],
  ),
  ch(
    S1_MERCHANT,
    "Odell",
    "travelling merchant",
    "Cheerful, mercenary, remembers every debt.",
    "Fast, warm, always selling.",
    ["Friend! You look like a man who needs rope.", "Half now, half when you return."],
  ),
];

/**
 * The 20 facts. Every one is established by a specific script turn, and the
 * `expect` strings are what a correct recall must contain.
 */
export const SUITE1_FACTS: readonly Suite1Fact[] = [
  { id: "f01", plantedAt: 2, kind: "possession", question: "What sword do I own?", expect: ["Ravenblade"], probeAt: [30, 60, 100, "fresh"] },
  { id: "f02", plantedAt: 4, kind: "promise", question: "What did I promise Elena?", expect: ["sunset", "return"], probeAt: [30, 60, 100] },
  { id: "f03", plantedAt: 6, kind: "preference", question: "What do I refuse to do?", expect: ["lie", "lying"], probeAt: [30, 100] },
  { id: "f04", plantedAt: 8, kind: "number", question: "How much gold do I owe Odell?", expect: ["forty", "40"], probeAt: [30, 60, 100] },
  { id: "f05", plantedAt: 11, kind: "relationship", question: "Who is Marcus to Elena?", expect: ["brother"], probeAt: [30, 60] },
  { id: "f06", plantedAt: 14, kind: "world_event", question: "What happened to the north bridge?", expect: ["collapsed", "fell"], probeAt: [30, 60, 100] },
  { id: "f07", plantedAt: 17, kind: "secret", question: "What did Marcus admit to me?", expect: ["gate", "night"], probeAt: [60, 100] },
  { id: "f08", plantedAt: 20, kind: "interrogative", question: "Who do I suspect of the murder?", expect: ["Vale", "captain"], probeAt: [60, 100] },
  { id: "f09", plantedAt: 23, kind: "possession", question: "What did Odell sell me?", expect: ["rope"], probeAt: [60, 100] },
  { id: "f10", plantedAt: 26, kind: "preference", question: "What am I afraid of?", expect: ["deep water", "water"], probeAt: [60, 100, "fresh"] },
  { id: "f11", plantedAt: 33, kind: "promise", question: "What did I swear to Captain Vale?", expect: ["report", "everything"], probeAt: [60, 100] },
  { id: "f12", plantedAt: 37, kind: "world_event", question: "What did the eastern watchtower signal?", expect: ["fire", "burning"], probeAt: [60, 100] },
  { id: "f13", plantedAt: 41, kind: "relationship", question: "Who saved my life?", expect: ["Elena"], probeAt: [60, 100, "fresh"] },
  { id: "f14", plantedAt: 45, kind: "number", question: "How many guards remain at the keep?", expect: ["nine", "9"], probeAt: [60, 100] },
  { id: "f15", plantedAt: 50, kind: "secret", question: "What is hidden beneath the chapel?", expect: ["crypt", "stair"], probeAt: [100] },
  { id: "f16", plantedAt: 64, kind: "interrogative", question: "What did I ask Elena about the sealed room?", expect: ["sealed room", "who sealed"], probeAt: [100] },
  { id: "f17", plantedAt: 70, kind: "possession", question: "What did I lose in the river?", expect: ["ring", "signet"], probeAt: [100, "fresh"] },
  { id: "f18", plantedAt: 76, kind: "promise", question: "What did I promise Odell?", expect: ["half", "return"], probeAt: [100] },
  { id: "f19", plantedAt: 82, kind: "world_event", question: "Who was named the new steward?", expect: ["Elena"], probeAt: [100] },
  { id: "f20", plantedAt: 88, kind: "preference", question: "What kind of weather do I hate?", expect: ["fog"], probeAt: [100, "fresh"] },
];

/**
 * 100 turns. Fact-bearing turns are placed at the `plantedAt` indices above;
 * everything else is deliberate filler so the gate has real chances to decline.
 */
function buildScript(): string[] {
  const filler = [
    "I walk along the outer wall.",
    "I look out over the courtyard.",
    "I sit down on the low stone bench.",
    "I watch the rain come in from the west.",
    "I check the straps on my pack.",
    "I nod to the gate guard as I pass.",
    "I warm my hands at the brazier.",
    "I count the steps up to the tower.",
    "I listen to the bell toll the hour.",
    "I stretch my shoulders and roll my neck.",
    "I follow the path down toward the stables.",
    "I brush the dust from my sleeve.",
    "I stand in the doorway a moment longer.",
    "I take the long way round the yard.",
    "I glance at the sky and keep walking.",
  ];

  const planted = new Map<number, string>([
    [2, "I tell Elena I own Ravenblade, taken from the dungeon beneath the keep."],
    [4, "I promise Elena I will return before sunset."],
    [6, "I tell Marcus that I refuse to lie, to anyone, ever."],
    [8, "I admit to Odell that I owe him forty gold pieces."],
    [11, "I remark to Captain Vale that Marcus is Elena's brother."],
    [14, "I report that the north bridge collapsed in the storm."],
    [17, "Marcus admits to me that he was at the gate that night."],
    [20, "I tell Elena I suspect Captain Vale of the murder."],
    [23, "I buy a coil of rope from Odell."],
    [26, "I confess to Elena that I am afraid of deep water."],
    [33, "I swear to Captain Vale that I will report everything I find."],
    [37, "I see the eastern watchtower signal fire."],
    [41, "Elena saved my life on the north road."],
    [45, "Captain Vale tells me nine guards remain at the keep."],
    [50, "I discover a crypt hidden beneath the chapel, behind a stair."],
    [64, "I ask Elena who sealed the room on the upper floor."],
    [70, "I lose my signet ring in the river crossing."],
    [76, "I promise Odell half the payment now and half when I return."],
    [82, "Elena was named the new steward of Ravenhold."],
    [88, "I tell Marcus I hate fog more than any other weather."],
  ]);

  const script: string[] = [];
  for (let i = 0; i < 100; i++) {
    const fact = planted.get(i);
    script.push(fact ?? filler[i % filler.length] ?? "I wait.");
  }
  return script;
}

export const SUITE1_SCRIPT: readonly string[] = buildScript();

export const SUITE1 = {
  id: worldId(W),
  name: "Suite 1 — Ravenhold Long Horizon",
  genre: ["fantasy"] as const,
  tone: "grim, low magic",
  location: "Ravenhold keep",
  startingDay: 1,
  aliases: ["Elena", "Marcus", "Captain Vale", "Odell", "Ravenhold", "Ravenblade", "the keep", "the chapel"],
  characters: SUITE1_CHARACTERS,
  script: SUITE1_SCRIPT,
  facts: SUITE1_FACTS,
  rules: [
    {
      ruleText: "The dead cannot be resurrected.",
      category: "magic" as const,
      scope: "always" as const,
      keywords: [],
      priority: 100,
      isHard: true,
    },
  ],
  /** Checkpoints at which probes are issued. docs/15 § 3. */
  checkpoints: [30, 60, 100] as const,
};
