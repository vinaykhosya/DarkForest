import { readFileSync } from "node:fs";
import { MIGRATIONS_DIR, asSystem, createPool, loadMigrations, migrate } from "@darkforest/db";

/**
 * `pnpm db:migrate` — V1-T01.
 *
 * CONNECTION CHOICE, which cost an hour to establish and is worth writing down.
 *
 * Supabase's direct endpoint (`db.<ref>.supabase.co`) is IPv6-ONLY. It resolves
 * to a AAAA record and nothing else, so on any IPv4-only network — this
 * development machine included — it times out rather than refusing, which reads
 * exactly like a firewall or a wrong password.
 *
 * The IPv4 path is the pooler. It has two ports and only one of them can run
 * migrations:
 *
 *   5432  SESSION mode   — a real backend session. Advisory locks and
 *                          transactional DDL both work. This is the one.
 *   6543  TRANSACTION mode — connections are multiplexed per statement, so
 *                          `pg_advisory_lock` is taken and released on different
 *                          backends and guards nothing at all. Silently.
 *
 * The pooler is also region-pinned and the hostname does not contain the project
 * ref, so a wrong region answers with "Tenant or user not found" — which reads
 * like bad credentials. This project is ap-northeast-2.
 *
 * Order: the session pooler if configured, then the direct URL (correct where
 * IPv6 works, such as in deployment), then a local database.
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

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url =
    env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error(
      "need SUPABASE_SESSION_POOLER_URL (port 5432), SUPABASE_DB_URL or DATABASE_URL",
    );
  }
  if (/:6543\//.test(url)) {
    throw new Error(
      "port 6543 is the TRANSACTION pooler: advisory locks do not hold across " +
        "statements there, so two concurrent runs would both migrate. Use 5432.",
    );
  }

  const migrations = loadMigrations(MIGRATIONS_DIR);
  // Host only — a connection string carries the password.
  const host = /@([^/:]+)/.exec(url)?.[1] ?? "unknown";
  console.log(`\n  ${String(migrations.length)} migrations · ${host}\n`);

  const pool = createPool({ url, statementTimeoutMs: 120_000 });
  try {
    const result = await asSystem(pool, "schema migration (ADR-030)", (client) =>
      migrate(client, migrations, (l) => {
        console.log(l);
      }),
    );
    if (result.applied.length === 0) {
      console.log(`  nothing to apply · ${String(result.skipped.length)} already applied\n`);
    } else {
      console.log(
        `\n  ${String(result.applied.length)} applied · ` +
          `${String(result.skipped.length)} already applied\n`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\n  MIGRATION FAILED\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
