import { describe, expect, it } from "vitest";
import {
  capturesFact,
  extractionHealth,
  factCaptureRate,
  recallAtK,
  renderForMatching,
  renderNumber,
  type AttemptOutcome,
  type PlantedFact,
} from "./evaluation-contract.js";

/**
 * Every test below is a bug that SHIPPED and produced a plausible wrong number.
 *
 * They exist because four consecutive measurement errors each lived in the
 * instrumentation written to validate the previous change, and each understated
 * a working system. A benchmark that breaks is safe; one that quietly reports a
 * believable wrong figure is not.
 */

describe("bug 4 — the matcher must read every field an expectation can land in", () => {
  const f14: PlantedFact = {
    id: "f14",
    plantedAt: 45,
    kind: "number",
    expect: ["nine", "9"],
  };

  it("reads numeric fields, which the original matcher skipped entirely", () => {
    // SHIPPED: the blob was built from type/actor/target/object/value, so a
    // perfect event — {numeric_stated, "guards at the keep", quantity: 9} —
    // was reported MISSED because "9" lived in a field nobody read.
    const event = {
      type: "numeric_stated",
      actor: "Captain Vale",
      object: "guards at the keep",
      value: null,
      quantity: 9,
    };
    expect(capturesFact([event], f14)).toBe(true);
  });

  it("renders a number as digits AND words, so either expectation matches", () => {
    // Reading the field is not sufficient: "9" in the blob still misses
    // expect: ["nine"]. Both forms or the false negative survives.
    expect(renderNumber(9)).toContain("9");
    expect(renderNumber(9)).toContain("nine");
    expect(capturesFact([{ quantity: 9 }], { ...f14, expect: ["nine"] })).toBe(true);
    expect(capturesFact([{ quantity: 9 }], { ...f14, expect: ["9"] })).toBe(true);
  });

  it("reads array fields, the next place a value could hide", () => {
    expect(renderForMatching({ knownBy: ["Elena", "Marcus"] })).toContain("elena");
  });

  it("ignores null and undefined without swallowing the fields around them", () => {
    const blob = renderForMatching({ a: null, b: "kept", c: undefined, d: 3 });
    expect(blob).toContain("kept");
    expect(blob).toContain("three");
  });
});

describe("bug 3 — a correct empty extraction is a success, not a failure", () => {
  it("counts silence on an uneventful turn as correct behaviour", () => {
    /*
     * SHIPPED: validity counted only attempts yielding >=1 event. Suite 1 is
     * ~80 filler turns to 20 fact-bearing ones, so perfect extraction could not
     * exceed ~20% and the real 85% capture was reported as 15%.
     */
    const outcomes: AttemptOutcome[] = [
      ...Array<AttemptOutcome>(42).fill("accepted"),
      ...Array<AttemptOutcome>(34).fill("empty_valid"),
      ...Array<AttemptOutcome>(20).fill("unparseable"),
      ...Array<AttemptOutcome>(3).fill("truncated"),
      ...Array<AttemptOutcome>(1).fill("call_failed"),
    ];
    const h = extractionHealth(outcomes);
    expect(h.attempts).toBe(100);
    expect(Math.round(h.health)).toBe(76);
    expect(Math.round(h.formatFailureRate)).toBe(23);
  });

  it("does not let silence alone look like health", () => {
    // The mirror risk: an extractor that never extracts is well-behaved and
    // useless, so capture is reported separately and must be read alongside.
    const h = extractionHealth(Array<AttemptOutcome>(100).fill("empty_valid"));
    expect(h.health).toBe(100);
    const capture = factCaptureRate(
      Array.from({ length: 20 }, (_, i) => ({ factId: `f${String(i)}`, captured: false })),
    );
    expect(capture.rate).toBe(0);
  });
});

describe("bug 2 — the denominator must include the failures", () => {
  it("counts attempts that never parsed", () => {
    // SHIPPED: dividing accepted by proposals from responses that had ALREADY
    // parsed meant 66 failures and 1 success reported 100% validity. A rate
    // whose denominator excludes its own failures is not a rate.
    const outcomes: AttemptOutcome[] = [
      "accepted",
      ...Array<AttemptOutcome>(66).fill("unparseable"),
    ];
    expect(extractionHealth(outcomes).attempts).toBe(67);
    expect(Math.round(extractionHealth(outcomes).health)).toBe(1);
  });

  it("separates truncation from a model ignoring the format", () => {
    // Different fixes: a token budget versus a prompt. Merging them sends the
    // next change at the wrong stage.
    const h = extractionHealth(["truncated", "unparseable", "accepted", "accepted"]);
    expect(Math.round(h.formatFailureRate)).toBe(50);
  });
});

describe("bug 1 — recall@k is measured against the retrieved set", () => {
  it("scores retrieval, never the reply text", () => {
    /*
     * SHIPPED: scoring the model's prose answer measured phrasing and
     * instruction-following. Ravenhold read 0% while retrieval returned the
     * right memory every time, and went to 100% after the split with no change
     * to retrieval. docs/15 § 3.
     */
    expect(recallAtK([{ recalled: true }, { recalled: true }, { recalled: false }])).toBeCloseTo(66.7, 0);
    expect(recallAtK([])).toBe(0);
  });
});

describe("the matcher's stated limits", () => {
  it("is a substring proxy and can be satisfied by an inverted fact", () => {
    // Documented rather than hidden: this passes, and SHOULD, because the
    // contract does not claim to measure semantic correctness. Claiming
    // otherwise is how a proxy silently becomes a guarantee.
    const fact: PlantedFact = { id: "f10", plantedAt: 26, kind: "preference", expect: ["deep water"] };
    const inverted = { content: "The user is entirely unafraid of deep water." };
    expect(capturesFact([inverted], fact)).toBe(true);
  });

  it("matches case-insensitively, since extraction rephrases", () => {
    const fact: PlantedFact = { id: "f01", plantedAt: 2, kind: "possession", expect: ["Ravenblade"] };
    expect(capturesFact([{ content: "the user owns ravenblade" }], fact)).toBe(true);
  });

  it("accepts any one of several surface forms", () => {
    const fact: PlantedFact = { id: "f06", plantedAt: 14, kind: "world_event", expect: ["collapsed", "fell"] };
    expect(capturesFact([{ value: "the north bridge fell in the storm" }], fact)).toBe(true);
  });

  it("returns false on an empty artifact set rather than throwing", () => {
    expect(capturesFact([], { id: "x", plantedAt: 0, kind: "k", expect: ["anything"] })).toBe(false);
  });
});
