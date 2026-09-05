import { estimateTokens } from "@darkforest/core";

/**
 * EVENT EXTRACTION v2 — the consequence test.
 *
 * v1 asked "is this a durable fact?" and, unpressured and one turn at a time,
 * consistently answered no for three turns the product needs:
 *
 *   f12  "I see the eastern watchtower signal fire."       [] twice of two
 *   f13  "Elena saved my life on the north road."          declined 1 of 2
 *   f15  "I discover a crypt hidden beneath the chapel."   declined 1 of 2
 *
 * The model was not failing. It was answering the question it was asked. None of
 * those is a fact about a possession, a promise or a preference — the shapes v1
 * lists and illustrates. They are things that HAPPEN and change the world.
 *
 * So v2 replaces the durability test with a consequence test: not "would someone
 * find it strange to forget this" but "did this change the world, a
 * relationship, what someone knows, what someone holds, what someone owes, or
 * what remains unfinished".
 *
 * THE RISK THIS PROMPT IS DESIGNED AGAINST
 * Broadening selection is the easy way to fix recall and the easy way to ruin
 * the product: an extractor that saves everything turns memory into a second
 * transcript, drowns retrieval in trivia, and exhausts free-tier storage. So the
 * skip list here is STRONGER than v1's, not weaker, and the A/B measures
 * false positives on filler turns alongside capture. A v2 that captures more
 * facts AND fires on uneventful turns is a failure, not a win.
 */

export const EXTRACT_EVENTS_V2_VERSION = "extract-events/v2";

export interface ExtractEventsV2Input {
  transcript: ReadonlyArray<{ speaker: string; content: string }>;
  worldDay: number;
  knownEntities: ReadonlyArray<{ ref: string; name: string }>;
  aggressiveness: number;
}

export function renderExtractEventsV2Prompt(input: ExtractEventsV2Input): {
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
    `THE TEST — apply it to every turn`,
    `Ask: did this CHANGE anything that outlives the moment?`,
    ``,
    `  the world           a bridge falls, a fire is lit, a body is found`,
    `  a relationship      someone saves, betrays, forgives, threatens`,
    `  what someone knows  a secret told, a lie exposed, a discovery made`,
    `  what someone holds  taken, given, bought, lost, destroyed`,
    `  what someone owes   a promise, an oath, a refusal, a debt`,
    `  what is unfinished  a question asked, a threat made, a plan announced`,
    ``,
    `If any of those changed, record it. A thing can matter without being a`,
    `"fact about someone". A signal fire on a distant tower is not a fact about`,
    `anyone and may be the most important thing that happens all week.`,
    ``,
    `Record what happened, not the state it produced. If the user gives Elena a`,
    `ring, record the giving; who holds the ring afterwards is computed.`,
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
    `  relation_changed   that standing changed - rescue, betrayal, forgiveness`,
    `  preference_stated  a like, dislike, fear or refusal of a thing`,
    `  numeric_stated     a counted quantity`,
    `  world_event        something happened in the world, with no single actor`,
    ``,
    `FIELDS`,
    `  actor     who acts. "the user" for the player, "the world" for events`,
    `            with no actor.`,
    `  target    who it is directed at, or null.`,
    `  object    the thing acted on: an object, a topic, a counted noun, a place.`,
    `  value     the payload in the world's own words. Keep it verbatim.`,
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
    `  "I won't hand over the ledger, not to anyone"`,
    `     {"type":"refused","actor":"the user","value":"to hand over the ledger"}`,
    `  "I ask the innkeeper who owns the old mill"`,
    `     {"type":"asked","actor":"the user","target":"the innkeeper",`,
    `      "value":"who owns the old mill"}`,
    `  "Smoke is rising over the eastern ridge"`,
    `     {"type":"world_event","actor":"the world","object":"the eastern ridge",`,
    `      "value":"smoke rose over the eastern ridge"}`,
    `  "The ferryman pulled me out of the river before I went under"`,
    `     {"type":"relation_changed","actor":"the ferryman","target":"the user",`,
    `      "value":"pulled the user from the river and saved their life"}`,
    `  "Behind the shelves there is a passage nobody has used in years"`,
    `     {"type":"world_event","actor":"the world","object":"a passage behind the shelves",`,
    `      "value":"a long-unused passage lies behind the shelves"}`,
    ``,
    `SKIP — these change nothing and must produce no event:`,
    `  movement with no discovery      "I walk to the window"`,
    `  greetings and farewells         "Good evening, Elena"`,
    `  mood and weather as scenery     "The fire burns low"`,
    `  restating what is already known`,
    `  a character's opinion about something already recorded`,
    `  waiting, watching, resting, thinking`,
    ``,
    `Most turns change nothing. Returning an empty array is the correct and`,
    `common answer, and padding is worse than missing something: a world full of`,
    `trivia recalls nothing useful. Never emit an event to seem thorough.`,
    ``,
    `Return at most ${String(maxEvents)} events. Today is day ${String(input.worldDay)}.`,
    ``,
    `NAMES you may use for actor, target and knownBy. Do not invent others.`,
    `  the user`,
    `  the world`,
    ...input.knownEntities.map((e) => `  ${e.name}`),
  ].join("\n");

  const user = [
    `TRANSCRIPT`,
    ...input.transcript.map((t) => `${t.speaker}: ${t.content}`),
    ``,
    `Extract now. Respond with JSON in exactly this shape, and nothing else:`,
    `{"events":[{"type":"promised","actor":"the user","target":"Elena",` +
      `"object":null,"value":"to return before sunset","quantity":null,` +
      `"location":null,"participants":[],"visibility":"world","knownBy":["Elena"],` +
      `"importance":0.7,"causedBy":null}]}`,
    `If nothing changed, respond with exactly: {"events":[]}`,
  ].join("\n");

  return {
    system,
    user,
    version: EXTRACT_EVENTS_V2_VERSION,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
  };
}
