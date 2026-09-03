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
    `Only record something if a reader would find it strange for a character to have`,
    `forgotten it two weeks later. Most turns contain nothing worth recording — an`,
    `empty result is the correct and common answer.`,
    ``,
    `Prefer: promises, oaths, betrayals, deaths, departures, revealed secrets,`,
    `relationship shifts, durable preferences, acquired or lost possessions.`,
    `Reject: small talk, movement, description, restatements of known facts,`,
    `anything already listed under ALREADY KNOWN.`,
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
    `Set knownBy to the characters who witnessed or were told the fact. Leave it`,
    `empty only when the whole world would know. Getting this wrong causes a`,
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
    `KNOWN ENTITIES (use these refs exactly; do not invent others)`,
    ...input.knownEntities.map((e) => `  ${e.ref} = ${e.name}`),
    ``,
    `ALREADY KNOWN (do not restate)`,
    ...(input.existingMemories.length > 0
      ? input.existingMemories.slice(0, 30).map((m) => `  • ${m}`)
      : ["  (nothing yet)"]),
  ].join("\n");

  const user = [
    `TRANSCRIPT`,
    ...input.transcript.map((t) => `${t.speaker}: ${t.content}`),
    ``,
    `Extract now. Respond with JSON matching the required schema.`,
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
