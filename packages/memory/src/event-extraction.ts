import {
  EventExtractionSchema,
  type AIProvider,
  type ModelDescriptor,
  type ProposedEvent,
  type WorldEvent,
} from "@darkforest/contracts";
import { renderExtractEventsPrompt } from "@darkforest/prompts";
import { normaliseKey } from "@darkforest/core";

/**
 * TYPED EVENT EXTRACTION (ADR-025) — the experimental write path.
 *
 * Same gated call as prose extraction, different schema. The interesting output
 * is not just the events but the REJECTIONS: a typed row can be checked against
 * the world before it is committed, and how often that check fires is the number
 * most likely to decide whether this architecture is viable.
 */

export interface EventExtractionInput {
  worldId: string;
  transcript: ReadonlyArray<{ speaker: string; content: string }>;
  worldDay: number;
  knownEntities: ReadonlyArray<{ ref: string; name: string }>;
  aggressiveness: number;
  sourceTurn: number;
  /** Next sequence number for this world. Callers keep it monotonic. */
  nextSeq: number;
}

export interface EventRejection {
  reason: "unparseable" | "schema" | "unknown_entity" | "impossible_transition";
  detail: string;
}

/**
 * What happened to one extraction attempt.
 *
 * `empty_valid` is the distinction that matters and the one two previous metrics
 * missed: a turn with nothing durable in it SHOULD produce zero events, and
 * Suite 1's script is roughly 80 filler turns to 20 fact-bearing ones. Counting
 * "yielded no events" as failure meant perfect extraction could score about 20%,
 * and the 15% we reported was near the ceiling the measurement allowed.
 *
 * `truncated` is separated from `unparseable` because they have different fixes:
 * one is a token budget, the other is the model ignoring the format.
 */
export type ExtractionOutcomeKind =
  | "accepted"
  | "empty_valid"
  | "truncated"
  | "unparseable"
  | "schema"
  | "all_rejected";

