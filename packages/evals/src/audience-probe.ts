/**
 * AUDIENCE PROBE — who does extraction say witnessed a private moment?
 *
 * The Saltmarsh leak came back on run B with `structuralLeak: true`, meaning the
 * cellar event reached Elena's recallable set. The isolation rule did not change
 * between runs, so the extractor must be assigning her the audience.
 *
 * That is a different failure from the first two and a more fundamental one.
 * Failing closed removed the EMPTY-audience hole; it cannot stop a WRONG one.
 * Isolation is only ever as strong as `knownBy`, and `knownBy` comes from a
 * model that has the full cast in its prompt and no notion of who is in the room.
 *
 * Runs the cellar turns repeatedly and prints the audience of every event, so
 * the rate is measured rather than guessed at.
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider, SchedulerRouter } from "@darkforest/ai";
import { audienceFor, canRecall } from "@darkforest/core";
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

  const world = GAUNTLET_WORLDS[0]!;
  const knownEntities = world.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  /** Turns 16-18: down into the cellar, the cold, the sealed door. Elena is absent. */
  const CELLAR_TURN = 18;
  const REPS = Number(process.env["AUDIENCE_REPS"] ?? "4");

  console.log("\n" + "=".repeat(78));
  console.log("AUDIENCE PROBE — the cellar turns, Elena is NOT present");
  console.log("=".repeat(78));
  for (let i = CELLAR_TURN - 2; i <= CELLAR_TURN; i++) {
    console.log(`  turn ${String(i)}: ${world.script[i] ?? ""}`);
  }
  console.log("");

  let elenaReached = 0;
  let total = 0;

  for (let rep = 0; rep < REPS; rep++) {
    await sleep(5000);
    const transcript: Array<{ speaker: string; content: string }> = [];
    for (let i = CELLAR_TURN - 2; i <= CELLAR_TURN; i++) {
      transcript.push({ speaker: "user", content: world.script[i]! });
      transcript.push({ speaker: "Sera", content: "She says nothing." });
    }
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: world.id,
        transcript: transcript.slice(-6),
        worldDay: world.startingDay + Math.floor(CELLAR_TURN / 2),
        knownEntities,
        aggressiveness: 0.6,
        sourceTurn: CELLAR_TURN + 1,
        nextSeq: 0,
      });
      console.log(`  rep ${String(rep + 1)} — ${String(ev.events.length)} event(s)`);
      for (const e of ev.events) {
        total += 1;
        const a = audienceFor(e);
        const reach = a.kind === "public" ? "PUBLIC" : a.who.join(", ");
        const leaks = canRecall(e, "Elena");
        if (leaks) elenaReached += 1;
        console.log(
          `      ${leaks ? "LEAK " : "     "} ${e.type.padEnd(18)} actor=${e.actor.padEnd(10)} ` +
            `target=${(e.target ?? "-").padEnd(8)} knownBy=[${e.knownBy.join(", ")}]`,
        );
        console.log(`             audience -> ${reach}`);
        console.log(`             value: ${(e.value ?? e.object ?? "").slice(0, 66)}`);
      }
    } catch (err) {
      console.log(`  rep ${String(rep + 1)} — call failed: ${err instanceof Error ? err.message.slice(0, 60) : ""}`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log(
    `  events where Elena — absent from every one of these turns — can recall: ` +
      `${String(elenaReached)} of ${String(total)}`,
  );
  console.log(
    elenaReached > 0
      ? "  -> EXTRACTION assigns the audience wrongly. Failing closed cannot fix a\n" +
          "     WRONG knownBy, only an empty one. The audience for a perception must\n" +
          "     not be taken from the model at all."
      : "  -> extraction assigns the audience correctly here; the run-B leak came\n" +
          "     from somewhere else and this probe did not reproduce it.",
  );
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
