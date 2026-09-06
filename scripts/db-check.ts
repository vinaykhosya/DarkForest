import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type DbClient, asSystem, createPool } from "@darkforest/db";

/**
 * `pnpm db:check` — the schema invariants that must never be false. V1-T08.
 *
 * This does a REAL round trip — auth user, profile, world, character, turn,
 * event — inside a transaction that is always rolled back. Checking that a
 * trigger exists would prove only that a trigger exists; the append-only rule is
 * worth nothing unless it actually refuses, so the check attempts the forbidden
 * write and requires the error.
 *
 * Runs against a real database, so it is deliberately NOT part of `pnpm check`,
 * which must stay free and offline (CLAUDE.md § 7).
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
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(22)} ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

/** Runs `sql` expecting it to fail, and returns the message. Savepointed. */
async function mustReject(c: DbClient, sql: string, params: unknown[] = []): Promise<string> {
  await c.query("savepoint probe");
  try {
    await c.query(sql, params);
    await c.query("release savepoint probe");
    return "";
  } catch (e) {
    await c.query("rollback to savepoint probe");
    return e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url =
    env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"] ?? "";
  if (url.length === 0) throw new Error("no database url");

  const pool = createPool({ url });
  try {
    await asSystem(pool, "schema invariant check", async (c) => {
      // ── RLS ──────────────────────────────────────────────────────────────
      const unprotected = await c.query<{ table_name: string }>(
        "select table_name from public_tables_without_rls order by table_name",
      );
      report(
        "RLS",
        unprotected.rows.length === 0,
        unprotected.rows.length === 0
          ? "enabled on every public table"
          : `missing on ${unprotected.rows.map((r) => r.table_name).join(", ")}`,
      );

      await c.query("begin");
      try {
        const userId = randomUUID();
        const email = `dbcheck-${userId.slice(0, 8)}@example.invalid`;

        // ── the profile trigger ─────────────────────────────────────────────
        await c.query(
          `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
           values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
                   'authenticated', $2, now(), now())`,
          [userId, email],
        );
        const prof = await c.query<{ handle: string }>(
          "select handle from profiles where id = $1",
          [userId],
        );
        report(
          "profile trigger",
          prof.rows.length === 1,
          prof.rows.length === 1
            ? `auth user -> profile '${prof.rows[0]?.handle ?? ""}'`
            : "no profile created for a new auth user",
        );

        const worldId = randomUUID();
        await c.query("insert into worlds (id, owner_id, name) values ($1, $2, $3)", [
          worldId,
          userId,
          "db-check world",
        ]);
        await c.query("insert into world_state (world_id) values ($1)", [worldId]);

        const charId = randomUUID();
        await c.query("insert into characters (id, world_id, name) values ($1, $2, $3)", [
          charId,
          worldId,
          "Elena",
        ]);

        // ── duplicate character name ────────────────────────────────────────
        const dupe = await mustReject(
          c,
          "insert into characters (world_id, name) values ($1, $2)",
          [worldId, "ELENA"],
        );
        report(
          "character names",
          dupe.length > 0,
          dupe.length > 0 ? "case-insensitively unique per world" : "ACCEPTED a duplicate",
        );

        // ── turn sequencing ─────────────────────────────────────────────────
        const seq0 = await c.query<{ next_turn_seq: number }>("select next_turn_seq($1)", [
          worldId,
        ]);
        await c.query(
          `insert into turns (world_id, seq, speaker, content, world_day)
           values ($1, $2, 'player', $3, 1)`,
          [worldId, seq0.rows[0]?.next_turn_seq ?? 0, "I promised Elena I'd be back by sunset."],
        );
        const seq1 = await c.query<{ next_turn_seq: number }>("select next_turn_seq($1)", [
          worldId,
        ]);
        report(
          "turn seq",
          (seq1.rows[0]?.next_turn_seq ?? -1) === 1,
          `next after first turn = ${String(seq1.rows[0]?.next_turn_seq ?? -1)}`,
        );

        // ── the speaker/character agreement constraint ──────────────────────
        const badSpeaker = await mustReject(
          c,
          `insert into turns (world_id, seq, speaker, character_id, content, world_day)
           values ($1, 99, 'player', $2, 'x', 1)`,
          [worldId, charId],
        );
        report(
          "speaker check",
          badSpeaker.length > 0,
          badSpeaker.length > 0 ? "a player turn cannot carry a character" : "ACCEPTED",
        );

        // ── append-only: turns ──────────────────────────────────────────────
        const turnUpdate = await mustReject(c, "update turns set content = 'edited'");
        report(
          "turns append-only",
          /append-only/.test(turnUpdate),
          turnUpdate.length > 0 ? turnUpdate.split("\n")[0]?.slice(0, 60) ?? "" : "ACCEPTED UPDATE",
        );

        // ── events, with an audience ────────────────────────────────────────
        const eseq = await c.query<{ next_event_seq: number }>("select next_event_seq($1)", [
          worldId,
        ]);
        await c.query(
          `insert into events
             (world_id, world_day, seq, type, actor, target, value,
              known_by, audience, source_turn)
           values ($1, 1, $2, 'promised', 'the user', 'Elena',
                   'be back by sunset', $3, $4, 0)`,
          [worldId, eseq.rows[0]?.next_event_seq ?? 0, ["Elena"], ["the user", "Elena"]],
        );

        const noAudience = await mustReject(
          c,
          `insert into events (world_id, world_day, seq, type, actor, source_turn)
           values ($1, 1, 900, 'observed', 'the user', 0)`,
          [worldId],
        );
        report(
          "audience required",
          noAudience.length > 0,
          noAudience.length > 0
            ? "an event with no computed audience is rejected"
            : "ACCEPTED an event with a null audience",
        );

        // ── the isolation filter itself ─────────────────────────────────────
        const visible = await c.query<{ n: string }>(
          "select count(*) as n from events where world_id = $1 and audience @> array[$2]",
          [worldId, "Bram"],
        );
        report(
          "isolation filter",
          Number(visible.rows[0]?.n ?? "1") === 0,
          "an outsider matches no events",
        );

        // ── append-only: events ─────────────────────────────────────────────
        const eventUpdate = await mustReject(c, "update events set importance = 0.9");
        report(
          "events append-only",
          /append-only/.test(eventUpdate),
          eventUpdate.length > 0 ? eventUpdate.split("\n")[0]?.slice(0, 60) ?? "" : "ACCEPTED UPDATE",
        );

        // ── the source_turn foreign key ─────────────────────────────────────
        const orphan = await mustReject(
          c,
          `insert into events (world_id, world_day, seq, type, actor, audience, source_turn)
           values ($1, 1, 901, 'world_event', 'the sea', '{}', 4242)`,
          [worldId],
        );
        report(
          "event traceability",
          orphan.length > 0,
          orphan.length > 0 ? "an event cannot cite a turn that does not exist" : "ACCEPTED",
        );
      } finally {
        // Always. This check must leave no trace in a real database.
        await c.query("rollback");
      }
    });
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n  ${String(failures.length)} INVARIANT(S) BROKEN\n`);
    process.exitCode = 1;
  } else {
    console.log("\n  every schema invariant holds\n");
  }
}

main().catch((e: unknown) => {
  console.error(`\n  CHECK FAILED\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
