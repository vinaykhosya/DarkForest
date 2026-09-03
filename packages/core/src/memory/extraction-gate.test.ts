import { describe, expect, it } from "vitest";
import { adjustImportance, estimateIrreversibility, shouldExtract, type GateInput } from "./extraction-gate.js";

/**
 * ADR-016. The gate exists to avoid spending an inference call on every turn to
 * confirm that nothing happened — measured at 36% of turns skipped.
 *
 * Two failure modes matter, in opposite directions:
 *   fires too rarely  → facts are silently never recorded (the Ashford bug)
 *   fires too often   → the 36% saving evaporates and P4 is violated anyway
 * Both are tested.
 */

function input(text: string, over: Partial<GateInput> = {}): GateInput {
  return {
    windowText: text,
    knownEntities: ["Elena", "Marcus", "Hobbes", "Lady Ashford"],
    seenEntities: ["Elena", "Marcus", "Hobbes", "Lady Ashford"],
    toolCallFired: false,
    ruleDeltaApplied: false,
    turnsSinceLastExtraction: 0,
    ...over,
  };
}

describe("gate — commissive and irreversible", () => {
  it("fires on a promise", () => {
    expect(shouldExtract(input("I promise Elena I will return.")).signals).toContain("commissive");
  });

  it("fires on a betrayal", () => {
    expect(shouldExtract(input("I betray Marcus.")).signals).toContain("irreversible");
  });

  it("fires on a death", () => {
    expect(shouldExtract(input("The king died last night.")).signals).toContain("irreversible");
  });
});

describe("gate — preferences", () => {
  it("catches a contraction, which an earlier version missed", () => {
    // "I've always hated coriander" failed the original regex because it
    // required "I" immediately before the adverb. That single miss was most of
    // why the Kapoor House stored almost nothing.
    expect(shouldExtract(input("I've always hated coriander.")).signals).toContain("preference");
  });

  it("catches the uncontracted form too", () => {
    expect(shouldExtract(input("I always hated coriander.")).signals).toContain("preference");
  });

  it("catches durable life events", () => {
    expect(shouldExtract(input("I have been offered a job in Delhi.")).signals).toContain(
      "preference",
    );
  });
});

describe("gate — interrogatives (P1-T19)", () => {
  it("fires on a presupposing question — the question asserts the fact", () => {
    expect(
      shouldExtract(input("Didn't you promise you'd never enter that room?")).signals,
    ).toContain("interrogative");
  });

  it("fires on 'you said' / 'you promised' framing", () => {
    expect(shouldExtract(input("You said the gate was sealed.")).signals).toContain(
      "interrogative",
    );
  });

  it("fires on a reported question — the Ashford pattern", () => {
    // "I ask Hobbes about the decanter" is not literally a question, but it is
    // where a mystery's facts live.
    expect(shouldExtract(input("I ask Hobbes about the decanter.")).signals).toContain(
      "interrogative",
    );
  });

  it("fires on a direct question probing durable state", () => {
    expect(shouldExtract(input("Do you know who killed the king?")).signals).toContain(
      "interrogative",
    );
  });

  it("fires on a question revealing an objective", () => {
    expect(shouldExtract(input("Is the eastern gate still guarded?")).signals).toContain(
      "interrogative",
    );
  });

  it("does NOT fire on a question that carries no durable information", () => {
    // The 36% saving depends on this. Firing on every question would erase it.
    for (const bland of ["What is your name?", "Where am I?", "Can you repeat that?"]) {
      expect(shouldExtract(input(bland)).signals, bland).not.toContain("interrogative");
    }
  });

  it("does not fire on plain movement or description", () => {
    for (const dull of [
      "I walk into the hall.",
      "I look around the room.",
      "I sit down at the table.",
    ]) {
      expect(shouldExtract(input(dull)).shouldExtract, dull).toBe(false);
    }
  });
});

