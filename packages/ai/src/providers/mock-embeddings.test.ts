import { describe, expect, it } from "vitest";
import { MockEmbeddingProvider, cosineSimilarity } from "./mock-embeddings.js";

describe("MockEmbeddingProvider", () => {
  const provider = new MockEmbeddingProvider();

  it("produces 768-dimension vectors, matching the schema", async () => {
    const [vector] = await provider.embed(["The user owns Ravenblade."]);
    expect(vector).toHaveLength(768);
  });

  it("is deterministic", async () => {
    const [a] = await provider.embed(["The user owns Ravenblade."]);
    const [b] = await provider.embed(["The user owns Ravenblade."]);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 6);
  });

  it("produces normalised vectors, so cosine is a plain dot product", async () => {
    const [vector] = await provider.embed(["Marcus keeps a knife beneath his cloak."]);
    expect(cosineSimilarity(vector!, vector!)).toBeCloseTo(1, 5);
  });

  it("scores lexically-similar text as similar — the property retrieval needs", async () => {
    const [a, b, c] = await provider.embed([
      "The user owns Ravenblade, a legendary sword.",
      "Ravenblade, a legendary sword, belongs to the user.",
      "The granary burned during the siege.",
    ]);
    const related = cosineSimilarity(a!, b!);
    const unrelated = cosineSimilarity(a!, c!);
    expect(related).toBeGreaterThan(0.5);
    expect(related).toBeGreaterThan(unrelated + 0.3);
  });

  it("retrieves a planted fact from a natural question", async () => {
    // The end-to-end property the lab depends on.
    const [memory, question, distractor] = await provider.embed([
      "The user owns Ravenblade, a legendary sword.",
      "What sword do I own?",
      "The northern kingdom declared war.",
    ]);
    expect(cosineSimilarity(memory!, question!)).toBeGreaterThan(
      cosineSimilarity(distractor!, question!),
    );
  });

  it("distinguishes word order, so subject/object errors are visible", async () => {
    // Without bigram hashing these would be identical vectors, hiding a real
    // class of retrieval error.
    const [a, b] = await provider.embed(["Elena betrayed Marcus.", "Marcus betrayed Elena."]);
    expect(cosineSimilarity(a!, b!)).toBeLessThan(0.999);
  });

  it("gives near-zero similarity to unrelated text", async () => {
    const [a, b] = await provider.embed([
      "Frost killed most of the orchard.",
      "The queen's physician resigned.",
    ]);
    expect(Math.abs(cosineSimilarity(a!, b!))).toBeLessThan(0.3);
  });

  it("handles empty and punctuation-only input without producing NaN", async () => {
    const [empty, punct] = await provider.embed(["", "!!! ..."]);
    expect([...empty!].every((v) => Number.isFinite(v))).toBe(true);
    expect([...punct!].every((v) => Number.isFinite(v))).toBe(true);
  });

  it("counts batches and texts, so batching behaviour is assertable", async () => {
    const p = new MockEmbeddingProvider();
    await p.embed(["one", "two", "three"]);
    await p.embed(["four"]);
    expect(p.stats).toEqual({ batchCalls: 2, textsEmbedded: 4 });
  });

  it("declares its policy honestly — nothing leaves the process", () => {
    expect(provider.policy.trainsOnInput).toBe(false);
    expect(provider.policy.retentionDays).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("rejects mismatched dimensions rather than silently comparing garbage", () => {
    expect(() => cosineSimilarity(new Float32Array(4), new Float32Array(8))).toThrow(
      /dimension mismatch/i,
    );
  });
});
