import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";

/**
 * THE MIGRATION RUNNER — forward-only, one transaction per migration.
 *
 * Three properties, each chosen because its absence is a specific failure:
 *
 *  1. EACH MIGRATION IS ONE TRANSACTION. A migration that fails halfway leaves
 *     the schema in a state no file describes, and the next run then fails on
 *     something that already exists. Postgres has transactional DDL; using it is
 *     free and the alternative is a manual repair at the worst possible moment.
 *
 *  2. APPLIED MIGRATIONS ARE CHECKSUMMED. Editing a file that has already run is
 *     the single most common way a schema diverges between two machines: it
 *     works locally because you also dropped the database, and staging silently
 *     keeps the old shape forever. The checksum turns that into a loud error.
 *
 *  3. AN ADVISORY LOCK GUARDS THE RUN. Two deploys starting at once otherwise
 *     both see "0002 not applied" and both try to create the same table.
 *
 * Forward-only is deliberate: there are no `down` migrations. A down migration
 * is written when the schema is understood and run when it is not, and the
 * honest recovery from a bad migration is another migration.
 */

/** Namespaced so it cannot collide with an application advisory lock. */
const MIGRATION_LOCK_KEY = 0x44_46_4d_49; // "DFMI"

export interface Migration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * Migrations in lexical order, which is numeric order because the prefix is
 * zero-padded. The name is validated rather than trusted: `10_foo.sql` would
 * sort before `2_foo.sql` and run the schema out of order, and that is a bug
 * that appears months later on a clean database and nowhere else.
 */
export function loadMigrations(dir: string): Migration[] {
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql"));
  const seen = new Set<string>();
  const out: Migration[] = [];

  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const m = FILENAME.exec(name);
    if (!m?.[1]) {
      throw new Error(`migration filename must be NNNN_lower_snake.sql: ${name}`);
    }
    if (seen.has(m[1])) throw new Error(`duplicate migration number: ${name}`);
    seen.add(m[1]);

    const sql = readFileSync(join(dir, name), "utf8");
    out.push({
      id: name.replace(/\.sql$/, ""),
      sql,
      // Normalised so a checkout with CRLF line endings does not read as a
      // tampered migration on Windows. This repo is developed on Windows.
      checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"),
    });
  }
  return out;
}

const LEDGER = `
  create table if not exists schema_migrations (
    id          text        primary key,
    checksum    text        not null,
    applied_at  timestamptz not null default now()
  )
`;

/**
 * Applies every migration not yet recorded.
 *
 * The caller supplies a client that is already connected as a role able to
 * create objects — migrations are the one place the service role is correct
 * (ADR-030), and that is why this takes a client rather than opening its own.
 */
export async function migrate(
  client: PoolClient,
  migrations: readonly Migration[],
  log: (line: string) => void = () => undefined,
): Promise<MigrationResult> {
  await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await client.query(LEDGER);

    const { rows } = await client.query<{ id: string; checksum: string }>(
      "select id, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.id, r.checksum]));

    const didApply: string[] = [];
    const skipped: string[] = [];

    for (const m of migrations) {
      const existing = applied.get(m.id);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new Error(
            `migration ${m.id} was edited after it ran.\n` +
              `  recorded ${existing.slice(0, 12)}\n  on disk  ${m.checksum.slice(0, 12)}\n` +
              `Write a new migration instead; editing an applied one diverges every ` +
              `database that already ran it.`,
          );
        }
        skipped.push(m.id);
        continue;
      }

      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (id, checksum) values ($1, $2)", [
          m.id,
          m.checksum,
        ]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${m.id} failed: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        });
      }
      didApply.push(m.id);
      log(`  applied  ${m.id}`);
    }

    return { applied: didApply, skipped };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
}
