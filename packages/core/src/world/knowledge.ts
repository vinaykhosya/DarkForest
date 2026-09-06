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

  /*
   * PERCEPTION IS THE OBSERVER'S, and `knownBy` is IGNORED here.
   *
   * This is the third form of the same leak and the one that finally explained
   * it. The extractor emitted:
   *
   *   observed  actor="the user"  knownBy=["the user", "Elena"]
   *   value: "the user observed a sealed door behind the racks"
   *
   * Elena was not in the cellar. She was merely in the cast and in nearby turns,
   * and the model added her as a witness. The audience rule then did exactly
   * what it was told, and a character described a door she had never seen.
   *
   * A focused probe could not reproduce it, because in a three-turn window Elena
   * does not appear at all and the model correctly wrote knownBy=["the user"].
   * The bug needs the full transcript to surface, which is why it read as
   * intermittent and unexplained across four runs.
   *
   * So the audience for a perception is not taken from the model. Someone else
   * seeing the same thing is their own observation, or is stated in the text and
   * becomes a `revealed`.
   *
   * COST, accepted: "Elena and I both watched the beacon" now reaches only the
   * player, and Elena will not recall something she genuinely witnessed. That is
   * the correct direction — forgetting reads as ordinary imperfect memory, and
   * knowing a secret nobody told you reads as the world being fake.
   */
  if (e.type === "observed") {
    return { kind: "restricted", who: only([e.actor]) };
  }
  if (e.type === "revealed") {
    return {
      kind: "restricted",
      who: only([e.actor, ...(e.target === null ? [] : [e.target]), ...named]),
    };
  }
  /*
   * `world_event` USED to be public on an empty audience, and that was the hole.
   *
   * The player wrote "I see a sealed door behind the racks" and the extractor
   * classified it as a world_event — the world contains a door — rather than an
   * observation. Empty audience, public, and a character who was never told
   * described the door back to the player. Making `observed` private did not
   * help, because nothing forces the extractor to choose `observed`.
   *
   * Isolation cannot rest on the model picking the right type. So no type is
   * public by default: an event reaches whoever it names and nobody else, and a
   * genuinely public fact has to say who witnessed it.
   *
   * This over-restricts. A bridge collapsing in front of the whole town now
   * reaches only the people the extractor named, and someone who plausibly saw
   * it may not recall it. That direction is deliberate and cheap: a character
   * forgetting something reads as ordinary imperfect memory, and a character
   * repeating a secret nobody told them reads as the world being fake.
   */

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
  // Retained for a future explicit-broadcast type; nothing produces it today.
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
