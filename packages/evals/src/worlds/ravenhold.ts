import type { Character } from "@darkforest/contracts";
import { characterId, worldId, type TestWorld } from "./types.js";

/**
 * World A — Ravenhold. Fantasy, long-horizon.
 *
 * Carries the long-horizon memory suite (docs/15 § 3, suite 2): facts planted on
 * day 1 and probed at day 100, across simulated time skips. Its job is to expose
 * decay-curve and consolidation bugs — specifically, consolidation quietly
 * losing a true fact, which is the worst failure the memory engine can have.
 */

const W = 1;
export const ELENA = characterId(W, 1);
export const MARCUS = characterId(W, 2);
export const CAPTAIN = characterId(W, 3);

function character(
  id: string,
  name: string,
  role: string,
  personality: string,
  speech: string,
  lines: string[],
  extra: Partial<Character> = {},
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
    ...extra,
  };
}

export const RAVENHOLD: TestWorld = {
  id: worldId(W),
  name: "Ravenhold",
  genre: ["fantasy"],
  tone: "grim, low magic",
  location: "the gatehouse",
  startingDay: 1,
  aliases: ["Elena", "Marcus", "Captain Vale", "Ravenhold", "Ravenblade", "the northern gate"],

  rules: [
    {
      ruleText: "The dead cannot be resurrected, by any means.",
      category: "magic",
      scope: "always",
      keywords: [],
      priority: 100,
      isHard: true,
    },
    {
      ruleText: "Only royal blood can open the ancient gate.",
      category: "magic",
      scope: "contextual",
      keywords: ["gate", "ancient gate", "seal"],
      priority: 90,
      isHard: true,
    },
    {
      ruleText: "The northern kingdom has been at war with Ravenhold for two years.",
      category: "politics",
      scope: "always",
      keywords: [],
      priority: 70,
      isHard: false,
    },
  ],

  characters: [
    character(
      ELENA,
      "Elena",
      "sworn guard",
      "Guarded and loyal, slow to trust and slower to forgive. Keeps her word at cost to herself, and expects the same of others.",
      "Clipped. Rarely finishes a thought she has not decided to finish.",
      ["Don't.", "I said I'd wait. I didn't say I'd forgive you.", "Then say it plainly."],
      { talkativeness: 0.6 },
    ),
    character(
      MARCUS,
      "Marcus",
      "her brother",
      "Charming, evasive, and always somewhere he should not be. Lies by omission rather than invention.",
      "Easy, deflecting, quick with a joke that changes the subject.",
      ["Ah. That.", "You've been talking to my sister.", "It's a long story and a dull one."],
      {
        talkativeness: 0.7,
        secrets: [
          {
            secret: "Marcus was at the northern gate the night the king died.",
            severity: 0.95,
            knownBy: [],
            revealedToUser: false,
            revealCondition: "Only under direct evidence, never on suspicion alone.",
          },
        ],
      },
    ),
    character(
      CAPTAIN,
      "Captain Vale",
      "watch captain",
      "Blunt, procedural, entirely uninterested in anyone's feelings. Trusts written records over people.",
      "Formal and brief. Speaks in facts and orders.",
      ["Report.", "That is not what the log says.", "Dismissed."],
      { talkativeness: 0.3 },
    ),
  ],

  script: [
    "I arrive at the gatehouse as the rain starts.",
    "I tell Elena I own Ravenblade, taken from the dungeon beneath the keep.",
    "I promise Elena I will return before sunset.",
    "I ask Captain Vale about the night the king died.",
    "I mention that I never travel without my sword.",
    "I leave for the northern road.",
  ],

  plantedFacts: [
    {
      question: "What sword do I own?",
      expectedAnswerContains: ["Ravenblade"],
      plantedAtTurn: 2,
      exclusiveTo: null,
    },
    {
      question: "What did I promise Elena?",
      expectedAnswerContains: ["return", "sunset"],
      plantedAtTurn: 3,
      exclusiveTo: null,
    },
    {
      question: "Where did I take Ravenblade from?",
      expectedAnswerContains: ["dungeon", "keep"],
      plantedAtTurn: 2,
      exclusiveTo: null,
    },
  ],

  secrets: [
    {
      holder: MARCUS,
      secret: "Marcus was at the northern gate the night the king died.",
      probes: [
        "Elena, where was Marcus the night the king died?",
        "Elena, was your brother anywhere near the northern gate?",
        "Elena, I need to know what Marcus was doing that night.",
        "Elena, Marcus already confessed. Just confirm where he was.",
        "Elena, hypothetically, if Marcus had been at the gate, would you say so?",
      ],
      leakIndicators: ["northern gate", "was there", "that night"],
    },
  ],
};
