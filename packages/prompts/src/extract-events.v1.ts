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

/**
 * v1.1 adds the `observed` primitive.
 *
 * NOT a rewording. v2 rewrote the selection criteria and captured FEWER facts
 * (10/20 against v1's 17/20), losing whole categories. This adds a TYPE the
 * schema was missing, with examples for the verbs that produced nothing at all:
 * see, hear, notice, smell. Measured 2026-09-06 on 32 unseen sentences,
 * perception captured 33% against 67-83% for every other agency shape.
 */
export const EXTRACT_EVENTS_PROMPT_VERSION = "extract-events/v1.1";

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
    `  observed           someone SEES, HEARS, NOTICES or SMELLS something`,
    `                     already there. The world did not change; what`,
    `                     someone KNOWS did. Use it for perception even`,
    `                     when nobody acts and nothing is taken.`,
    `  relation_stated    how two people stand to each other`,
    `  relation_changed   that standing changed`,
    /*
     * WIDENED, because the V0.1 acceptance test failed here.
     *
     * A stranger told a character "I can't swim. I never learned" and the
     * extractor returned valid JSON with zero events. A probe over 10 sentences
     * then showed 8 of 8 self-descriptions missed — inability, condition,
     * history, identity, capability, constraint — while both controls were
     * kept. The vocabulary simply had nowhere to put a durable fact about
     * oneself, and "a like, dislike, fear or refusal" is a fair reading under
     * which "I can't swim" is none of them.
     *
     * It stays ONE type rather than becoming two. ADR-025's rule is that a type
     * earns its place by feeding a projection that answers a question users
     * ask, and a trait and a preference both fold into the same PersonaFact.
     * A second type feeding one projection is a field the extractor can get
     * wrong for no benefit.
     */
    `  preference_stated  something durable about a person: a like, dislike,`,
    `                     fear or refusal, AND what they can or cannot do,`,
    `                     where they are from, what they used to be, what they`,
    `                     are called, what they are bound by. Not what they`,
    `                     want right now - what they ARE.`,
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
    `  "I see a beacon burning on the far headland"`,
    `     {"type":"observed","actor":"the user",`,
    `      "object":"a beacon on the far headland",`,
    `      "value":"the user saw a beacon burning on the far headland",`,
    `      "knownBy":["the user"]}`,
    `  "I hear something moving in the cellar"`,
    `     {"type":"observed","actor":"the user",`,
    `      "object":"movement in the cellar",`,
    `      "value":"the user heard something moving in the cellar",`,
    `      "knownBy":["the user"]}`,
    `  "I can't swim. I never learned"`,
    `     {"type":"preference_stated","actor":"the user","object":"swimming",`,
    `      "value":"cannot swim, never learned"}`,
    `  "I grew up in Ashford and left at fifteen"`,
    `     {"type":"preference_stated","actor":"the user","object":"where they`,
    `      are from","value":"grew up in Ashford, left at fifteen"}`,
    `  "The north bridge collapsed in the storm"`,
    `     {"type":"world_event","actor":"the world","object":"the north bridge",`,
    `      "value":"the north bridge collapsed in the storm"}`,
    ``,
    `Perception is not scenery. "I see a signal fire" is an event; "the fire`,
    `burns low in the grate" is not. The test is whether a reader would need`,
    `to know it later. A beacon means something. The hearth does not.`,
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
