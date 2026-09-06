import { describe, expect, it } from "vitest";
import { WorldEventTypeSchema, type WorldEventType } from "@darkforest/contracts";
import { RECENCY_HALFLIFE_DAYS } from "../memory/weights.js";
import { recencyScore } from "../memory/scoring.js";
import { memoryKindForEvent } from "./memory-kind.js";

describe("memoryKindForEvent", () => {
  it("maps every event type, so a new type cannot silently take a default", () => {
    // The bug this file exists for was a DEFAULT applied to everything. An
    // exhaustive check means adding an event type forces a decision about how
    // long the memory it produces should last.
    for (const type of WorldEventTypeSchema.options) {
      expect(memoryKindForEvent(type), type).toBeTruthy();
    }
  });

  it("a stated trait is persona, not episodic — the regression", () => {
    expect(memoryKindForEvent("preference_stated")).toBe("persona");
  });

  it("world changes never decay", () => {
    expect(memoryKindForEvent("world_event")).toBe("world");
    expect(Number.isFinite(RECENCY_HALFLIFE_DAYS[memoryKindForEvent("world_event")])).toBe(false);
  });

  it("relationships and counts get their own rates", () => {
    expect(memoryKindForEvent("relation_stated")).toBe("relational");
    expect(memoryKindForEvent("relation_changed")).toBe("relational");
    expect(memoryKindForEvent("numeric_stated")).toBe("semantic");
  });

  it("things that happened stay episodic", () => {
    const episodic: WorldEventType[] = [
      "acquired", "gave", "lost", "promised", "refused",
      "fulfilled", "asked", "answered", "observed", "revealed",
    ];
    for (const type of episodic) expect(memoryKindForEvent(type), type).toBe("episodic");
  });

  /**
   * The point of the whole file, expressed as the number a user would feel.
   *
   * One day of world time hides this completely, which is why the acceptance
   * gate could never have caught it.
   */
  it("shows the cost the old default was paying, in retrievability", () => {
    const trait = memoryKindForEvent("preference_stated");

    const afterOneDay = {
      correct: recencyScore(trait, 1, 2),
      old: recencyScore("episodic", 1, 2),
    };
    // Under 2% apart — a one-day test cannot see this bug at all.
    expect(Math.abs(afterOneDay.correct - afterOneDay.old)).toBeLessThan(0.02);

    const afterASeason = {
      correct: recencyScore(trait, 1, 91),
      old: recencyScore("episodic", 1, 91),
    };
    // Ninety days on, the old default has decayed to roughly an eighth while
    // the correct kind is still most of the way up.
    expect(afterASeason.old).toBeLessThan(0.15);
    expect(afterASeason.correct).toBeGreaterThan(0.65);
  });
});