export interface EventExtractionOutcome {
  events: WorldEvent[];
  rejected: EventRejection[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  /**
   * Extractions ATTEMPTED, not merely those that parsed.
   *
   * The first version divided accepted by the count of successfully parsed
   * proposals, so 66 failures and 1 success reported 100% validity - a healthy
   * number for a broken system, which is the exact failure ADR-023 exists to
   * prevent. Every attempt counts here, whatever stage it died at.
   */
  proposed: number;
  attempted: number;
  /** The single outcome for this attempt. See ExtractionOutcomeKind. */
  outcome: ExtractionOutcomeKind;
  /** True when the provider stopped on length rather than finishing. */
  truncated: boolean;
  /**
   * Diagnostic context, populated only on failure.
   *
   * Present because "20% unparseable" is not a diagnosis. Truncation, a leaked
   * reasoning preamble, a markdown fence and a genuinely malformed object all
   * arrive as the same bucket and have different fixes, and guessing which
   * without looking is how the last four investigations started wrong.
   */
  debug?: {
    rawOutput: string;
    finishReason: string;
    modelId: string;
    promptTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    windowTurns: number;
  };
}

function tryParse(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validates a proposed event against the world.
 *
 * This is the advantage structure buys and the reason the extra fields are worth
 * their risk: a malformed event is caught here, whereas a wrong prose memory is
 * indistinguishable from a right one and is believed for months.
 *
 * Deliberately forgiving at the FIELD level and strict at the RECORD level. An
 * earlier schema required `character:<uuid>` refs and one bad ref rejected an
 * entire validated batch — three of four worlds extracted nothing. Unknown names
 * are dropped from `knownBy`; only an unknown ACTOR kills the record.
 */
function validate(
  e: ProposedEvent,
  known: ReadonlySet<string>,
): { ok: true; event: ProposedEvent } | { ok: false; rejection: EventRejection } {
  const isKnown = (n: string): boolean => known.has(normaliseKey(n));

  if (!isKnown(e.actor)) {
    return {
      ok: false,
      rejection: { reason: "unknown_entity", detail: `actor "${e.actor}" is not in this world` },
    };
  }
  // A target the world does not know is dropped rather than fatal: the event
  // still carries a real happening, and losing the whole row loses more.
  const target = e.target !== null && isKnown(e.target) ? e.target : null;
  const knownBy = e.knownBy.filter(isKnown);

  const needsObject = e.type === "acquired" || e.type === "gave" || e.type === "lost";
  if (needsObject && e.object === null) {
    return {
      ok: false,
      rejection: { reason: "schema", detail: `${e.type} without an object` },
    };
  }
  if (e.type === "gave" && target === null) {
    return {
      ok: false,
      rejection: { reason: "impossible_transition", detail: "gave with no recipient" },
    };
  }
  if (e.type === "numeric_stated" && e.quantity === null) {
    return { ok: false, rejection: { reason: "schema", detail: "numeric_stated without a quantity" } };
  }

  return { ok: true, event: { ...e, target, knownBy } };
}

export async function extractEvents(
  provider: AIProvider,
  model: ModelDescriptor,
  input: EventExtractionInput,
): Promise<EventExtractionOutcome> {
  const prompt = renderExtractEventsPrompt({
    transcript: input.transcript,
    worldDay: input.worldDay,
    knownEntities: input.knownEntities,
    aggressiveness: input.aggressiveness,
  });

  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const rejected: EventRejection[] = [];

  const res = await provider.generate(
    {
      taskClass: "extract",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      /*
       * 1400, not 900. gpt-oss models emit reasoning before content and it is
       * billed against max_tokens, so a six-turn window with three events ran
       * out mid-JSON and surfaced as "unparseable" - 41 of 67 extractions in
       * the first A/B run. The provider adds its own reasoning headroom; this
       * covers the payload itself.
       */
      maxTokens: 1400,
      temperature: 0,
      timeoutMs: 30_000,
      meta: { requestId: `events-${input.worldId}-${String(input.sourceTurn)}` },
    },
    model,
  );
  usage.calls += 1;
  usage.inputTokens += res.usage.inputTokens;
  usage.outputTokens += res.usage.outputTokens + (res.usage.reasoningTokens ?? 0);

  const debug = {
    rawOutput: res.text,
    finishReason: res.finishReason,
    modelId: model.id,
    promptTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    reasoningTokens: res.usage.reasoningTokens ?? 0,
    windowTurns: input.transcript.length,
  };

  // Distinguished from a format failure: the model was doing the right thing and
  // ran out of room, which is a budget fix rather than a prompt fix.
  const truncated = res.finishReason === "length";

  const raw = tryParse(res.text);
  if (raw === null) {
    rejected.push({
      reason: "unparseable",
      detail: truncated ? "output truncated mid-JSON" : `not JSON: ${res.text.slice(0, 120)}`,
    });
    return {
      events: [],
      rejected,
      usage,
      proposed: 0,
      attempted: 1,
      outcome: truncated ? "truncated" : "unparseable",
      truncated,
      debug,
    };
  }

  const parsed = EventExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    rejected.push({ reason: "schema", detail: parsed.error.issues[0]?.message ?? "schema mismatch" });
    return {
      events: [],
      rejected,
      usage,
      proposed: 0,
      attempted: 1,
      outcome: "schema",
      truncated,
      debug,
    };
  }

  const known = new Set([
    normaliseKey("the user"),
    normaliseKey("the world"),
    ...input.knownEntities.map((e) => normaliseKey(e.name)),
  ]);

  const events: WorldEvent[] = [];
  let seq = input.nextSeq;
  for (const proposal of parsed.data.events) {
    const check = validate(proposal, known);
    if (!check.ok) {
      rejected.push(check.rejection);
      continue;
    }
    events.push({
      ...check.event,
      id: `${input.worldId}-e${String(seq)}`,
      worldId: input.worldId,
      seq,
      sourceTurn: input.sourceTurn,
      worldDay: input.worldDay,
    });
    seq += 1;
  }

  /*
   * An empty array is a CORRECT answer for a turn with nothing durable in it.
   * Only a turn that proposed events and had them all rejected is a failure.
   */
  const outcome: ExtractionOutcomeKind =
    events.length > 0
      ? "accepted"
      : parsed.data.events.length === 0
        ? "empty_valid"
        : "all_rejected";

  return {
    events,
    rejected,
    usage,
    proposed: parsed.data.events.length,
    attempted: 1,
    outcome,
    truncated,
    ...(outcome === "all_rejected" ? { debug } : {}),
  };
}
