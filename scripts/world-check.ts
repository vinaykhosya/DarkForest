import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProposedEvent } from "@darkforest/contracts";
import {
  appendEvents,
  appendTurn,
  asSystem,
  createPool,
  projectFor,
  recallableEvents,
  recentTurns,
} from "@darkforest/db";

/**
 * `pnpm db:world` — V1-T11.
 *
 * The event layer, round-tripped through Postgres: a turn is appended, events
 * are read from it, `audienceFor` decides who may recall each one, and the
 * projection is folded from what came back.
 *
 * The case that matters is the Saltmarsh leak, reproduced as a fixture. The
 * extractor named Elena as a witness to something she never saw, and for four
 * runs a character described a cellar door she had never been shown. The rule
 * that fixed it — perception is the observer's alone — has to survive the trip
 * through SQL, or the fix only ever existed in TypeScript.
 *
 * Everything runs in a transaction that is always rolled back.
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
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failures.push(name);
}

const PLAYER = "the user";

function proposed(p: Partial<ProposedEvent> & { type: ProposedEvent["type"]; actor: string }): ProposedEvent {
  return {
    target: null,
    object: null,
    value: null,
    quantity: null,
    location: null,
    participants: [],
    visibility: "world",
    knownBy: [],
    importance: 0.5,
    causedBy: null,
    ...p,
  };
}

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url =
    env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"] ?? "";
  if (url.length === 0) throw new Error("no database url");

  const pool = createPool({ url, max: 1 });
  try {
    await asSystem(pool, "world repo round trip", async (c) => {
      await c.query("begin");
      try {
        const ownerId = randomUUID();
        const worldId = randomUUID();
        await c.query(
          `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
           values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,now(),now())`,
          [ownerId, `world-${ownerId.slice(0, 8)}@example.invalid`],
        );
        await c.query("insert into worlds (id, owner_id, name) values ($1,$2,'Saltmarsh')", [
          worldId,
          ownerId,
        ]);
        await c.query("insert into world_state (world_id) values ($1)", [worldId]);
        const elenaId = randomUUID();
        await c.query("insert into characters (id, world_id, name) values ($1,$2,'Elena')", [
          elenaId,
          worldId,
        ]);
        await c.query("insert into characters (world_id, name) values ($1,'Bram')", [worldId]);

        // ── a turn, and the events read from it ────────────────────────────
        const t0 = await appendTurn(c, {
          worldId,
          speaker: "player",
          content: "I went down to the cellar and saw a sealed door behind the racks.",
          worldDay: 1,
        });
        report("turn seq starts at 0", t0.seq === 0, `seq=${String(t0.seq)}`);

        const events = await appendEvents(
          c,
          worldId,
          [
            /*
             * THE LEAK FIXTURE. `knownBy` names Elena, who was not there — this
             * is what the extractor actually emitted in the Saltmarsh run.
             */
            proposed({
              type: "observed",
              actor: PLAYER,
              value: "a sealed door behind the racks at the back of the cellar",
              knownBy: [PLAYER, "Elena"],
              location: "the cellar",
              importance: 0.8,
            }),
            proposed({
              type: "promised",
              actor: PLAYER,
              target: "Elena",
              value: "be back before sunset",
              knownBy: [PLAYER, "Elena"],
              importance: 0.7,
            }),
          ],
          t0.seq,
          1,
        );
        report("events stored", events.length === 2, `${String(events.length)} events`);
        report(
          "event seq is per world",
          events[0]?.seq === 0 && events[1]?.seq === 1,
          `${String(events[0]?.seq)}, ${String(events[1]?.seq)}`,
        );

        // ── isolation, through SQL ─────────────────────────────────────────
        const playerSees = await recallableEvents(c, worldId, PLAYER);
        report("the observer recalls their observation", playerSees.length === 2, `${String(playerSees.length)} events`);

        const elenaSees = await recallableEvents(c, worldId, "Elena");
        const elenaTypes = elenaSees.map((e) => e.type).join(",");
        report(
          "Elena does NOT recall the door she never saw",
          !elenaSees.some((e) => e.type === "observed"),
          `sees: ${elenaTypes.length > 0 ? elenaTypes : "nothing"}`,
        );
        report(
          "Elena DOES recall the promise made to her",
          elenaSees.some((e) => e.type === "promised"),
          `${String(elenaSees.length)} event(s)`,
        );

        const bramSees = await recallableEvents(c, worldId, "Bram");
        report("an uninvolved character recalls nothing", bramSees.length === 0, `${String(bramSees.length)} events`);

        report(
          "audience matching is case-insensitive",
          (await recallableEvents(c, worldId, "elena")).length === elenaSees.length,
          "lowercase matches",
        );

        // ── the projection, folded from what each may recall ───────────────
        const elenaView = await projectFor(c, worldId, "Elena");
        const open = elenaView.commitments.filter((x) => x.status === "open");
        report(
          "Elena's projection holds the open promise",
          open.length === 1 && open[0]?.what === "be back before sunset",
          open[0]?.what ?? "none",
        );
        report(
          "Elena's projection has no observation",
          elenaView.observations.length === 0,
          `${String(elenaView.observations.length)} observations`,
        );

        const playerView = await projectFor(c, worldId, PLAYER);
        report(
          "the player's projection HAS the observation",
          playerView.observations.length === 1,
          playerView.observations[0]?.what ?? "none",
        );

        // ── a superseding event changes what is true, without an UPDATE ────
        const t1 = await appendTurn(c, {
          worldId,
          speaker: "player",
          content: "I made it back to Elena before the sun went down.",
          worldDay: 1,
        });
        await appendEvents(
          c,
          worldId,
          [
            proposed({
              type: "fulfilled",
              actor: PLAYER,
              target: "Elena",
              value: "be back before sunset",
              knownBy: [PLAYER, "Elena"],
            }),
          ],
          t1.seq,
          1,
        );
        const after = await projectFor(c, worldId, "Elena");
        report(
          "the promise closes by APPENDING, never by editing",
          after.commitments.filter((x) => x.status === "open").length === 0,
          `${String(after.commitments.length)} commitment(s), none open`,
        );

        const turns = await recentTurns(c, worldId, 10);
        report(
          "the transcript reads oldest-first",
          turns.length === 2 && turns[0]?.seq === 0,
          `${String(turns.length)} turns`,
        );
      } finally {
        await c.query("rollback");
      }
    });
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error(`\n  ${String(failures.length)} FAILED\n`);
    process.exitCode = 1;
  } else {
    console.log("\n  the event layer round-trips, and the leak stays fixed in SQL\n");
  }
}

main().catch((e: unknown) => {
  console.error(`\n  WORLD CHECK FAILED\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
