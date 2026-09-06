import type { MemoryKind, WorldEventType } from "@darkforest/contracts";

/**
 * WHICH KIND OF MEMORY AN EVENT BECOMES — and therefore how fast it fades.
 *
 * This exists because the turn loop filed EVERY derived memory as `episodic`,
 * and `kind` is what selects the decay half-life:
 *
 *     episodic    30 days
 *     relational  90 days
 *     persona    180 days
 *     semantic   365 days
 *     world      never
 *
 * So "the user cannot swim, never learned" — a fact that is true for as long as
 * the person exists — was decaying with a thirty-day half-life. It halves in a
 * month of world time and is down to an eighth in a season.
 *
 * That bug is invisible to every test we have. The acceptance gate advances the
 * clock by ONE day, where the difference between a 30-day and a 180-day
 * half-life is under two percent. It only shows up as the thing the product
 * exists to prevent: a character who remembers you tomorrow and has forgotten
 * you by the spring.
 *
 * The memory engine's per-kind tuning was already correct. It was simply never
 * connected, and every memory took the default.
 *
 * THE MAPPING RULE: what does this record describe?
 *   · a thing that happened at a moment          -> episodic
 *   · how two people stand                       -> relational
 *   · what a person durably IS                   -> persona
 *   · a fact about the world that stays true     -> semantic
 *   · a change to the world at large             -> world
 */
export function memoryKindForEvent(type: WorldEventType): MemoryKind {
  switch (type) {
    /*
     * Things that happened. They matter most while recent and legitimately
     * fade: who handed whom a rope last month is background by the spring.
     * The PROJECTION, not the memory, is what keeps ownership current — so
     * decay here loses colour, never truth.
     */
    case "acquired":
    case "gave":
    case "lost":
    case "promised":
    case "refused":
    case "fulfilled":
    case "asked":
    case "answered":
    case "observed":
      return "episodic";

    /*
     * A disclosure is an episode, deliberately. What was revealed may be
     * permanent, but the memory records the ACT of revealing, and the act is
     * what a character recalls: "he told me, that night at the gate".
     */
    case "revealed":
      return "episodic";

    case "relation_stated":
    case "relation_changed":
      return "relational";

    /*
     * The one that motivated this file. A stated trait, capability, origin,
     * name or obligation is true of the person until something changes it —
     * and if something does, a later event supersedes it. Decay is the wrong
     * mechanism for that; supersession is the right one, and it already exists.
     */
    case "preference_stated":
      return "persona";

    /*
     * A count is a claim about what is true, not about what happened. It ages
     * slowly and is corrected by a later count rather than by forgetting.
     */
    case "numeric_stated":
      return "semantic";

    /*
     * The world changing is world truth: the bridge that collapsed did not
     * un-collapse because a season passed. Infinite half-life, which is exactly
     * why this must not be the default for everything.
     */
    case "world_event":
      return "world";
  }
}
