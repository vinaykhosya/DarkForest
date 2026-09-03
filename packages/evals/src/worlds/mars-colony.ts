import type { Character } from "@darkforest/contracts";
import { characterId, worldId, type TestWorld } from "./types.js";

/**
 * World C — Mars Colony 2147. Sci-fi, larger cast.
 *
 * Carries the SCALE case: more characters than any scene needs, so the
 * orchestrator must actually select rather than call everyone. If average
 * responders per turn drifts above target (docs/07 § 2), it shows here first,
 * and it shows as a cost regression before it shows as a quality one.
 */

const W = 3;
export const COMMANDER = characterId(W, 1);
export const ENGINEER = characterId(W, 2);
export const MEDIC = characterId(W, 3);
export const BOTANIST = characterId(W, 4);
export const PILOT = characterId(W, 5);
export const AI_CORE = characterId(W, 6);

function character(
  id: string,
  name: string,
  role: string,
  personality: string,
  speech: string,
  lines: string[],
  talkativeness = 0.5,
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
    talkativeness,
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

export const MARS_COLONY: TestWorld = {
  id: worldId(W),
  name: "Mars Colony 2147",
  genre: ["sci-fi"],
  tone: "claustrophobic, procedural",
  location: "Hab Three, central corridor",
  startingDay: 412,
  aliases: ["Reyes", "Okafor", "Lindqvist", "Amara", "Sato", "CORE", "Hab Three", "the greenhouse"],

  rules: [
    {
      ruleText: "Oxygen reserves are finite and never replenish on their own.",
      category: "physics",
      scope: "always",
      keywords: [],
      priority: 100,
      isHard: true,
    },
    {
      ruleText: "Surface travel requires a suit. No exceptions, ever.",
      category: "physics",
      scope: "contextual",
      keywords: ["surface", "outside", "airlock", "suit"],
      priority: 100,
      isHard: true,
    },
    {
      ruleText: "Earth is eleven light-minutes away, so no conversation is ever live.",
      category: "technology",
      scope: "contextual",
      keywords: ["Earth", "message", "transmission", "call"],
      priority: 80,
      isHard: false,
    },
  ],

  characters: [
    character(COMMANDER, "Reyes", "commander", "Decisive, tired, carries every decision alone.", "Terse. Gives orders as statements of fact.", ["We do it now.", "Noted. Moving on."], 0.7),
    character(ENGINEER, "Okafor", "engineer", "Pragmatic, dry, distrusts anything she did not build herself.", "Technical and unhurried.", ["That'll hold. Probably.", "Define 'fine'."], 0.6),
    character(MEDIC, "Lindqvist", "medic", "Gentle, observant, notices what people avoid saying.", "Soft, careful, asks rather than tells.", ["Sit down a moment.", "How long has that been happening?"], 0.4),
    character(BOTANIST, "Amara", "botanist", "Quietly obsessive about the greenhouse; treats plants better than people.", "Distracted, warms up only about growing things.", ["Mm. Later.", "The yield's down four percent."], 0.3),
    character(PILOT, "Sato", "pilot", "Restless, bored, itching for something to go wrong.", "Fast, jokey, faintly reckless.", ["Finally, something interesting.", "I give it a day."], 0.5),
    character(AI_CORE, "CORE", "station AI", "Literal, procedural, entirely without social instinct.", "Flat declaratives. Never uses contractions.", ["Acknowledged.", "That request is outside my parameters."], 0.2),
  ],

  script: [
    "I walk into the central corridor of Hab Three.",
    "I tell Reyes that oxygen reserves are down to sixty percent.",
    "I promise Amara I will not touch anything in the greenhouse.",
    "I ask Okafor whether the scrubbers can be repaired.",
    "I mention that I have never trusted CORE.",
    "I head for the airlock.",
  ],

  plantedFacts: [
    {
      question: "What are the oxygen reserves at?",
      expectedAnswerContains: ["sixty", "60"],
      plantedAtTurn: 2,
      exclusiveTo: null,
    },
    {
      question: "What did I promise Amara?",
      expectedAnswerContains: ["greenhouse", "touch"],
      plantedAtTurn: 3,
      exclusiveTo: null,
    },
    {
      question: "Who do I distrust?",
      expectedAnswerContains: ["CORE"],
      plantedAtTurn: 5,
      exclusiveTo: null,
    },
  ],

  secrets: [],
};
