import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CharacterId, WorldId } from "@darkforest/contracts";
import { type DbPool, PostgresMemoryStore, asSystem, createPool } from "@darkforest/db";
import { type ConformanceContext, runStoreConformance } from "@darkforest/memory";

/**
 * `pnpm db:conformance` — V1-T10.
 *
 * Runs the SAME cases `InMemoryMemoryStore` passes under `pnpm test`, against a
 * real Postgres. This is the acceptance criterion for the Postgres store: not
 * "it compiles and the queries look right", but "it behaves identically to the
 * implementation every benchmark so far was measured against".
 *
 * Each case gets a fresh world and its own transaction, always rolled back. A
 * conformance run must leave a database exactly as it found it, or the next one
 * is measuring the previous one's leftovers.
 */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const v = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
    if (v) out[m[1]] = v;
  }
  return out;
}

/** Kept so each case's transaction can be rolled back after it runs. */
const open = new Map<string, { release: () => void; rollback: () => Promise<void> }>();

async function makeContext(pool: DbPool): Promise<ConformanceContext> {
  const worldId = randomUUID() as WorldId;
  const elena = randomUUID() as CharacterId;
  const bram = randomUUID() as CharacterId;
  const ownerId = randomUUID();

  return asSystem(pool, "store conformance fixture", async (c) => {
    await c.query("begin");
    await c.query(
      `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
               'authenticated', $2, now(), now())`,
      [ownerId, `conformance-${ownerId.slice(0, 8)}@example.invalid`],
    );
    await c.query("insert into worlds (id, owner_id, name) values ($1,$2,'conformance')", [
      worldId,
      ownerId,
    ]);
    await c.query("insert into world_state (world_id) values ($1)", [worldId]);
    await c.query("insert into characters (id, world_id, name) values ($1,$2,'Elena')", [
      elena,
      worldId,
    ]);
    await c.query("insert into characters (id, world_id, name) values ($1,$2,'Bram')", [
      bram,
      worldId,
    ]);

    open.set(worldId, {
      release: () => undefined,
      rollback: async () => {
        await c.query("rollback");
      },
    });

    return { store: new PostgresMemoryStore(c), worldId, elena, bram };
  });
}

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url =
    env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"] ?? "";
  if (url.length === 0) throw new Error("no database url");

  // One connection at a time: each case holds an open transaction for its whole
  // run, and a pool that hands out a second connection would let two cases
  // interleave DDL-free but confusingly.
  const pool = createPool({ url, max: 1 });

  try {
    const results = await runStoreConformance(
      () => makeContext(pool),
      async (ctx) => {
        const handle = open.get(ctx.worldId);
        if (handle) {
          await handle.rollback();
          open.delete(ctx.worldId);
        }
      },
    );

    console.log("\n  MemoryStore conformance — PostgresMemoryStore\n");
    for (const r of results) {
      console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}`);
      if (!r.ok) console.log(`        ${r.error ?? ""}`);
    }

    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n  ${String(results.length - failed.length)}/${String(results.length)} cases\n`,
    );
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\n  CONFORMANCE FAILED\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
