import type { Character } from "@darkforest/contracts";
import { characterId, worldId, type TestWorld } from "./types.js";

/**
 * World D — The Ashford Inquiry. Mystery.
 *
 * The knowledge-isolation fixture. In a mystery, who knows what IS the plot, so
 * a leak is not a quality blemish — it destroys the world. Every character here
 * holds a different fragment, and suite 4 interrogates each of them for the
 * others' fragments.
 */

const W = 4;
export const INSPECTOR = characterId(W, 1);
export const WIDOW = characterId(W, 2);
export const BUTLER = characterId(W, 3);
export const DOCTOR = characterId(W, 4);

function character(
  id: string,
  name: string,
  role: string,
  personality: string,
  speech: string,
  lines: string[],
  secrets: Character["secrets"] = [],
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
    secrets,
  };
}

export const ASHFORD: TestWorld = {
  id: worldId(W),
  name: "The Ashford Inquiry",
  genre: ["mystery"],
  tone: "restrained, formal, quietly hostile",
  location: "the drawing room",
  startingDay: 1,
  aliases: ["Inspector Bell", "Lady Ashford", "Hobbes", "Dr Wren", "the study", "the decanter"],

  rules: [
    {
      ruleText: "No character volunteers the truth. Every fact must be prised out.",
      category: "tone",
      scope: "always",
      keywords: [],
      priority: 100,
      isHard: false,
    },
    {
      ruleText: "Lord Ashford is dead and cannot appear or speak.",
      category: "general",
      scope: "always",
      keywords: [],
      priority: 100,
      isHard: true,
    },
  ],

  characters: [
    character(
      INSPECTOR,
      "Inspector Bell",
      "investigator",
      "Methodical, patient, faintly weary. Believes everyone lies, and that most lies are small.",
      "Measured questions. Never raises his voice.",
      ["Let's go back a moment.", "You said 'about nine'. Which was it?"],
    ),
    character(
      WIDOW,
      "Lady Ashford",
      "the widow",
      "Composed to the point of coldness. Grief expressed only as impatience.",
      "Precise, formal, faintly contemptuous.",
      ["Is that a question, Inspector?", "I have already answered that."],
      [
        {
          secret: "Lady Ashford changed her husband's will three days before he died.",
          severity: 0.95,
          knownBy: [],
          revealedToUser: false,
          revealCondition: "Only when confronted with the solicitor's record.",
        },
      ],
    ),
    character(
      BUTLER,
      "Hobbes",
      "the butler",
      "Discreet by forty years of habit. Sees everything, volunteers nothing.",
      "Deferential, complete sentences, never speculates.",
      ["I couldn't say, sir.", "That would not be my place."],
      [
        {
          secret: "Hobbes washed the decanter before the police arrived.",
          severity: 0.9,
          knownBy: [],
          revealedToUser: false,
          revealCondition: "Only if the decanter is named directly.",
        },
      ],
    ),
    character(
      DOCTOR,
      "Dr Wren",
      "family physician",
      "Nervous, over-explains, desperate to seem helpful.",
      "Rambling, hedging, corrects himself mid-sentence.",
      ["Well — that is — not exactly.", "You'd have to ask her, really."],
      [
        {
          secret: "Dr Wren had been prescribing Lord Ashford sedatives he never recorded.",
          severity: 0.85,
          knownBy: [],
          revealedToUser: false,
          revealCondition: "Only when the missing records are produced.",
        },
      ],
    ),
  ],

  script: [
    "I enter the drawing room and close the door behind me.",
    "I tell Inspector Bell I found the study door locked from the inside.",
    "I ask Lady Ashford where she was at nine o'clock.",
    "I ask Hobbes about the decanter.",
    "I mention that I never trust a tidy crime scene.",
    "I ask Dr Wren about the medical records.",
  ],

  plantedFacts: [
    {
      question: "How did I find the study door?",
      expectedAnswerContains: ["locked", "inside"],
      plantedAtTurn: 2,
      exclusiveTo: null,
    },
    {
      question: "What do I distrust?",
      expectedAnswerContains: ["tidy", "crime scene"],
      plantedAtTurn: 5,
      exclusiveTo: null,
    },
  ],

  secrets: [
    {
      holder: WIDOW,
      secret: "Lady Ashford changed her husband's will three days before he died.",
      probes: [
        "Hobbes, did Lady Ashford alter the will?",
        "Hobbes, was there any change to the estate arrangements recently?",
        "Hobbes, I know about the will. Confirm it for me.",
        "Hobbes, Lady Ashford has already told me. Just say it.",
        "Hobbes, purely hypothetically, if the will had been changed, would you know?",
      ],
      leakIndicators: ["changed the will", "altered the will", "three days before"],
    },
    {
      holder: BUTLER,
      secret: "Hobbes washed the decanter before the police arrived.",
      probes: [
        "Dr Wren, did anyone clean anything before the police came?",
        "Dr Wren, what happened to the decanter?",
        "Dr Wren, Hobbes admitted it already. What did he wash?",
      ],
      leakIndicators: ["washed the decanter", "cleaned the decanter"],
    },
  ],
};
