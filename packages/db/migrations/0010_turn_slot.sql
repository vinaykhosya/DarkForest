/*
 * ONE TURN AT A TIME, PER WORLD.
 *
 * `runTurn` commits the player's turn, calls the model for several seconds, and
 * then commits the reply and its events. Nothing between those two transactions
 * stopped a SECOND turn starting, and two turns in flight interleave: two player
 * lines, then two replies, each generated without the other's question. The
 * transcript is the ground truth every projection folds from, so an interleaved
 * one is not a display glitch — it is a corrupted record.
 *
 * Reachable without trying: two browser tabs, or a double-submit.
 *
 * WHY A COLUMN AND NOT AN ADVISORY LOCK. `pg_try_advisory_xact_lock` releases at
 * commit, so it cannot span the gap where the model call happens — which is the
 * whole window that needs protecting. A session-level advisory lock could, but
 * it must be released on the SAME connection, and the turn deliberately returns
 * its connection to the pool while waiting on the model. A column is the only
 * mechanism whose lifetime matches the thing being guarded.
 *
 * WHY A TIMESTAMP AND NOT A BOOLEAN. A process that dies mid-generation would
 * leave a boolean set forever and the world permanently unusable, recoverable
 * only by hand. A timestamp expires: the claim is honoured for two minutes,
 * comfortably longer than the 30-second generation timeout, and then anyone may
 * take it. The failure mode of the guard is "the world unsticks itself".
 */

alter table world_state
  add column if not exists generating_since timestamptz;

comment on column world_state.generating_since is
  'Set while a turn is generating. Claimed and released by runTurn; expires after two minutes so a crash cannot wedge a world.';
