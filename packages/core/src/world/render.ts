import type { WorldEvent } from "@darkforest/contracts";

/**
 * AN EVENT AS A SENTENCE A CHARACTER COULD HAVE THOUGHT.
 *
 * This text is not for a log. It goes into the prompt under "WHAT YOU
 * REMEMBER", so it is read by the model that has to sound like it remembers.
 *
 * The first version joined the fields together and produced
 *
 *   "the user preference stated swimming cannot swim, never learned"
 *
 * which retrieved correctly and reads like a database row. A character handed
 * that has to translate it back into a thought before it can use it, and every
 * such translation is a chance to use it badly — the expression suite already
 * measures how much of what a character holds actually reaches what they say.
 *
 * Deliberately NOT model-generated. Rendering a stored fact with another model
 * call would add a failure mode, a cost, and a paraphrase that can drift from
 * the event it came from. These are templates over fields that are already
 * verbatim from the transcript.
 */

function join(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line, in the world's own words, in the past tense of having happened. */
export function renderEventAsMemory(e: WorldEvent): string {
  const to = e.target === null ? null : `to ${e.target}`;

  switch (e.type) {
    case "acquired":
      return join([e.actor, "got", e.object, e.target === null ? null : `from ${e.target}`]);
    case "gave":
      return join([e.actor, "gave", e.object, to]);
    case "lost":
      return join([e.actor, "lost", e.object]);

    case "promised":
      return join([e.actor, "promised", to, e.value ?? e.object]);
    case "refused":
      return join([e.actor, "refused", to, e.value ?? e.object]);
    case "fulfilled":
      return join([e.actor, "kept their word", to, e.value ?? e.object]);

    case "asked":
      return join([e.actor, "asked", to, "about", e.value ?? e.object]);
    case "answered":
      return join([e.actor, "answered", to, e.value ?? e.object]);

    case "revealed":
      return join([e.actor, "let slip", to, e.value ?? e.object]);
    case "observed":
      // `value` is already written as "the user observed X" by the extractor,
      // so repeating the actor would stutter.
      return e.value !== null && e.value.length > 0
        ? e.value
        : join([e.actor, "noticed", e.object]);

    case "relation_stated":
    case "relation_changed":
      return join([e.actor, "is", e.value, e.target === null ? null : `to ${e.target}`]);

    /*
     * The one that mattered. "the user cannot swim, never learned" rather than
     * "the user preference stated swimming cannot swim, never learned" — the
     * value is already a phrase about the actor, so the actor plus the value is
     * the whole sentence.
     */
    case "preference_stated":
      return join([e.actor, e.value ?? join(["feels strongly about", e.object])]);

    case "numeric_stated":
      return join([
        e.object,
        e.quantity === null ? null : `= ${String(e.quantity)}`,
        e.actor === "" ? null : `(said by ${e.actor})`,
      ]);

    case "world_event":
      return e.value !== null && e.value.length > 0 ? e.value : join([e.actor, e.object]);
  }
}
