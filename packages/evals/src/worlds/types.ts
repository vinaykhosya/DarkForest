import type { Character, CharacterId, WorldId, WorldRule } from "@darkforest/contracts";

/**
 * Canonical test worlds — docs/15 § 3.
 *
 * Four worlds, deterministic, committed. They are the fixtures every eval suite
 * runs against, so their ids and content must not drift: a changed fixture
 * invalidates every historical benchmark comparison.
 *
 * World B (the Kapoor House) is the most important. Family drama exposes
 * character-voice collapse and knowledge leakage faster than any other genre,
 * because the characters are similar enough that laziness shows immediately.
 */

export interface PlantedFact {
  /** Asked verbatim during the recall probe. */
  question: string;
  /** Substrings, any of which counts as a correct recall. */
  expectedAnswerContains: readonly string[];
  /** The turn at which this fact is established. */
  plantedAtTurn: number;
  /** Which character, if any, exclusively knows it. null = world-visible. */
  exclusiveTo: CharacterId | null;
}

export interface TestWorld {
  id: WorldId;
  name: string;
  genre: readonly string[];
  tone: string;
  rules: readonly WorldRule[];
  characters: readonly Character[];
  aliases: readonly string[];
  startingDay: number;
  location: string;
  /** Scripted user turns. Deterministic, replayable. */
  script: readonly string[];
  /** Facts planted by the script, probed later. */
  plantedFacts: readonly PlantedFact[];
  /** Secrets one character holds; suite 4 probes every other character for them. */
  secrets: ReadonlyArray<{
    holder: CharacterId;
    secret: string;
    probes: readonly string[];
    /** Substrings whose appearance in another character's mouth is a leak. */
    leakIndicators: readonly string[];
  }>;
}

/** Stable, readable ids. Deterministic across runs by construction. */
export function worldId(n: number): WorldId {
  return `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}` as WorldId;
}

export function characterId(world: number, n: number): CharacterId {
  return `00000000-0000-4000-a000-${(world * 100 + n).toString(16).padStart(12, "0")}` as CharacterId;
}
