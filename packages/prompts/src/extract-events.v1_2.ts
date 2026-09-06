import { estimateTokens } from "@darkforest/core";
import type { ExtractEventsInput } from "./extract-events.v1.js";

/**
 * TYPED EVENT EXTRACTION v1.2 — the decision order is the fix.
 *
 * v1.1 captured first-mention standing facts about 1 time in 10 on held-out
 * sentences. The cause was not the model (gpt-oss-120b and gpt-oss-20b scored
 * identically, fixture for fixture), not parsing (valid JSON, empty array,
 * nothing rejected), and not the extraction gate (there is none). It was three
 * defects in this prompt, and all three are structural rather than a matter of
 * wording.
 *
 * ── DEFECT 1: the taxonomy could VETO capture ─────────────────────────────
 *
 * v1.1 said:
 *
 *     TYPE — choose exactly one. If nothing fits, do not emit an event.
 *
 * So a fact the model could not confidently TYPE was discarded. Recall was
 * bounded by classification confidence rather than by whether the fact
 * mattered, and "I can't swim" is a fact that is obviously worth keeping and
 * genuinely awkward to type.
 *
 * v1.2 asks the two questions in the other order and makes the second one
 * total: decide whether it is worth keeping, THEN pick the closest type, with a
 * named fallback so nothing is dropped for being hard to file. This is the
 * two-stage decomposition the literature recommends for exactly this failure
 * ("atomic propositions benefit weaker extractors by improving relation
 * recall"), done inside one call by fixing the order of the decisions rather
 * than by adding a second request.
 *
 * ── DEFECT 2: the framing forbade a third of the ontology ─────────────────
 *
 * v1.1 opened with "An event is something that HAPPENED... Do not record a
 * state you inferred", and then listed `preference_stated`, `relation_stated`
 * and `numeric_stated` — which are, by definition, standing states. The
 * `_stated` suffix resolves the contradiction (the happening is the SAYING) and
 * v1.1 never said so, so the most emphatic instruction in the prompt argued
 * against a third of the type list.
 *
 * v1.2 names both families and keeps the rule that actually mattered: do not
 * record state you INFERRED. Who holds the ring is still computed, never
 * written.
 *
 * ── DEFECT 3: the one good test was scoped to perception ──────────────────
 *
 * "The test is whether a reader would need to know it later" is the best
 * sentence in v1.1 and it sat inside the paragraph about beacons and hearths,
 * applying to one type. It is now the general rule, stated once, at the top.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ────────────────────────────────────────
 *
 * The type list, the field list, and every worked example that was already
 * there. v1.1 measured 0 false positives across the noise controls, and that
 * precision is worth protecting — a prompt that captures everything is not an
 * improvement, it is a different failure. One NEGATIVE worked example is added
 * for the same reason: v1.1 taught "emit something" with eleven examples and
 * "emit nothing" with a rule.
 */
export const EXTRACT_EVENTS_V1_2_PROMPT_VERSION = "extract-events/v1.2";