describe("gate — economics", () => {
  it("declines an uneventful turn entirely, spending no inference", () => {
    const result = shouldExtract(input("I nod and step aside."));
    expect(result.shouldExtract).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("fires on the turn floor so a slow scene is still captured eventually", () => {
    const result = shouldExtract(input("Nothing much.", { turnsSinceLastExtraction: 12 }));
    expect(result.signals).toContain("turn_floor");
  });

  it("respects a disabled turn floor", () => {
    const result = shouldExtract(
      input("Nothing much.", { turnsSinceLastExtraction: 99, turnFloor: 0 }),
    );
    expect(result.signals).not.toContain("turn_floor");
  });

  it("fires when a tool call already mutated state", () => {
    expect(shouldExtract(input("...", { toolCallFired: true })).signals).toContain("tool_call");
  });

  it("reports which new entities triggered it", () => {
    const result = shouldExtract(
      input("Elena steps out of the shadows.", { seenEntities: ["Marcus"] }),
    );
    expect(result.newEntities).toContain("Elena");
    expect(result.signals).toContain("new_entity");
  });
});

describe("adjustImportance", () => {
  it("weights irreversibility above the model's own estimate", () => {
    const modest = adjustImportance({
      modelImportance: 0.5,
      kindPrior: 0.5,
      subjectCentrality: 0.5,
      emotionalCharge: 0.5,
      irreversibility: 0,
    });
    const irreversible = adjustImportance({
      modelImportance: 0.5,
      kindPrior: 0.5,
      subjectCentrality: 0.5,
      emotionalCharge: 0.5,
      irreversibility: 1,
    });
    expect(irreversible).toBeGreaterThan(modest);
  });

  it("clamps to a usable range rather than collapsing to zero", () => {
    const floor = adjustImportance({
      modelImportance: 0,
      kindPrior: 0,
      subjectCentrality: 0,
      emotionalCharge: 0,
      irreversibility: 0,
    });
    expect(floor).toBeGreaterThanOrEqual(0.05);
    expect(floor).toBeLessThanOrEqual(1);
  });
});

describe("estimateIrreversibility", () => {
  it("ranks death and betrayal highest", () => {
    expect(estimateIrreversibility("Marcus was betrayed.")).toBe(1);
    expect(estimateIrreversibility("The king died.")).toBe(1);
  });

  it("ranks oaths above gifts, and gifts above description", () => {
    const oath = estimateIrreversibility("The user swore an oath.");
    const gift = estimateIrreversibility("The user gave her bread.");
    const plain = estimateIrreversibility("The room was cold.");
    expect(oath).toBeGreaterThan(gift);
    expect(gift).toBeGreaterThan(plain);
  });
});

describe("gate — acquisition, discovery, assertion (P1-T20)", () => {
  /**
   * Suite 1 found seven of twenty facts at 0% recall, every one carried by a
   * verb the gate did not know. These are the exact sentences that failed.
   */
  const rescued: Array<[string, string]> = [
    ["I buy a coil of rope from Odell.", "acquisition"],
    ["I lose my signet ring in the river crossing.", "acquisition"],
    ["I discover a crypt hidden beneath the chapel.", "discovery"],
    ["I see the eastern watchtower signal fire.", "discovery"],
    ["I remark to Captain Vale that Marcus is Elena's brother.", "assertion"],
    ["I confess to Elena that I am afraid of deep water.", "irreversible"],
  ];

  for (const [sentence, expected] of rescued) {
    it(`fires ${expected} on: ${sentence.slice(0, 42)}…`, () => {
      const r = shouldExtract(input(sentence));
      expect(r.shouldExtract, sentence).toBe(true);
      expect(r.signals, sentence).toContain(expected);
    });
  }

  it("still declines pure filler — the 81% saving must survive", () => {
    // If broadening the vocabulary made the gate fire on everything, it would
    // trade a recall problem for a cost problem.
    const filler = [
      "I walk along the outer wall.",
      "I look out over the courtyard.",
      "I sit down on the low stone bench.",
      "I warm my hands at the brazier.",
      "I stretch my shoulders and roll my neck.",
      "I brush the dust from my sleeve.",
      "I take the long way round the yard.",
    ];
    for (const line of filler) {
      expect(shouldExtract(input(line)).shouldExtract, line).toBe(false);
    }
  });
});
