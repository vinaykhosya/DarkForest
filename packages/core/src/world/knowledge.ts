import type { WorldEvent } from "@darkforest/contracts";
import { normaliseKey } from "./projections.js";

/**
 * WHO MAY RECALL AN EVENT — the single authoritative implementation.
 *
 * This exists because there were two, and they disagreed. `projections.ts`
 * defaulted an observation to its observer; the gauntlet's own filter treated an
 * empty `knownBy` as public. In the Saltmarsh run the player saw a sealed door
 * in the cellar and told exactly one person, Bram. Asked what she knew about the
 * cellar, Elena answered:
 *
 *   "The air down there is colder than it should be. I also saw a sealed door
 *    behind the racks at the back."
 *
 * Elena was never told and was never down there. One rule, implemented twice,
 * interpreted differently — which is the same class of defect the evaluation
 * contract was frozen to prevent, rebuilt in new code a day later.
 *
 * THE RULE: ISOLATION FAILS CLOSED.
 *
 * An absent audience means "nobody was told", never "everybody knows". This is a
 * security-shaped property and the permissive default is the wrong direction:
 * over-restricting makes a character forget something they witnessed, which
 * reads as ordinary imperfect memory. Under-restricting makes a character repeat
 * a secret nobody told them, which reads as the world being fake.
 *
 * Only a `world_event` with no stated audience is public, because that type
 * means something happened in the world at large. Everything else reaches its
 * participants and whoever was explicitly named.
 */

/** The player's canonical name in an event log. */
export const PLAYER = "the user";

export type Audience = { readonly kind: "public" } | { readonly kind: "restricted"; readonly who: readonly string[] };

/**
 * Who this event reached.
 *
 * `observed` and `revealed` can NEVER be public regardless of what the extractor
 * emitted: perceiving something tells nobody else, and a disclosure that
 * everybody already knew is not a disclosure. Those two carry the knowledge in
 * this system, so they are the two that must not fail open.
 */
export function audienceFor(e: WorldEvent): Audience {
  const named = e.knownBy.filter((n) => n.trim().length > 0);

  /** Case-insensitive dedupe, keeping first spelling — an actor is often also named. */
  const only = (names: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
      const key = normaliseKey(name);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  };

  if (e.type === "observed") {
    return { kind: "restricted", who: only([e.actor, ...named]) };
  }
  if (e.type === "revealed") {
    return {
      kind: "restricted",
      who: only([e.actor, ...(e.target === null ? [] : [e.target]), ...named]),
    };
  }
  if (e.type === "world_event") {
    // The one genuinely public shape — a bridge falling is not a secret. A
    // stated audience still narrows it: someone can witness a private event.
    return named.length === 0 ? { kind: "public" } : { kind: "restricted", who: only(named) };
  }

  /*
   * Everything else reaches whoever took part, plus anyone named. Deliberately
   * NOT public on an empty audience: hiding a key under a flagstone is an act
   * with one participant, and defaulting it to common knowledge is how a
   * character mentions where you hid something.
   */
  return {
    kind: "restricted",
    who: only([
      e.actor,
      ...(e.target === null ? [] : [e.target]),
      ...e.participants,
      ...named,
    ]),
  };
}

/** Whether `who` may recall this event at all. The only isolation check. */
export function canRecall(e: WorldEvent, who: string): boolean {
  const audience = audienceFor(e);
  if (audience.kind === "public") return true;
  const target = normaliseKey(who);
  return audience.who.some((n) => normaliseKey(n) === target);
}

/**
 * Every event a character may recall, in log order.
 *
 * The player is not special-cased: they appear as `actor` on their own turns, so
 * their own history reaches them by the same rule as everyone else's.
 */
export function recallableBy(events: readonly WorldEvent[], who: string): WorldEvent[] {
  return events.filter((e) => canRecall(e, who));
}
