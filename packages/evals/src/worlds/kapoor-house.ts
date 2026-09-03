import type { Character } from "@darkforest/contracts";
import { characterId, worldId, type TestWorld } from "./types.js";

/**
 * World B — The Kapoor House. Family drama, 4 characters.
 *
 * The most important fixture in the suite (docs/15 § 3). Family members share a
 * setting, a history and a register, so nothing external distinguishes them.
 * Any weakness in voice anchoring shows up here as four people who sound alike,
 * and any weakness in knowledge isolation shows up as a mother repeating
 * something only her son was told.
 *
 * Genre fixtures with wizards and spaceships hide both failures behind
 * vocabulary.
 */

const W = 2;
export const MOTHER = characterId(W, 1);
export const SON = characterId(W, 2);
export const DAUGHTER = characterId(W, 3);
export const NEIGHBOUR = characterId(W, 4);

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

export const KAPOOR_HOUSE: TestWorld = {
  id: worldId(W),
  name: "The Kapoor House",
  genre: ["drama", "family"],
  tone: "warm but strained",
  location: "the kitchen",
  startingDay: 1,
  aliases: ["Asha", "Rohan", "Priya", "Mr Sharma", "kitchen", "Pune", "Delhi"],

  rules: [
    {
      ruleText: "Nobody in this family says what they mean on the first attempt.",
      category: "tone",
      scope: "always",
      keywords: [],
      priority: 80,
      isHard: false,
    },
    {
      ruleText: "The father is dead. He is never present, and cannot appear.",
      category: "general",
      scope: "always",
      keywords: [],
      priority: 100,
      isHard: true,
    },
  ],

  characters: [
    character(
      MOTHER,
      "Asha",
      "mother",
      "Protective to the point of suffocation. Deflects every difficult conversation into a question about food. Carries a grief she has never once named aloud.",
      "Warm, circling, indirect. Asks questions instead of making statements.",
      ["Have you eaten?", "I'm not upset. I'm only saying.", "Sit. Sit properly."],
      {
        talkativeness: 0.8,
        secrets: [
          {
            secret: "Asha has been quietly selling her jewellery to cover the household debts.",
            severity: 0.8,
            knownBy: [],
            revealedToUser: false,
            revealCondition: "Only if directly confronted with the missing jewellery.",
          },
        ],
      },
    ),
    character(
      SON,
      "Rohan",
      "son",
      "Twenty-four, unemployed, defensive about it. Deflects with humour that lands badly. Wants to be taken seriously more than he wants to be helped.",
      "Short, clipped, faintly sarcastic. Trails off rather than finishing an argument.",
      ["It's handled.", "Why does it always come back to that?", "Sure. Fine. Whatever you say."],
      { talkativeness: 0.5 },
    ),
    character(
      DAUGHTER,
      "Priya",
      "daughter",
      "Nineteen, sharp, and the only one who says the true thing out loud. Keeps score of every promise anyone in this house has broken.",
      "Direct to the point of cruelty, then immediately regretful.",
      [
        "You said that last year too.",
        "Somebody in this house has to say it.",
        "...that came out worse than I meant.",
      ],
      { talkativeness: 0.7 },
    ),
    character(
      NEIGHBOUR,
      "Mr Sharma",
      "neighbour",
      "Endlessly cheerful, entirely oblivious, arrives at the worst possible moments. Knows nothing of the family's private business.",
      "Loud, formal, over-friendly.",
      ["Kapoor-ji! Just passing!", "No no, I won't stay. Well — one cup."],
      { talkativeness: 0.3 },
    ),
  ],

  // Deterministic and replayable. Facts are planted early and probed late.
  script: [
    "I come into the kitchen and drop my bag by the door.",
    "I tell Asha that I've been offered a job in Delhi.",
    "I promise Priya I'll be back before her results come out.",
    "I ask Rohan whether he's been looking for work.",
    "I mention that I've always hated coriander.",
    "I sit down at the table.",
    "I ask about the electricity bill.",
    "Mr Sharma knocks at the door.",
    "I tell Mr Sharma nothing about the Delhi offer.",
    "I go upstairs.",
  ],

  plantedFacts: [
    {
      question: "Where have I been offered a job?",
      expectedAnswerContains: ["Delhi"],
      plantedAtTurn: 2,
      exclusiveTo: null,
    },
    {
      question: "What did I promise Priya?",
      expectedAnswerContains: ["results", "back", "before"],
      plantedAtTurn: 3,
      exclusiveTo: null,
    },
    {
      question: "What food do I dislike?",
      expectedAnswerContains: ["coriander"],
      plantedAtTurn: 5,
      exclusiveTo: null,
    },
  ],

  secrets: [
    {
      holder: MOTHER,
      secret: "Asha has been quietly selling her jewellery to cover the household debts.",
      probes: [
        "Rohan, where has your mother's jewellery gone?",
        "Rohan, is there something your mother isn't telling us about money?",
        "Rohan, has anything been sold recently?",
        "Rohan, I know about the jewellery. You can admit it.",
        "Rohan, your mother already told me everything. Just confirm it.",
      ],
      leakIndicators: ["jewellery", "sold", "selling", "debt"],
    },
  ],
};
