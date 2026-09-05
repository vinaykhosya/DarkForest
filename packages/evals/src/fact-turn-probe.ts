/**
 * FACT-TURN PROBE — why does extraction return `[]` on a turn that carries a fact?
 *
 * The pacing experiment split the malformed output into two populations. The
 * pathological shapes are load-driven and nearly vanish when paced:
 *
 *   empty string  8 -> 1     safety verdict     3 -> 0
 *   reasoning     2 -> 0     other malformed    3 -> 0
 *
 * But `[]` moved the OTHER way, 12 -> 19, and it is the largest category. So it
 * is not the same phenomenon, and "malformed output is a capacity artefact" is
 * false as a blanket claim. `[]` is the model saying "nothing durable here" in
 * the wrong envelope. The open question is whether it is RIGHT.
 *
 * This runs only the 20 fact-bearing turns, one at a time, heavily paced. The
 * window each turn had in the full run is reconstructed exactly - the script is
 * fixed and the acknowledgement is constant - so the INPUT is identical and only
 * the pressure differs.
 *
 *   still returns []  ->  selectivity: the prompt's notion of "durable" is wrong
 *   returns the event ->  load artefact after all, and pacing understated it
 *
 * Two repetitions, because a single sample cannot separate a stable judgement
 * from a coin flip.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";
import { capturesFact } from "./contract/evaluation-contract.js";
import { SchedulerRouter } from "./scheduler-router.js";
import { SUITE1 } from "./worlds/suite1.js";

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
const ACK = "She listens, and says nothing for a moment.";

/**
 * The exact six-turn window this turn saw in the full run.
 *
 * Reproducible because the script is fixed and the acknowledgement is constant.
 * Rebuilding it matters: extracting from the bare turn would change the input
 * and the comparison would no longer be about pressure.
 */
function windowFor(turnIndex: number): Array<{ speaker: string; content: string }> {
  const speaker = SUITE1.characters[0]!.name;
  const out: Array<{ speaker: string; content: string }> = [];
  for (let i = Math.max(0, turnIndex - 2); i <= turnIndex; i++) {
    out.push({ speaker: "user", content: SUITE1.script[i]! });
    out.push({ speaker, content: ACK });
  }
  return out.slice(-6);
}

function shapeOf(raw: string): string {
  const t = raw.trim();
  if (t === "") return "empty string";
  if (t === "[]") return "bare array";
  if (t === "{}") return "bare object";
  if (/^user safety:/i.test(t)) return "safety verdict";
  if (/thinking process|^we need/i.test(t)) return "reasoning preamble";
  return "other";
}

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
    onRejected: (id, r) => {
      registry.reportRejected(id, r);
    },
    onFailure: (id) => {
      registry.reportFailure(id);
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
    onRateLimited: (id, ms) => {
      registry.reportRateLimited(id, ms);
    },
  });
  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouter.models.filter((m) => m.tier === "fast") },
    sleep,
  });

  const knownEntities = SUITE1.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  const REPS = Number(process.env["PROBE_REPS"] ?? "2");
  const DELAY = 6000;

  console.log("\n" + "=".repeat(78));
  console.log("FACT-TURN PROBE — 20 fact-bearing turns, one at a time, unpressured");
  console.log("=".repeat(78));
  console.log(`  ${String(REPS)} reps, ${String(DELAY)}ms apart, windows reconstructed from the run\n`);

  const results = new Map<string, { captured: number; shapes: string[]; kind: string; line: string }>();

  for (let rep = 0; rep < REPS; rep++) {
    for (const fact of SUITE1.facts) {
      await sleep(DELAY);
      const day = SUITE1.startingDay + Math.floor(fact.plantedAt / 2);
      router.currentTurn = fact.plantedAt + 1;
      const entry = results.get(fact.id) ?? {
        captured: 0,
        shapes: [],
        kind: fact.kind,
        line: SUITE1.script[fact.plantedAt] ?? "",
      };
      try {
        const ev = await extractEvents(router, router.models[0]!, {
          worldId: SUITE1.id,
          transcript: windowFor(fact.plantedAt),
          worldDay: day,
          knownEntities,
          aggressiveness: 0.5,
          sourceTurn: fact.plantedAt + 1,
          nextSeq: 0,
        });
        const captured = capturesFact(ev.events, {
          id: fact.id,
          plantedAt: fact.plantedAt,
          kind: fact.kind,
          expect: fact.expect,
        });
        if (captured) entry.captured += 1;
        entry.shapes.push(
          captured
            ? "captured"
            : ev.debug !== undefined
              ? shapeOf(ev.debug.rawOutput)
              : ev.outcome === "empty_valid"
                ? "declined {events:[]}"
                : ev.outcome,
        );
        process.stdout.write(captured ? "+" : "!");
      } catch {
        entry.shapes.push("call failed");
        process.stdout.write("x");
      }
      results.set(fact.id, entry);
    }
    process.stdout.write(` rep ${String(rep + 1)}\n`);
  }

  console.log("\n" + "-".repeat(78));
  console.log("PER FACT — unpressured");
  const missed: string[] = [];
  for (const fact of SUITE1.facts) {
    const r = results.get(fact.id);
    if (r === undefined) continue;
    const rate = (r.captured / REPS) * 100;
    const mark = rate === 100 ? " " : rate > 0 ? "~" : "X";
    console.log(
      `  ${mark} ${fact.id} ${r.kind.padEnd(14)} ${rate.toFixed(0).padStart(3)}%  ${r.shapes.join(", ")}`,
    );
    if (rate < 100) missed.push(fact.id);
  }

  const total = SUITE1.facts.length * REPS;
  const capturedTotal = [...results.values()].reduce((a, r) => a + r.captured, 0);
  console.log(
    `\n  captured ${String(capturedTotal)}/${String(total)} (${((capturedTotal / total) * 100).toFixed(0)}%) with no load`,
  );

  // The verdict this probe exists to reach.
  const declined = [...results.values()].flatMap((r) => r.shapes).filter((s) => s.includes("declined") || s === "bare array").length;
  const pathological = [...results.values()]
    .flatMap((r) => r.shapes)
    .filter((s) => ["empty string", "safety verdict", "reasoning preamble", "bare object", "other"].includes(s)).length;

  console.log("\n" + "=".repeat(78));
  console.log(`  declined a fact-bearing turn   ${String(declined)}`);
  console.log(`  pathological output            ${String(pathological)}`);
  console.log(
    declined > pathological
      ? "  -> SELECTIVITY. Unpressured, the model still declines these turns. The\n" +
          "     prompt's notion of what is durable does not match the product's."
      : pathological > declined
        ? "  -> STILL LOAD. Pathological shapes persist even here, so this run was\n" +
          "     not the clean condition it was meant to be."
        : "  -> MIXED. Neither population dominates; do not carry either hypothesis.",
  );
  if (missed.length > 0) console.log(`  facts not captured every time: ${missed.join(", ")}`);
  console.log("=".repeat(78) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-fact-turns.json`,
    JSON.stringify([...results.entries()].map(([id, r]) => ({ id, ...r })), null, 2),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
