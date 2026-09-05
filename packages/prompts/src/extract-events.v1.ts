import { estimateTokens } from "@darkforest/core";

/**
 * TYPED EVENT EXTRACTION — the experimental write path (ADR-025).
 *
 * Same gated call as prose extraction, different output schema. This is the
 * whole cost argument: turning the extractor's output from a sentence into a
 * typed row adds no inference, and the measured constraint is calls per turn,
 * not tokens.
 *
 * The gamble worth naming: a typed row has more fields to get wrong than a
 * sentence. The compensation is that a wrong row is DETECTABLE — an event naming
 * an unknown character, or giving away an object nobody holds, is rejected at
 * write time. A wrong prose memory is undetectable; it enters the store, is
 * retrieved, and is believed for months. Extraction validity is reported
 * alongside recall precisely because it is the number most likely to sink this.
 */

export const EXTRACT_EVENTS_PROMPT_VERSION = "extract-events/v1";

export interface ExtractEventsInput {
  transcript: ReadonlyArray<{ speaker: string; content: string }>;
  worldDay: number;
  knownEntities: ReadonlyArray<{ ref: string; name: string }>;
  aggressiveness: number;
}

export function renderExtractEventsPrompt(input: ExtractEventsInput): {
  system: string;
  user: string;
  version: string;
  estimatedTokens: number;
} {
  const maxEvents = input.aggressiveness < 0.34 ? 1 : input.aggressiveness < 0.67 ? 2 : 3;

  const system = [
    `You convert a roleplay transcript into structured world events.`,
    `You are not a storyteller. Do not invent, embellish, or infer beyond the text.`,
    ``,
    `An event is something that HAPPENED. Record the happening, not its summary.`,
    `Do not record a state you inferred: if the user gives Elena a ring, record the`,
    `giving. Who holds the ring afterwards is computed, not written.`,
    ``,
    `TYPE — choose exactly one. If nothing fits, do not emit an event.`,
    `  acquired           someone obtains an object`,
    `  gave               actor hands object to target`,
    `  lost               someone loses an object`,
    `  promised           actor commits to doing something`,
    `  refused            actor commits to NOT doing something`,
    `  fulfilled          an earlier promise was carried out`,
    `  asked              actor asks target about something`,
    `  answered           an earlier question was answered`,
    `  revealed           actor discloses a secret`,
    `  relation_stated    how two people stand to each other`,
    `  relation_changed   that standing changed`,
    `  preference_stated  a like, dislike, fear or refusal of a thing`,
    `  numeric_stated     a counted quantity`,
    `  world_event        something happened in the world at large`,
    ``,
    `FIELDS`,
    `  actor     who acts. Use "the user" for the player.`,
    `  target    who it is directed at, or null.`,
    `  object    the thing acted on: an object, a topic, a counted noun.`,
    `  value     the payload in the world's own words - what was promised, asked,`,
    `            refused, revealed, or the relation itself. Keep it verbatim.`,
    `  quantity  a number, for numeric_stated only.`,
    `  knownBy   NAMES of people who witnessed or were told. Empty when the whole`,
    `            world would know. Err toward FEWER - a character revealing a`,
    `            secret they were never told breaks the world.`,
    ``,
    `WORKED EXAMPLES`,
    `  "I bought a coil of rope from Odell"`,
    `     {"type":"acquired","actor":"the user","target":"Odell","object":"a coil of rope"}`,
    `  "I promise Elena I will return before sunset"`,
    `     {"type":"promised","actor":"the user","target":"Elena",`,
    `      "value":"to return before sunset"}`,
    `  "I tell Marcus that I refuse to lie, to anyone, ever"`,
    `     {"type":"refused","actor":"the user","target":"Marcus",`,
    `      "value":"to lie to anyone, ever"}`,
    `  "I ask Elena who sealed the room upstairs"`,
    `     {"type":"asked","actor":"the user","target":"Elena",`,
    `      "value":"who sealed the room upstairs"}`,
    `  "Marcus admits to me he was at the gate that night"`,
    `     {"type":"revealed","actor":"Marcus","target":"the user",`,
    `      "value":"he was at the gate that night","knownBy":["Marcus","the user"]}`,
    `  "Captain Vale tells me nine guards remain at the keep"`,
    `     {"type":"numeric_stated","actor":"Captain Vale","object":"guards at the keep",`,
    `      "quantity":9}`,
    `  "I remark that Marcus is Elena's brother"`,
    `     {"type":"relation_stated","actor":"Marcus","target":"Elena","value":"brother"}`,
    `  "The north bridge collapsed in the storm"`,
    `     {"type":"world_event","actor":"the world","object":"the north bridge",`,
    `      "value":"the north bridge collapsed in the storm"}`,
    ``,
    `SKIP pure movement, greetings, and anything with no durable consequence.`,
    `Return an empty array when a turn contains nothing. Do not pad.`,
    ``,
    `Return at most ${String(maxEvents)} events. Today is day ${String(input.worldDay)}.`,
    ``,
    `NAMES you may use for actor, target and knownBy. Do not invent others.`,
    `  the user`,
    ...input.knownEntities.map((e) => `  ${e.name}`),
  ].join("\n");

  const user = [
    `TRANSCRIPT`,
    ...input.transcript.map((t) => `${t.speaker}: ${t.content}`),
    ``,
    `Extract now. Respond with JSON in exactly this shape:`,
    `{"events":[{"type":"promised","actor":"the user","target":"Elena",` +
      `"object":null,"value":"to return before sunset","quantity":null,` +
      `"location":null,"participants":[],"visibility":"world","knownBy":["Elena"],` +
      `"importance":0.7,"causedBy":null}]}`,
  ].join("\n");

  return {
    system,
    user,
    version: EXTRACT_EVENTS_PROMPT_VERSION,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
  };
}
