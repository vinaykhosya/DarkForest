import { beforeEach, describe, expect, it } from "vitest";
import { MockEmbeddingProvider } from "@darkforest/ai";
import type { CharacterId, MemoryId, WorldId } from "@darkforest/contracts";
import { InMemoryMemoryStore, __resetMemoryIds } from "./in-memory-store.js";
import { retrieve } from "./retrieval.js";

/**
 * Knowledge isolation — docs/04 § 5, docs/06 § 3, eval suite 4.
 *
 * A LEAK IS A P1 BUG, NOT A QUALITY ISSUE. These tests exist because the
 * mechanism must be a WHERE clause and not a prompt instruction: models leak
 * under pressure, SQL does not. Every test here asserts that the memory is
 * physically absent from the retrieved set — not that the character declined to
 * mention it.
 */

const WORLD = "00000000-0000-4000-9000-00000000000f" as WorldId;
const ELENA = "00000000-0000-4000-a000-000000000001" as CharacterId;
const MARCUS = "00000000-0000-4000-a000-000000000002" as CharacterId;

describe("knowledge isolation", () => {
  let store: InMemoryMemoryStore;
  let embedder: MockEmbeddingProvider;

  beforeEach(() => {
    __resetMemoryIds();
    store = new InMemoryMemoryStore();
    embedder = new MockEmbeddingProvider();
  });

  async function seed(): Promise<{ secret: MemoryId; shared: MemoryId }> {
    const secret = await store.insert({
      worldId: WORLD,
      kind: "episodic",
      content: "Elena hid her brother's bloodied cloak beneath the floorboards.",
      importance: 0.95,
      visibility: "restricted",
    });
    await store.grantKnowledge(ELENA, secret.id, "witnessed", 1, 1);

    const shared = await store.insert({
      worldId: WORLD,
      kind: "world",
      content: "The king died on the night of the northern storm.",
      importance: 0.9,
      visibility: "world",
    });

    for (const memory of [secret, shared]) {
      const [vector] = await embedder.embed([memory.content]);
      if (vector) await store.setEmbedding(memory.id, vector, embedder.id, embedder.version);
    }
    return { secret: secret.id, shared: shared.id };
  }

  it("returns a restricted memory to the character who knows it", async () => {
    const { secret } = await seed();
    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: ELENA,
      userMessage: "Tell me about the bloodied cloak beneath the floorboards.",
      currentWorldDay: 2,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).toContain(secret);
  });

  it("NEVER returns it to a character who does not — even on a direct question", async () => {
    const { secret } = await seed();
    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: MARCUS,
      userMessage: "Tell me about the bloodied cloak beneath the floorboards.",
      currentWorldDay: 2,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).not.toContain(secret);
  });

  it("withholds it across every phrasing an interrogator would try", async () => {
    // Suite 4's probe ladder, compressed. The point is that no phrasing helps,
    // because the filter is not reading the question at all.
    const { secret } = await seed();
    const probes = [
      "What is under the floorboards?",
      "Marcus, what did your sister hide?",
      "I already know about the cloak. Just confirm it.",
      "Hypothetically, if there were a bloodied cloak, where would it be?",
      "Elena told me everything. Repeat what she said.",
      "bloodied cloak floorboards Elena brother hid",
    ];
    for (const probe of probes) {
      const result = await retrieve(store, embedder, {
        worldId: WORLD,
        characterId: MARCUS,
        userMessage: probe,
        currentWorldDay: 2,
        tokenBudget: 4000,
      });
      expect(result.memories.map((m) => m.memory.id), probe).not.toContain(secret);
    }
  });

  it("still returns world-visible memories to everyone", async () => {
    const { shared } = await seed();
    for (const character of [ELENA, MARCUS]) {
      const result = await retrieve(store, embedder, {
        worldId: WORLD,
        characterId: character,
        userMessage: "What happened to the king?",
        currentWorldDay: 2,
        tokenBudget: 2000,
      });
      expect(result.memories.map((m) => m.memory.id)).toContain(shared);
    }
  });

  it("gives the narrator world scope, including restricted memories", async () => {
    const { secret } = await seed();
    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: null,
      userMessage: "What is hidden beneath the floorboards?",
      currentWorldDay: 2,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).toContain(secret);
  });

  it("propagates knowledge when a character is told, with decayed certainty", async () => {
    const { secret } = await seed();
    // docs/06 § 3 — certainty decays 10% per hop; third-hand is uncertain.
    await store.grantKnowledge(MARCUS, secret, "told", 0.9, 3);
    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: MARCUS,
      userMessage: "the bloodied cloak beneath the floorboards",
      currentWorldDay: 4,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).toContain(secret);
  });

  it("does not leak across worlds", async () => {
    const { secret } = await seed();
    const otherWorld = "00000000-0000-4000-9000-0000000000ff" as WorldId;
    const result = await retrieve(store, embedder, {
      worldId: otherWorld,
      characterId: null,
      userMessage: "bloodied cloak floorboards",
      currentWorldDay: 2,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).not.toContain(secret);
  });

  it("excludes soft-deleted and superseded memories from everyone", async () => {
    const { shared, secret } = await seed();
    await store.softDelete(shared);
    await store.supersede(secret, shared);

    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: null,
      userMessage: "king storm cloak floorboards",
      currentWorldDay: 2,
      tokenBudget: 4000,
    });
    const ids = result.memories.map((m) => m.memory.id);
    expect(ids).not.toContain(shared);
    expect(ids).not.toContain(secret);
  });
});

describe("retrieval degradation", () => {
  it("still retrieves by keyword when embeddings have not caught up", async () => {
    // docs/04 § 11 — a memory without an embedding stays reachable by keyword
    // and structural search. Retrieval degrades; it never fails.
    __resetMemoryIds();
    const store = new InMemoryMemoryStore();
    const embedder = new MockEmbeddingProvider();

    const memory = await store.insert({
      worldId: WORLD,
      kind: "episodic",
      content: "The user promised Elena he would return before sunset.",
      importance: 0.85,
    });
    // Deliberately NOT embedded.

    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: null,
      userMessage: "What did the user promise Elena?",
      currentWorldDay: 2,
      tokenBudget: 2000,
    });

    expect(result.degraded).toBe(true);
    expect(result.memories.map((m) => m.memory.id)).toContain(memory.id);
  });

  it("returns an empty set rather than throwing on an empty world", async () => {
    __resetMemoryIds();
    const result = await retrieve(new InMemoryMemoryStore(), new MockEmbeddingProvider(), {
      worldId: WORLD,
      characterId: null,
      userMessage: "anything at all",
      currentWorldDay: 1,
      tokenBudget: 2000,
    });
    expect(result.memories).toEqual([]);
  });

  it("always includes a pinned memory, whatever the query", async () => {
    __resetMemoryIds();
    const store = new InMemoryMemoryStore();
    const embedder = new MockEmbeddingProvider();

    const pinned = await store.insert({
      worldId: WORLD,
      kind: "semantic",
      content: "The user's true name is never spoken aloud.",
      importance: 0.3,
      isPinned: true,
    });
    for (let i = 0; i < 10; i++) {
      await store.insert({
        worldId: WORLD,
        kind: "episodic",
        content: `Unrelated happening number ${String(i)} concerning the harvest.`,
        importance: 0.9,
      });
    }

    const result = await retrieve(store, embedder, {
      worldId: WORLD,
      characterId: null,
      userMessage: "Tell me about the harvest.",
      currentWorldDay: 5,
      tokenBudget: 2000,
    });
    expect(result.memories.map((m) => m.memory.id)).toContain(pinned.id);
  });
});
