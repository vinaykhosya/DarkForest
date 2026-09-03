import { estimateTokens } from "@darkforest/core";

/**
 * Memory extraction prompt, version 1 — docs/04 § 4.
 *
 * Deliberately has NO creative framing and no character identity. Creativity is
 * the enemy of extraction: a model in storytelling mode invents memories that
 * read beautifully and were never established. This prompt is closer to a
 * data-entry instruction than to the dialogue prompt.
 *
 * The selectivity instruction is the load-bearing part. Left unconstrained,
 * models extract something from every turn; the target is ≤3 memories per 10
 * turns (docs/04 § 4), and over-extraction is what exhausts free-tier storage
 * and drowns retrieval in trivia.
 */

export const EXTRACT_PROMPT_VERSION = "extract/v1";

export interface ExtractPromptInput {
  /** The rolling window, oldest first, already speaker-labelled. */
  transcript: ReadonlyArray<{ speaker: string; content: string }>;
  worldDay: number;
  /** Names the model may use as subjects. Prevents invented entities. */
  knownEntities: ReadonlyArray<{ ref: string; name: string }>;
  /** 0..1 from world_settings. Higher extracts more freely. */
  aggressiveness: number;
  /** Existing memory bodies, so the model does not restate what we already hold. */
  existingMemories: readonly string[];
}

export function renderExtractPrompt(input: ExtractPromptInput): {
  system: string;
  user: string;
  version: string;
  estimatedTokens: number;
} {
  const maxMemories = input.aggressiveness < 0.34 ? 1 : input.aggressiveness < 0.67 ? 2 : 3;

  const system = [
    `You extract durable facts from a roleplay transcript. You are not a storyteller.`,
    `Do not invent, embellish, or infer beyond what the text states.`,
    ``,
    `WHAT EARNS A MEMORY`,
    `Record anything a reader would find it strange for a character to have`,
    `forgotten two weeks later.`,
    ``,
    `RECORD: promises and oaths · betrayals · deaths · departures and arrivals ·`,
    `revealed secrets · relationship changes · stated likes, dislikes and fears ·`,
    `possessions gained or lost · plans announced · facts about people or places.`,
    ``,
    `Worked examples — these all earn a memory:`,
    `  "I tell Elena I own Ravenblade, taken from the dungeon"`,
    `     -> "The user owns Ravenblade, taken from the dungeon beneath the keep."`,
    `  "I've been offered a job in Delhi"`,
    `     -> "The user has been offered a job in Delhi."`,
    `  "I've always hated coriander"`,
    `     -> "The user dislikes coriander."`,
    `  "I found the study door locked from the inside"`,
    `     -> "The user found the study door locked from the inside."`,
    ``,
    `SKIP: pure movement with no new information, greetings, and anything already`,
    `listed under ALREADY KNOWN. If a turn genuinely contains nothing new, return`,
    `an empty array — but do not skip a fact merely because it seems small.`,
    ``,
    `HOW TO WRITE ONE`,
    `1. One fact per memory. Split anything containing "and".`,
    `2. Third person, past tense, self-contained. "He said he would" is useless in`,
    `   three weeks; "The user promised Elena he would return before sunset" is not.`,
    `3. Resolve every pronoun to a name. The retrieval context is not this context.`,
    `4. At most 200 characters.`,
    `5. Day-stamp anything time-bound. Today is day ${String(input.worldDay)}.`,
    ``,
    `KIND`,
    `episodic   something that happened at a time`,
    `semantic   something that is true, timelessly`,
    `relational how two entities regard each other, and why`,
    `world      a global event affecting everyone`,
    `persona    a fact about the player`,
    ``,
    `KNOWLEDGE`,
    `Set knownBy to the NAMES of characters who witnessed or were told the fact.`,
    `Leave it empty when the whole world would know. Getting this wrong causes a`,
    `character to reveal a secret they were never told, so err toward fewer.`,
    ``,
    `IMPORTANCE`,
    `0.9–1.0  irreversible: death, betrayal, oath`,
    `0.6–0.8  significant: promise, revelation, major gift`,
    `0.3–0.5  minor but durable: a stated preference`,
    `below 0.3 do not record it at all`,
    ``,
    `Return at most ${String(maxMemories)} memories. Return an empty array if nothing qualifies.`,
    ``,
    `CHARACTER NAMES in this world — use these exact names in`,
    `\`subjects\` and \`knownBy\`. Do not invent others, and do not use ids.`,
    ...input.knownEntities.map((e) => `  ${e.name}`),
    ``,
    `ALREADY KNOWN (do not restate)`,
    ...(input.existingMemories.length > 0
      ? input.existingMemories.slice(0, 30).map((m) => `  • ${m}`)
      : ["  (nothing yet)"]),
  ].join("\n");

  // The exact shape is repeated in the user message, not only the system one.
  // Measured: models follow a concrete example far more reliably than a prose
  // description, and a malformed shape costs the whole batch.
  const user = [
    `TRANSCRIPT`,
    ...input.transcript.map((t) => `${t.speaker}: ${t.content}`),
    ``,
    `Extract now. Respond with JSON in exactly this shape:`,
    `{"memories":[{"kind":"episodic","content":"The user ...","subjects":["Name"],` +
      `"importance":0.8,"confidence":0.9,"worldDay":${String(input.worldDay)},` +
      `"knownBy":["Name"],"visibility":"world"}],` +
      `"relationshipDeltas":[],"events":[],"contradictions":[]}`,
  ].join("\n");

  return {
    system,
    user,
    version: EXTRACT_PROMPT_VERSION,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
  };
}

/**
 * The repair instruction — one attempt, then the batch is dropped and logged.
 *
 * A lost memory is acceptable; a corrupt one is not, because it will be
 * retrieved, believed and repeated for months (docs/04 § 11).
 */
export function renderRepairPrompt(broken: string, schemaHint: string): string {
  return [
    `The following was meant to be JSON matching this shape:`,
    schemaHint,
    ``,
    `It is invalid. Return ONLY corrected JSON — no explanation, no code fence.`,
    `If it cannot be repaired, return {"memories":[],"relationshipDeltas":[],"events":[],"contradictions":[]}.`,
    ``,
    broken.slice(0, 4000),
  ].join("\n");
}
