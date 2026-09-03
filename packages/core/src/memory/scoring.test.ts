import { describe, expect, it } from "vitest";
import type { EntityRef } from "@darkforest/contracts";
import {
  accessBoost,
  characterRelevance,
  recencyScore,
  scoreAll,
  scoreMemory,
  type ScorableMemory,
  type ScoringContext,
} from "./scoring.js";
import { tokenSet } from "./text.js";

const ELENA = "character:11111111-1111-4111-8111-111111111111" as EntityRef;
const MARCUS = "character:22222222-2222-4222-8222-222222222222" as EntityRef;

function memory(over: Partial<ScorableMemory> = {}): ScorableMemory {
  return {
    id: "m1",
    kind: "episodic",
    content: "The user rescued Elena from the dungeon on day 14.",
    subjects: [ELENA],
    worldDay: 14,
    importance: 0.5,
    isPinned: false,
    accessCount: 0,
    similarity: 0.5,
    ...over,
  };
}

function ctx(over: Partial<ScoringContext> = {}): ScoringContext {
  return {
    currentWorldDay: 20,
    characterRef: ELENA,
    sceneTokens: tokenSet(""),
    ...over,
  };
}

describe("recencyScore", () => {
  it("returns 1 for a memory created today", () => {
    expect(recencyScore("episodic", 20, 20)).toBe(1);
  });

  it("returns exactly 0.5 at one half-life", () => {
    // episodic half-life is 30 world days
    expect(recencyScore("episodic", 0, 30)).toBeCloseTo(0.5, 6);
  });

  it("decays episodic memories faster than semantic ones", () => {
    const episodic = recencyScore("episodic", 0, 60);
    const semantic = recencyScore("semantic", 0, 60);
    expect(semantic).toBeGreaterThan(episodic);
  });

  it("never decays world memories — the king stays dead", () => {
    expect(recencyScore("world", 0, 10_000)).toBe(1);
  });

  it("treats an undated memory as timeless, not ancient", () => {
    // Absent data must not be read as evidence of age.
    expect(recencyScore("episodic", null, 500)).toBe(1);
  });

  it("does not go negative when a memory is dated in the future", () => {
    // Can happen after a time-skip rollback; must not produce a score above 1.
    expect(recencyScore("episodic", 100, 50)).toBe(1);
  });
});

describe("characterRelevance", () => {
  it("is highest when the character is a subject", () => {
    expect(characterRelevance({ subjects: [ELENA] }, ELENA)).toBe(1);
  });

  it("is middling when only a linked memory names them", () => {
    expect(characterRelevance({ subjects: [MARCUS], linkedToCharacter: true }, ELENA)).toBe(0.5);
  });

  it("is low but non-zero for unrelated world context", () => {
    expect(characterRelevance({ subjects: [MARCUS] }, ELENA)).toBe(0.1);
  });

  it("treats the narrator as concerned with everything", () => {
    expect(characterRelevance({ subjects: [MARCUS] }, null)).toBe(1);
  });
});

describe("accessBoost", () => {
  it("is zero for a never-recalled memory", () => {
    expect(accessBoost(0)).toBe(0);
  });

  it("increases with access count", () => {
    expect(accessBoost(5)).toBeGreaterThan(accessBoost(1));
  });

  it("saturates so a runaway memory cannot starve everything else", () => {
    expect(accessBoost(10)).toBeCloseTo(1, 5);
    expect(accessBoost(10_000)).toBe(1);
  });
});

describe("scoreMemory", () => {
  it("ranks a pinned memory above a higher-similarity unpinned one", () => {
    // The whole point of pinning is that it is not negotiable.
    const pinned = scoreMemory(memory({ id: "pin", isPinned: true, similarity: 0 }), ctx());
    const strong = scoreMemory(memory({ id: "hot", similarity: 1, importance: 1 }), ctx());
    expect(pinned.score).toBeGreaterThan(strong.score);
  });

  it("reports only the pinned term for a pinned memory", () => {
    const { breakdown } = scoreMemory(memory({ isPinned: true }), ctx());
    expect(Object.keys(breakdown)).toEqual(["pinned"]);
  });

  it("produces a breakdown whose terms sum to the score", () => {
    const { score, breakdown } = scoreMemory(memory(), ctx());
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(score, 10);
  });

  it("rewards topic overlap with the current scene", () => {
    const scene = tokenSet("Elena stands in the dungeon holding a torch");
    const onTopic = scoreMemory(memory(), ctx({ sceneTokens: scene }));
    const offTopic = scoreMemory(memory(), ctx({ sceneTokens: tokenSet("") }));
    expect(onTopic.score).toBeGreaterThan(offTopic.score);
  });

  it("clamps a malformed similarity rather than propagating NaN", () => {
    const { score } = scoreMemory(memory({ similarity: Number.NaN }), ctx());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("weights importance — an oath outranks a passing remark", () => {
    const oath = scoreMemory(memory({ id: "a", importance: 0.95 }), ctx());
    const remark = scoreMemory(memory({ id: "b", importance: 0.1 }), ctx());
    expect(oath.score).toBeGreaterThan(remark.score);
  });
});

describe("scoreAll", () => {
  it("returns memories sorted best-first", () => {
    const scored = scoreAll(
      [
        memory({ id: "weak", similarity: 0.1, importance: 0.1 }),
        memory({ id: "strong", similarity: 0.9, importance: 0.9 }),
        memory({ id: "mid", similarity: 0.5, importance: 0.5 }),
      ],
      ctx(),
    );
    expect(scored.map((s) => s.memory.id)).toEqual(["strong", "mid", "weak"]);
  });

  it("handles an empty candidate set", () => {
    expect(scoreAll([], ctx())).toEqual([]);
  });
});
