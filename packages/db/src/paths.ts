import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved relative to this file, not to `process.cwd()`.
 *
 * The evals runner already lost a run to a cwd assumption — `pnpm --filter`
 * changes the working directory, and a path relative to it read `.env` from the
 * wrong place. Migrations failing that way would be considerably worse than a
 * benchmark failing that way.
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
