import { describe, expect, it } from "vitest";
import type { WorldEvent } from "@darkforest/contracts";
import { renderEventAsMemory } from "./render.js";

/**
 * These strings go into a prompt, so the test is whether they read like a
 * thought rather than whether they contain the right substrings.
 */

function event(p: Partial<WorldEvent> & { type: WorldEvent["type"]; actor: string }): WorldEvent {
  return {
    id: "e1",
    worldId: "w1",
    worldDay: 1,
    seq: 0,
    target: null,
    object: null,
    value: null,
    quantity: null,
    location: null,
    participants: [],
    visibility: "world",
    knownBy: [],
    importance: 0.5,
    sourceTurn: 0,
    causedBy: null,
    ...p,
  };
}

describe("renderEventAsMemory", () => {
  it("renders a stated trait as a sentence, not as joined fields", () => {
    // The V0.1 regression. This exact event rendered as
    // "the user preference stated swimming cannot swim, never learned".
    const line = renderEventAsMemory(
      event({
        type: "preference_stated",
        actor: "the user",
        object: "swimming",
        value: "cannot swim, never learned",
      }),
    );
    expect(line).toBe("the user cannot swim, never learned");
    expect(line).not.toContain("preference stated");
  });

  it("does not stutter on an observation whose value already names the actor", () => {
    expect(
      renderEventAsMemory(
        event({
          type: "observed",
          actor: "the user",
          value: "the user saw a sealed door behind the racks",
        }),
      ),
    ).toBe("the user saw a sealed door behind the racks");
  });

  it("keeps the target in a promise, because who it was made to is the point", () => {
    expect(
      renderEventAsMemory(
        event({
          type: "promised",
          actor: "the user",
          target: "Elena",
          value: "to be back before sunset",
        }),
      ),
    ).toBe("the user promised to Elena to be back before sunset");
  });

  it("never leaves the underscored type name in the text", () => {
    const types: Array<WorldEvent["type"]> = [
      "acquired", "gave", "lost", "promised", "refused", "fulfilled",
      "asked", "answered", "revealed", "observed", "relation_stated",
      "relation_changed", "preference_stated", "numeric_stated", "world_event",
    ];
    for (const type of types) {
      const line = renderEventAsMemory(
        event({ type, actor: "Elena", target: "Bram", object: "the ring", value: "a thing", quantity: 3 }),
      );
      expect(line, type).not.toMatch(/_/);
      expect(line.length, type).toBeGreaterThan(0);
    }
  });

  it("collapses the gaps left by null fields", () => {
    const line = renderEventAsMemory(event({ type: "lost", actor: "Bram", object: null }));
    expect(line).not.toMatch(/\s{2,}/);
    expect(line.trim()).toBe(line);
  });
});
