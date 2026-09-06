/**
 * GAP PROBE — the three turns that never extract.
 *
 * Three traced gauntlet runs put every structural miss at one stage and one
 * stage only: EXTRACTION. Nine misses, three probes, each 0/3.
 *
 *   A-state-ring    turn 44  "Bram sells the silver ring on to a factor from Wexley."
 *   B-temporal      turn 20  "Ilse and I argue about something small and neither of us apologises."
 *   B-longhorizon   turn  1  "I meet Ilse on the stair and we talk longer than either of us meant to."
 *
 * Reading them, they look like three DIFFERENT gaps rather than one:
 *
 *   a transaction between two people the player is not part of, where the
 *   recipient is a stranger and not in the cast;
 *
 *   a mutual argument with no actor, no target and no object;
 *
 *   a meeting whose durable detail is the PLACE, for which no event type asks.
 *
 * The suspect was our own code: `validate` drops a target the world does not
 * know, then rejects `gave` with a null target as an impossible transition, so a
 * sale to an unnamed stranger would have been discarded by us rather than missed
 * by the model.
 *
 * REFUTED. rejected=0 on every attempt — we discard nothing, the model proposes
 * nothing:
 *
 *   A-state-ring    proposed 0, 0, 0
 *   B-temporal      proposed 0, 0, 1  (and the 1 was a different event entirely)
 *   B-longhorizon   captured 1 of 3   (marginal rather than a hard gap)
 *
 * The distinction this probe exists to make — did the model fail to propose it,
 * or did WE throw away something correct — is one the gauntlet's single "0/3"
 * could not express, and it took a third refuted hypothesis to notice that.
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider, SchedulerRouter } from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";
import { GAUNTLET_WORLDS } from "./worlds/gauntlet.js";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { id: "A-state-ring", world: 0, turn: 44, expect: ["Wexley", "factor", "sold"] },
  { id: "B-temporal", world: 1, turn: 20, expect: ["argue", "small", "apolog"] },
  { id: "B-longhorizon", world: 1, turn: 1, expect: ["stair"] },
] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);
  const groq = new GroqProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("groq", est, Date.now(), modelId);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
    onSuccess: (id, t) => {
      registry.reportSuccess(id, t);
    },
    onRateLimited: (id, ms) => {
      registry.reportRateLimited(id, ms);
    },
  });
  const openrouter = new OpenRouterProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("openrouter", est, Date.now(), modelId);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
    onSuccess: (id, t) => {
      registry.reportSuccess(id, t);
    },
  });
  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouter.models.filter((m) => m.tier === "fast") },
    sleep,
    // Benchmark fixtures, on a development machine. All three are false in the
    // product; see SchedulerRouterConfig.content.
    content: { pool: "development", environment: "local", isSyntheticContent: true },
  });

  const REPS = Number(process.env["GAP_REPS"] ?? "3");
  console.log("\n" + "=".repeat(78));
  console.log("GAP PROBE — the three turns that never extract");
  console.log("=".repeat(78));

  for (const c of CASES) {
    const world = GAUNTLET_WORLDS[c.world]!;
    const knownEntities = world.characters.map((x) => ({ ref: `character:${x.id}`, name: x.name }));
    console.log(`\n${c.id}  turn ${String(c.turn)}`);
    console.log(`  "${world.script[c.turn] ?? ""}"`);
    console.log(`  cast: ${world.characters.map((x) => x.name).join(", ")}`);

    let accepted = 0;
    let rejected = 0;
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(5000);
      const transcript: Array<{ speaker: string; content: string }> = [];
      for (let i = Math.max(0, c.turn - 2); i <= c.turn; i++) {
        transcript.push({ speaker: "user", content: world.script[i]! });
        transcript.push({ speaker: world.characters[0]!.name, content: "A pause." });
      }
      try {
        const ev = await extractEvents(router, router.models[0]!, {
          worldId: world.id,
          transcript: transcript.slice(-6),
          worldDay: world.startingDay + Math.floor(c.turn / 2),
          knownEntities,
          aggressiveness: 0.6,
          sourceTurn: c.turn + 1,
          nextSeq: 0,
        });
        accepted += ev.events.length;
        rejected += ev.rejected.length;
        const hit = ev.events.some((e) =>
          c.expect.some((t) =>
            `${e.type} ${e.actor} ${e.target ?? ""} ${e.object ?? ""} ${e.value ?? ""} ${e.location ?? ""}`
              .toLowerCase()
              .includes(t.toLowerCase()),
          ),
        );
        console.log(
          `    rep ${String(rep + 1)}  proposed=${String(ev.proposed)} accepted=${String(ev.events.length)} ` +
            `rejected=${String(ev.rejected.length)} ${hit ? "CAPTURED" : "missed"}`,
        );
        for (const e of ev.events) {
          console.log(
            `        ok  ${e.type.padEnd(18)} actor=${e.actor} target=${e.target ?? "-"} ` +
              `object=${e.object ?? "-"} loc=${e.location ?? "-"}`,
          );
          console.log(`            value: ${(e.value ?? "").slice(0, 62)}`);
        }
        // The distinction the gauntlet's 0/3 could not make: did the model fail
        // to propose it, or did WE throw away something it proposed correctly?
        for (const r of ev.rejected) {
          console.log(`        REJECTED BY US  ${r.reason}: ${r.detail}`);
        }
      } catch {
        console.log(`    rep ${String(rep + 1)}  call failed`);
      }
    }
    console.log(`    -> accepted ${String(accepted)}, rejected by our validation ${String(rejected)}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log("  A rejection line means the model proposed something and WE discarded it.");
  console.log("  No proposals at all means the ontology has no shape for the sentence.");
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
