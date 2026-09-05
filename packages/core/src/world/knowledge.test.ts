import { describe, expect, it } from "vitest";
import type { WorldEvent } from "@darkforest/contracts";
import { PLAYER, audienceFor, canRecall, recallableBy } from "./knowledge.js";

let n = 0;
function ev(over: Partial<WorldEvent> & Pick<WorldEvent, "type" | "actor">): WorldEvent {
  n += 1;
  return {
    id: `k${String(n)}`,
    worldId: "w",
    worldDay: 1,
    seq: n,
    target: null,
    object: null,
    value: null,
    quantity: null,
    location: null,
    participants: [],
    visibility: "world",
    knownBy: [],
    importance: 0.5,
    sourceTurn: n,
    causedBy: null,
    ...over,
  };
}

/**
 * The regression this file exists for.
 *
 * In the Saltmarsh gauntlet the player saw a sealed door in a cellar and told
 * exactly one person. Asked what she knew about that cellar, a character who was
 * never told answered that she had seen the door. The cause was two
 * implementations of one rule disagreeing about what an empty audience means.
 */
describe("isolation fails closed", () => {
  it("keeps an observation to its observer when nobody else is named", () => {
    // THE LEAK. An empty knownBy meant "public" in one implementation, so a
    // private perception became common knowledge.
    const seen = ev({ type: "observed", actor: PLAYER, value: "a sealed door behind the racks" });
    expect(canRecall(seen, PLAYER)).toBe(true);
    expect(canRecall(seen, "Elena")).toBe(false);
    expect(canRecall(seen, "Bram")).toBe(false);
  });

  it("never makes an observation public, whatever the extractor emitted", () => {
    // visibility: "world" is the schema default and must not override the type.
    const seen = ev({ type: "observed", actor: PLAYER, value: "smoke", visibility: "world" });
    expect(audienceFor(seen).kind).toBe("restricted");
  });

  it("reaches exactly the person a secret was told to", () => {
    const told = ev({
      type: "revealed",
      actor: PLAYER,
      target: "Bram",
      value: "there is a sealed door in the cellar",
    });
    expect(canRecall(told, "Bram")).toBe(true);
    expect(canRecall(told, PLAYER)).toBe(true);
    expect(canRecall(told, "Elena")).toBe(false);
  });

  it("widens to everyone explicitly named and no further", () => {
    const told = ev({
      type: "revealed",
      actor: "Ilse",
      target: PLAYER,
      knownBy: ["Ilse", PLAYER, "Marta"],
      value: "what happened that night",
    });
    expect(canRecall(told, "Marta")).toBe(true);
    expect(canRecall(told, "Ronan")).toBe(false);
  });

  it("treats a bridge falling as public, because it is", () => {
    // Isolation must be a boundary, not a blanket. A world where nobody knows
    // anything is as broken as one where everybody knows everything.
    const fell = ev({ type: "world_event", actor: "the world", value: "the east bridge collapsed" });
    expect(audienceFor(fell).kind).toBe("public");
    expect(canRecall(fell, "anyone at all")).toBe(true);
  });

  it("narrows a world event when someone states who witnessed it", () => {
    const fell = ev({
      type: "world_event",
      actor: "the world",
      knownBy: [PLAYER],
      value: "a signal fire on the ridge",
    });
    expect(canRecall(fell, PLAYER)).toBe(true);
    expect(canRecall(fell, "Sera")).toBe(false);
  });

  it("reaches both parties to an exchange", () => {
    const bought = ev({ type: "acquired", actor: PLAYER, target: "Bram", object: "a silver ring" });
    expect(canRecall(bought, PLAYER)).toBe(true);
    expect(canRecall(bought, "Bram")).toBe(true);
    expect(canRecall(bought, "Sera")).toBe(false);
  });

  it("does not make a solitary act common knowledge", () => {
    // "I hide the key under the flagstone" has one participant. Defaulting an
    // empty audience to public is how a character tells you where you hid it.
    const hid = ev({ type: "lost", actor: PLAYER, object: "the brass key" });
    expect(canRecall(hid, PLAYER)).toBe(true);
    expect(canRecall(hid, "Elena")).toBe(false);
  });

  it("includes bystanders listed as participants", () => {
    const scene = ev({
      type: "promised",
      actor: PLAYER,
      target: "Tolven",
      participants: ["Sera"],
      value: "to return the lantern",
    });
    expect(canRecall(scene, "Sera")).toBe(true);
  });

  it("matches names case- and article-insensitively", () => {
    const told = ev({ type: "revealed", actor: "the user", target: "Elena", value: "x" });
    expect(canRecall(told, "elena")).toBe(true);
  });

  it("gives the player their own history without a special case", () => {
    // The player is the actor on their own turns, so the ordinary rule reaches
    // them. A separate player path would be a second implementation, which is
    // the defect this module exists to remove.
    const log = [
      ev({ type: "observed", actor: PLAYER, value: "a signal fire" }),
      ev({ type: "acquired", actor: PLAYER, target: "Bram", object: "a ring" }),
      ev({ type: "revealed", actor: "Marcus", target: "Elena", value: "a secret" }),
    ];
    const mine = recallableBy(log, PLAYER);
    expect(mine).toHaveLength(2);
    expect(recallableBy(log, "Elena")).toHaveLength(1);
  });
});