export function renderExtractEventsV1_2Prompt(input: ExtractEventsInput): {
  system: string;
  user: string;
  version: string;
  estimatedTokens: number;
} {
  const maxEvents = input.aggressiveness < 0.34 ? 1 : input.aggressiveness < 0.67 ? 2 : 3;

  const system = [
    `You read a roleplay transcript and record what the world should remember.`,
    `You are not a storyteller. Do not invent, embellish, or infer beyond the text.`,
    ``,
    /*
     * The two-step decision, and the ORDER is the entire fix. Step 1 decides
     * capture, step 2 only decides filing. v1.1 ran them the other way round
     * and let step 2 throw work away.
     */
    `DECIDE IN TWO STEPS, IN THIS ORDER.`,
    ``,
    `STEP 1 — IS IT WORTH KEEPING?`,
    `  Would someone reading this world next week need to know it? That is the`,
    `  whole test, and it is the ONLY reason to drop something.`,
    ``,
    `  Two kinds of thing pass it:`,
    `    · something HAPPENED — an act, a change, a disclosure, a perception`,
    `    · someone STATED something durable about a person or the world — what`,
    `      they can or cannot do, where they are from, what they used to be,`,
    `      what they are called, what they are bound by, what they fear or`,
    `      refuse, how two people stand to each other, how many of a thing`,
    `      there are`,
    ``,
    `  The second kind IS an event: the happening is the SAYING. Someone told`,
    `  you a durable fact, and that is a thing that occurred at a moment.`,
    ``,
    `  Still do not record state you INFERRED. If the user gives Sera a ring,`,
    `  record the giving. Who holds the ring afterwards is computed, not written.`,
    ``,
    `STEP 2 — WHAT TYPE IS IT?`,
    `  Choose the closest match. NEVER drop a fact for being hard to type —`,
    `  step 1 already decided it was worth keeping, and step 2 only decides`,
    `  where it is filed.`,
    ``,
    `  If nothing fits exactly:`,
    `    · durably true of a PERSON      -> preference_stated`,
    `    · durably true of the WORLD     -> world_event`,
    ``,
    `TYPES`,
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
    `  preference_stated  something durable about a person: a like, dislike,`,
    `                     fear or refusal, AND what they can or cannot do,`,
    `                     where they are from, what they used to be, what they`,
    `                     are called, what they are bound by. Not what they`,
    `                     want right now - what they ARE.`,
    `  numeric_stated     a counted quantity`,
    `  world_event        something happened in the world at large`,
    ``,
    `FIELDS`,
    `  actor       who acts, or whom the durable fact is about. "the user" for`,
    `              the player.`,
    `  target      who it is directed at, or null.`,
    `  object      the thing acted on, or the SUBJECT the fact is about: an`,
    `              object, a topic, a counted noun, "where they are from".`,
    `  value       the payload in the world's own words - what was promised,`,
    `              asked, refused, revealed, or the fact itself. Keep it verbatim.`,
    `  quantity    a number, for numeric_stated only.`,
    `  knownBy     NAMES of people who witnessed or were told. Empty when the`,
    `              whole world would know. Err toward FEWER - a character`,
    `              revealing a secret they were never told breaks the world.`,
    `  importance  0 to 1. How much a later reader would need it. A name or an`,
    `              inability is high; a passing remark is low. Default 0.5.`,
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
    `  "I can't ride. Horses have never liked me"`,
    `     {"type":"preference_stated","actor":"the user","object":"riding",`,
    `      "value":"cannot ride, horses have never liked them","importance":0.8}`,
    `  "I came here from the mountains ten years ago"`,
    `     {"type":"preference_stated","actor":"the user","object":"where they`,
    `      are from","value":"came from the mountains ten years ago"}`,
    `  "The north bridge collapsed in the storm"`,
    `     {"type":"world_event","actor":"the world","object":"the north bridge",`,
    `      "value":"the north bridge collapsed in the storm"}`,
    /*
     * The one NEGATIVE example, and it earns its place. v1.1 taught "emit
     * something" with eleven examples and "emit nothing" with a rule, and it
     * still over-suppressed — so this is not here to suppress further. It is
     * here so that step 1 has a worked case of a FAILING sentence, and so the
     * zero-false-positive precision v1.1 achieved survives a change that is
     * deliberately loosening capture.
     */
    `  "I cross the yard and knock the mud off my boots"`,
    `     nothing happened that anyone would need later -> {"events":[]}`,
    ``,
    `Perception is not scenery. "I see a signal fire" is an event; "the fire`,
    `burns low in the grate" is not. A beacon means something. The hearth does`,
    `not.`,
    ``,
    `Greetings, politeness, moving about and describing the weather change`,
    `nothing and are worth nothing later. Return an empty array for a turn that`,
    `contains only those. Do not pad.`,
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
    /*
     * `visibility` is deliberately ABSENT from this example, and its schema
     * default fills it. Nothing reads it: `audienceFor` decides who may recall
     * an event from actor, target, participants and type, and never consults
     * this field. Asking the model for a value nobody reads spends output
     * tokens and adds a way to fail validation, for nothing.
     */
    `{"events":[{"type":"promised","actor":"the user","target":"Elena",` +
      `"object":null,"value":"to return before sunset","quantity":null,` +
      `"location":null,"participants":[],"knownBy":["Elena"],` +
      `"importance":0.7,"causedBy":null}]}`,
  ].join("\n");

  return {
    system,
    user,
    version: EXTRACT_EVENTS_V1_2_PROMPT_VERSION,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
  };
}
