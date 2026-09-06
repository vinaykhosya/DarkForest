import type { CharacterId, MemoryId, WorldId } from "@darkforest/contracts";
import type { MemoryStore } from "./store.js";

/**
 * THE STORE CONFORMANCE SUITE — the behavioural contract, run against every
 * implementation.
 *
 * `InMemoryMemoryStore` is the reference and `PostgresMemoryStore` is meant to
 * be a translation of it. "Meant to be" is the problem: the two can diverge in
 * ways no type checker sees — a cosine DISTANCE returned where a SIMILARITY was
 * promised inverts the entire ranking and still returns real memories from the
 * right world. Every assertion here exists because it is a way the translation
 * could be wrong while looking right.
 *
 * Written as plain functions rather than as a vitest file so the same suite can
 * run under vitest (offline, against the in-memory store) and against a live
 * database from a script, without one copy drifting from the other.
 *
 * The store is given fresh per case. `worldId` and `characterId` are supplied by
 * the caller because Postgres needs real rows behind those foreign keys.
 */

export interface ConformanceContext {
  store: MemoryStore;
  worldId: WorldId;
  /** A character who is granted knowledge in the cases that need one. */
  elena: CharacterId;
  /** A character who is granted nothing. The one who must not see secrets. */
  bram: CharacterId;
}

export interface ConformanceCase {
  name: string;
  run: (ctx: ConformanceContext) => Promise<void>;
}

