import { Pool, type PoolClient } from "pg";

/**
 * The connection type callers work with.
 *
 * Re-exported so that nothing outside this package imports `pg` directly — the
 * same boundary rule the AI providers follow (CLAUDE.md § 5: no vendor SDK
 * outside its adapter). It also means swapping the driver is one package's
 * problem rather than a repository-wide edit.
 */
export type DbClient = PoolClient;
export type DbPool = Pool;

/**
 * THE CONNECTION BOUNDARY — where ADR-030 is enforced or quietly lost.
 *
 * RLS is the backstop for every ownership rule in this schema, and a connection
 * made as `postgres` or `service_role` bypasses all of it. Not with an error:
 * silently. The policies still exist, the CI check still finds them, the
 * negative tests still pass against raw SQL, and in production not one policy
 * ever runs. That is why there are exactly two ways to get a client here, they
 * are named for what they are, and the system one is the awkward one to type.
 */

export interface DbConfig {
  readonly url: string;
  /** Supabase requires TLS; `sslmode=require` in the URL is not honoured by node-postgres. */
  readonly ssl?: boolean;
  readonly max?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export function createPool(cfg: DbConfig): Pool {
  return new Pool({
    connectionString: cfg.url,
    // Supabase terminates TLS with a certificate chain node does not have a root
    // for by default. Verification is enabled properly in deployment via the
    // pooler's CA; `false` here would be a silent downgrade, so it is explicit.
    ssl: cfg.ssl === false ? undefined : { rejectUnauthorized: false },
    max: cfg.max ?? 10,
    connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 10_000,
    // CLAUDE.md § 6: every async operation has a timeout. A query with none can
    // hold a pooled connection until the process dies.
    statement_timeout: cfg.statementTimeoutMs ?? 15_000,
  });
}

/**
 * Runs `fn` inside a transaction that the database sees as THIS USER.
 *
 * Every route serving a user request goes through here. Two details carry the
 * whole guarantee:
 *
 *   `set local role authenticated` — drops the superuser-ish login role, so RLS
 *   is actually evaluated. Without it the policies are decoration.
 *
 *   `set_config(..., true)` — the `true` means LOCAL, scoped to this
 *   transaction. With `false` the claims would persist on the pooled connection
 *   and the NEXT request to borrow it would run as the previous user. That is a
 *   cross-account data leak produced by a single boolean, and it is the reason
 *   this helper exists instead of a note telling callers to remember.
 */
export async function asUser<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    // The claims go in as JSON built here, never as caller-supplied text, but a
    // shape check costs nothing and this value decides what rows are visible.
    throw new Error("asUser requires a uuid");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* the connection is already broken; the pool discards it below */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` with RLS BYPASSED, as the system.
 *
 * Legitimate uses: migrations, and background jobs that genuinely act for no
 * user. `reason` is required and logged so that every bypass is visible in one
 * grep rather than discovered during an incident.
 */
export async function asSystem<T>(
  pool: Pool,
  reason: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (reason.trim().length === 0) throw new Error("asSystem requires a reason");
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
