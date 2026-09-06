import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type DbPool, asSystem, asUser, createPool } from "@darkforest/db";

/**
 * `pnpm db:rls` â€” the NEGATIVE tests. V1-T09.
 *
 * "RLS is enabled" and "RLS is enforced" are different claims, and only the
 * second one protects anybody. ADR-030 spells out how the first can be true
 * while the second is false for every request in production: connect as
 * `postgres` or `service_role` and every policy is skipped silently.
 *
 * So this connects through `asUser()` â€” the same helper the API will use â€” and
 * asserts that user B cannot see, modify, or delete ANY of user A's rows, table
 * by table. A test that only proves A can read their own data would pass just as
 * happily with no policies at all.
 *
 * Fixtures must be COMMITTED for this to mean anything (two users on two
 * connections cannot see each other's uncommitted rows regardless of RLS, which
 * would make the whole suite pass for the wrong reason). Cleanup therefore runs
 * in a `finally` and uses the deliberate-erasure flag.
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

const failures: string[] = [];
function report(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(26)} ${detail}`);
  if (!ok) failures.push(name);
}

interface Fixture {
  userId: string;
  worldId: string;
  characterId: string;
  memoryId: string;
}

async function seed(pool: DbPool, label: string): Promise<Fixture> {
  return asSystem(pool, "rls negative-test fixture", async (c) => {
    const userId = randomUUID();
    const worldId = randomUUID();
    const characterId = randomUUID();
    const memoryId = randomUUID();
    await c.query("begin");
    try {
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
                 'authenticated', $2, now(), now())`,
        [userId, `rlscheck-${label}-${userId.slice(0, 8)}@example.invalid`],
      );
      await c.query("insert into worlds (id, owner_id, name) values ($1, $2, $3)", [
        worldId,
        userId,
        `${label}'s world`,
      ]);
      await c.query("insert into world_state (world_id) values ($1)", [worldId]);
      await c.query("insert into characters (id, world_id, name) values ($1, $2, $3)", [
        characterId,
        worldId,
        "Elena",
      ]);
      await c.query(
        `insert into turns (world_id, seq, speaker, content, world_day)
         values ($1, 0, 'player', $2, 1)`,
        [worldId, `${label} said something private`],
      );
      await c.query(
        `insert into events
           (world_id, world_day, seq, type, actor, value, audience, source_turn)
         values ($1, 1, 0, 'revealed', 'the user', $2, $3, 0)`,
        [worldId, `${label}'s secret`, ["the user", "Elena"]],
      );
      await c.query(
        `insert into memories (id, world_id, kind, content) values ($1, $2, 'secret', $3)`,
        [memoryId, worldId, `${label}'s secret memory`],
      );
      await c.query(
        `insert into character_knowledge (character_id, memory_id, source)
         values ($1, $2, 'told')`,
        [characterId, memoryId],
      );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
    return { userId, worldId, characterId, memoryId };
  });
}

async function destroy(pool: DbPool, f: Fixture): Promise<void> {
  await asSystem(pool, "rls negative-test cleanup", async (c) => {
    await c.query("begin");
    try {
      // Deliberate erasure, declared. The append-only triggers on turns and
      // events refuse the cascade without it â€” which is the point of the flag.
      await c.query("select set_config('app.hard_delete', 'on', true)");
      await c.query("delete from auth.users where id = $1", [f.userId]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  });
}

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url =
    env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"] ?? "";
  if (url.length === 0) throw new Error("no database url");

  const pool = createPool({ url });
  let a: Fixture | null = null;
  let b: Fixture | null = null;

  try {
    a = await seed(pool, "alice");
    b = await seed(pool, "bob");
    const alice = a;
    const bob = b;

    // â”€â”€ the positive case, so a total lockout cannot masquerade as security â”€â”€
    await asUser(pool, alice.userId, async (c) => {
      const own = await c.query<{ n: string }>("select count(*) as n from worlds where id = $1", [
        alice.worldId,
      ]);
      report("owner reads own world", Number(own.rows[0]?.n ?? "0") === 1, "1 row");
    });

    // â”€â”€ the negative cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await asUser(pool, bob.userId, async (c) => {
      const tables: Array<[string, string, unknown]> = [
        ["worlds", "select count(*) as n from worlds where id = $1", alice.worldId],
        ["world_state", "select count(*) as n from world_state where world_id = $1", alice.worldId],
        ["characters", "select count(*) as n from characters where world_id = $1", alice.worldId],
        ["turns", "select count(*) as n from turns where world_id = $1", alice.worldId],
        ["events", "select count(*) as n from events where world_id = $1", alice.worldId],
        ["memories", "select count(*) as n from memories where world_id = $1", alice.worldId],
        [
          "character_knowledge",
          "select count(*) as n from character_knowledge where character_id = $1",
          alice.characterId,
        ],
      ];
      for (const [table, sql, param] of tables) {
        const r = await c.query<{ n: string }>(sql, [param]);
        const n = Number(r.rows[0]?.n ?? "-1");
        report(`B cannot read A.${table}`, n === 0, n === 0 ? "0 rows" : `SAW ${String(n)} ROWS`);
      }

      const prof = await c.query<{ n: string }>(
        "select count(*) as n from profiles where id = $1",
        [alice.userId],
      );
      report(
        "B cannot read A.profile",
        Number(prof.rows[0]?.n ?? "-1") === 0,
        Number(prof.rows[0]?.n ?? "-1") === 0 ? "0 rows" : "SAW A PROFILE",
      );

      // Writes. An UPDATE blocked by RLS reports 0 rows affected rather than an
      // error, so the row is re-read afterwards to prove it is untouched.
      const upd = await c.query("update worlds set name = 'stolen' where id = $1", [
        alice.worldId,
      ]);
      report("B cannot rename A.world", upd.rowCount === 0, `${String(upd.rowCount)} rows updated`);

      const del = await c.query("delete from worlds where id = $1", [alice.worldId]);
      report("B cannot delete A.world", del.rowCount === 0, `${String(del.rowCount)} rows deleted`);

      // Insert INTO A's world: rejected by the `with check` half of the policy,
      // which is a different clause from `using` and fails independently.
      let insertBlocked = false;
      await c.query("savepoint ins");
      try {
        await c.query("insert into characters (world_id, name) values ($1, 'Intruder')", [
          alice.worldId,
        ]);
        await c.query("rollback to savepoint ins");
      } catch {
        await c.query("rollback to savepoint ins");
        insertBlocked = true;
      }
      report("B cannot add to A.world", insertBlocked, insertBlocked ? "rejected" : "ACCEPTED");
    });

    // â”€â”€ and A's world survived all of it â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await asSystem(pool, "post-check verification", async (c) => {
      const r = await c.query<{ name: string }>("select name from worlds where id = $1", [
        alice.worldId,
      ]);
      report(
        "A's world intact",
        r.rows[0]?.name === "alice's world",
        `name is '${r.rows[0]?.name ?? "GONE"}'`,
      );
    });
  } finally {
    if (a !== null) await destroy(pool, a);
    if (b !== null) await destroy(pool, b);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n  ${String(failures.length)} RLS NEGATIVE TEST(S) FAILED\n`);
    process.exitCode = 1;
  } else {
    console.log("\n  RLS is enforced, not merely enabled\n");
  }
}

main().catch((e: unknown) => {
  console.error(`\n  RLS CHECK FAILED\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