class ConformanceError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function equal<T>(actual: T, expected: T, what: string): void {
  check(
    actual === expected,
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const CASES: ConformanceCase[] = [
  {
    name: "a world-visible memory reaches every character",
    run: async ({ store, worldId, bram }) => {
      const m = await store.insert({
        worldId,
        kind: "world",
        content: "The king died on the night of the northern storm.",
        importance: 0.9,
        visibility: "world",
      });
      const found = await store.keywordSearch(worldId, bram, "king died storm", 10);
      check(
        found.some((c) => c.memory.id === m.id),
        "a character could not see a world-visible memory",
      );
      equal(found.find((c) => c.memory.id === m.id)?.certainty, 1, "world-visible certainty");
    },
  },
  {
    name: "a restricted memory reaches ONLY the character granted it",
    run: async ({ store, worldId, elena, bram }) => {
      const m = await store.insert({
        worldId,
        kind: "episodic",
        content: "Elena hid her brother's bloodied cloak beneath the floorboards.",
        importance: 0.95,
        visibility: "restricted",
      });
      await store.grantKnowledge(elena, m.id, "witnessed", 1, 1);

      const hers = await store.keywordSearch(worldId, elena, "bloodied cloak floorboards", 10);
      check(
        hers.some((c) => c.memory.id === m.id),
        "the character who witnessed it could not recall it",
      );

      // The leak case. A P1 bug, not a quality issue.
      const his = await store.keywordSearch(worldId, bram, "bloodied cloak floorboards", 10);
      check(
        !his.some((c) => c.memory.id === m.id),
        "LEAK: a restricted memory reached a character who was never told",
      );
    },
  },
  {
    name: "the narrator sees restricted memories; characters do not",
    run: async ({ store, worldId, elena }) => {
      const m = await store.insert({
        worldId,
        kind: "episodic",
        content: "A sealed door stands behind the racks at the back of the cellar.",
        importance: 0.8,
        visibility: "restricted",
      });
      await store.grantKnowledge(elena, m.id, "witnessed", 1, 1);
      const narrator = await store.keywordSearch(worldId, null, "sealed door cellar racks", 10);
      check(
        narrator.some((c) => c.memory.id === m.id),
        "the narrator, which has world scope, could not see a restricted memory",
      );
    },
  },
  {
    name: "a soft-deleted memory is invisible to every path",
    run: async ({ store, worldId, elena }) => {
      const m = await store.insert({
        worldId,
        kind: "semantic",
        content: "The ferry crosses the strait at dawn and at dusk.",
        importance: 0.5,
        visibility: "world",
      });
      await store.softDelete(m.id);
      const found = await store.keywordSearch(worldId, elena, "ferry strait dawn", 10);
      check(found.length === 0, "a soft-deleted memory was retrievable");
      equal(await store.countByWorld(worldId), 0, "count after soft delete");
      equal((await store.allByWorld(worldId)).length, 0, "allByWorld after soft delete");
    },
  },
  {
    name: "a superseded memory is invisible, and its vector is dropped",
    run: async ({ store, worldId, elena }) => {
      const old = await store.insert({
        worldId,
        kind: "semantic",
        content: "Elena keeps the ring in the locked drawer.",
        importance: 0.7,
        visibility: "world",
      });
      await store.setEmbedding(old.id, new Float32Array(768).fill(0.1), "test-model", 1);
      const now = await store.insert({
        worldId,
        kind: "semantic",
        content: "Marcus keeps the ring in the locked drawer.",
        importance: 0.7,
        visibility: "world",
      });
      await store.supersede(old.id, now.id);

      const found = await store.keywordSearch(worldId, elena, "ring locked drawer", 10);
      check(
        !found.some((c) => c.memory.id === old.id),
        "a superseded memory was still retrievable — the stale fact competes with the true one",
      );
      const pending = await store.pendingEmbeddings(worldId, 10);
      check(
        !pending.some((p) => p.id === old.id),
        "a superseded memory was queued for re-embedding",
      );
    },
  },
  {
    name: "learning again raises certainty and never lowers it",
    run: async ({ store, worldId, elena }) => {
      const m = await store.insert({
        worldId,
        kind: "episodic",
        content: "The caravan turned east instead of north.",
        importance: 0.6,
        visibility: "restricted",
      });
      await store.grantKnowledge(elena, m.id, "overheard", 0.4, 1);
      await store.grantKnowledge(elena, m.id, "witnessed", 0.9, 2);
      let found = await store.keywordSearch(worldId, elena, "caravan turned east", 10);
      equal(found.find((c) => c.memory.id === m.id)?.certainty, 0.9, "certainty after raising");

      await store.grantKnowledge(elena, m.id, "inferred", 0.2, 3);
      found = await store.keywordSearch(worldId, elena, "caravan turned east", 10);
      equal(
        found.find((c) => c.memory.id === m.id)?.certainty,
        0.9,
        "certainty after a weaker source — it must not drop",
      );
    },
  },
  {
    name: "editing content invalidates the vector and marks the memory user-edited",
    run: async ({ store, worldId }) => {
      const m = await store.insert({
        worldId,
        kind: "semantic",
        content: "The bridge at Saltmarsh was rebuilt after the flood.",
        importance: 0.5,
        visibility: "world",
      });
      await store.setEmbedding(m.id, new Float32Array(768).fill(0.2), "test-model", 1);
      equal((await store.pendingEmbeddings(worldId, 10)).length, 0, "pending before edit");

      const edited = await store.update(m.id, { content: "The bridge at Saltmarsh still stands." });
      equal(edited.isUserEdited, true, "isUserEdited after a content edit");
      const pending = await store.pendingEmbeddings(worldId, 10);
      check(
        pending.some((p) => p.id === m.id),
        "an edited memory kept a vector of its old text — retrieval would match the wrong words",
      );
    },
  },
  {
    name: "a non-content edit leaves the vector alone",
    run: async ({ store, worldId }) => {
      const m = await store.insert({
        worldId,
        kind: "semantic",
        content: "The lighthouse keeper is called Ilse.",
        importance: 0.4,
        visibility: "world",
      });
      await store.setEmbedding(m.id, new Float32Array(768).fill(0.3), "test-model", 1);
      const edited = await store.update(m.id, { isPinned: true, importance: 0.9 });
      equal(edited.isPinned, true, "isPinned");
      equal(edited.isUserEdited, false, "a pin is not a user content edit");
      equal(
        (await store.pendingEmbeddings(worldId, 10)).length,
        0,
        "re-embedding was triggered by a pin, which costs a model call for nothing",
      );
    },
  },
  {
    name: "vector search returns similarity, so the nearest vector ranks first",
    run: async ({ store, worldId, elena }) => {
      const near = await store.insert({
        worldId,
        kind: "semantic",
        content: "The tide turns at moonrise.",
        importance: 0.5,
        visibility: "world",
      });
      const far = await store.insert({
        worldId,
        kind: "semantic",
        content: "Bram sold the mare at the spring fair.",
        importance: 0.5,
        visibility: "world",
      });
      const query = new Float32Array(768).fill(0);
      query[0] = 1;
      const nearVec = new Float32Array(768).fill(0);
      nearVec[0] = 1;
      const farVec = new Float32Array(768).fill(0);
      farVec[1] = 1;
      await store.setEmbedding(near.id, nearVec, "test-model", 1);
      await store.setEmbedding(far.id, farVec, "test-model", 1);

      const found = await store.vectorSearch(worldId, elena, query, 10);
      check(found.length >= 2, `vector search returned ${String(found.length)} results`);
      equal(
        found[0]?.memory.id,
        near.id,
        "the NEAREST vector did not rank first — a distance was returned where a similarity was promised",
      );
      check(
        (found[0]?.rawScore ?? 0) > (found[1]?.rawScore ?? 1),
        "rawScore did not decrease with distance",
      );
    },
  },
  {
    name: "vector search skips memories with no embedding rather than failing",
    run: async ({ store, worldId, elena }) => {
      const embedded = await store.insert({
        worldId,
        kind: "semantic",
        content: "The mill wheel broke in the storm.",
        importance: 0.5,
        visibility: "world",
      });
      await store.insert({
        worldId,
        kind: "semantic",
        content: "The baker closes early on market day.",
        importance: 0.5,
        visibility: "world",
      });
      const vec = new Float32Array(768).fill(0);
      vec[0] = 1;
      await store.setEmbedding(embedded.id, vec, "test-model", 1);

      // Retrieval degrades, never fails (docs/04 § 11).
      const found = await store.vectorSearch(worldId, elena, vec, 10);
      equal(found.length, 1, "unembedded memories must be skipped, not fatal");
      equal(found[0]?.memory.id, embedded.id, "the embedded memory");
    },
  },
  {
    name: "structural search: pinned outranks subject match outranks recent",
    run: async ({ store, worldId, elena }) => {
      const pinned = await store.insert({
        worldId,
        kind: "world",
        content: "The war ended three winters ago.",
        importance: 0.9,
        visibility: "world",
        isPinned: true,
        worldDay: 1,
      });
      const subject = await store.insert({
        worldId,
        kind: "relational",
        content: "Bram distrusts the harbourmaster.",
        importance: 0.6,
        visibility: "world",
        subjects: ["narrator"],
        worldDay: 2,
      });
      const recent = await store.insert({
        worldId,
        kind: "episodic",
        content: "A ship arrived flying no colours.",
        importance: 0.5,
        visibility: "world",
        worldDay: 99,
      });

      const found = await store.structuralSearch(worldId, elena, {
        includePinned: true,
        recentCount: 1,
        subjects: ["narrator"],
      });
      const score = (id: MemoryId): number =>
        found.find((c) => c.memory.id === id)?.rawScore ?? -1;
      check(score(pinned.id) > score(subject.id), "pinned must outrank a subject match");
      check(score(subject.id) > score(recent.id), "a subject match must outrank mere recency");
      check(
        found[0]?.memory.id === pinned.id,
        "results must be ordered by score, highest first",
      );
    },
  },
  {
    name: "structural search honours recentCount rather than returning everything",
    run: async ({ store, worldId, elena }) => {
      for (let i = 0; i < 5; i++) {
        await store.insert({
          worldId,
          kind: "episodic",
          content: `Something unremarkable happened on day ${String(i)} of the season.`,
          importance: 0.3,
          visibility: "world",
          worldDay: i,
        });
      }
      const found = await store.structuralSearch(worldId, elena, {
        includePinned: false,
        recentCount: 2,
        subjects: [],
      });
      equal(found.length, 2, "recentCount was not applied to its own branch");
      equal(found[0]?.memory.worldDay, 4, "the most recent day first");
    },
  },
  {
    name: "structural search obeys isolation like every other path",
    run: async ({ store, worldId, elena, bram }) => {
      const secret = await store.insert({
        worldId,
        kind: "episodic",
        content: "The key is hidden under the third flagstone.",
        importance: 0.9,
        visibility: "restricted",
        isPinned: true,
        worldDay: 5,
      });
      await store.grantKnowledge(elena, secret.id, "told", 1, 5);

      const his = await store.structuralSearch(worldId, bram, {
        includePinned: true,
        recentCount: 5,
        subjects: [],
      });
      check(
        !his.some((c) => c.memory.id === secret.id),
        "LEAK: a pinned restricted memory reached a character who was never told",
      );
    },
  },
  {
    name: "recordAccess counts, and an empty list is not an error",
    run: async ({ store, worldId }) => {
      const m = await store.insert({
        worldId,
        kind: "semantic",
        content: "Salt is traded by weight, never by volume.",
        importance: 0.4,
        visibility: "world",
      });
      await store.recordAccess([]);
      await store.recordAccess([m.id, m.id]);
      const after = await store.get(m.id);
      check((after?.accessCount ?? 0) >= 1, "accessCount did not increase");
    },
  },
  {
    name: "get returns null for an id that does not exist",
    run: async ({ store }) => {
      const missing = await store.get("00000000-0000-4000-8000-ffffffffffff" as MemoryId);
      equal(missing, null, "get on a missing id");
    },
  },
  {
    name: "insert round-trips every field",
    run: async ({ store, worldId }) => {
      const m = await store.insert({
        worldId,
        kind: "persona",
        content: "The traveller cannot swim.",
        subjects: ["narrator"],
        location: "the ferry landing",
        worldDay: 12,
        importance: 0.85,
        confidence: 0.7,
        visibility: "restricted",
        isPinned: true,
      });
      const back = await store.get(m.id);
      check(back !== null, "insert returned an id that get cannot find");
      equal(back.kind, "persona", "kind");
      equal(back.content, "The traveller cannot swim.", "content");
      equal(back.subjects.join(","), "narrator", "subjects");
      equal(back.location, "the ferry landing", "location");
      equal(back.worldDay, 12, "worldDay");
      equal(back.importance, 0.85, "importance");
      equal(back.confidence, 0.7, "confidence");
      equal(back.visibility, "restricted", "visibility");
      equal(back.isPinned, true, "isPinned");
      equal(back.supersededBy, null, "supersededBy");
      equal(back.deletedAt, null, "deletedAt");
    },
  },
];

export interface ConformanceResult {
  name: string;
  ok: boolean;
  error: string | null;
}

/**
 * Runs every case, each against a FRESH store from `makeStore`.
 *
 * Fresh per case because a shared store makes a failure in one case cause a
 * confusing failure in the next, and because counting assertions
 * (`countByWorld`) are only meaningful in isolation.
 */
export async function runStoreConformance(
  makeStore: () => Promise<ConformanceContext>,
  teardown: (ctx: ConformanceContext) => Promise<void> = () => Promise.resolve(),
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of CASES) {
    const ctx = await makeStore();
    try {
      await c.run(ctx);
      results.push({ name: c.name, ok: true, error: null });
    } catch (e) {
      results.push({
        name: c.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await teardown(ctx);
    }
  }
  return results;
}

export const CONFORMANCE_CASE_NAMES: readonly string[] = CASES.map((c) => c.name);
