import { describe, expect, it } from "vitest";
import type { CharacterId, WorldId } from "@darkforest/contracts";
import { runStoreConformance } from "./conformance.js";
import { InMemoryMemoryStore, __resetMemoryIds } from "./in-memory-store.js";

/**
 * The reference implementation must pass its own contract.
 *
 * This half runs offline under `pnpm test`. The Postgres half runs the SAME
 * cases against a real database via `pnpm db:conformance`, which is where the
 * translation is actually checked — but if the reference ever stops passing,
 * the contract is what changed, and that should fail here first.
 */

const WORLD = "00000000-0000-4000-9000-00000000000f" as WorldId;
const ELENA = "00000000-0000-4000-a000-000000000001" as CharacterId;
const BRAM = "00000000-0000-4000-a000-000000000002" as CharacterId;

describe("MemoryStore conformance — InMemoryMemoryStore", () => {
  it("passes every case", async () => {
    const results = await runStoreConformance(() => {
      __resetMemoryIds();
      return Promise.resolve({
        store: new InMemoryMemoryStore(),
        worldId: WORLD,
        elena: ELENA,
        bram: BRAM,
      });
    });

    const failed = results.filter((r) => !r.ok);
    expect(
      failed.map((f) => `${f.name}: ${f.error ?? ""}`),
      "conformance failures",
    ).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });
});
