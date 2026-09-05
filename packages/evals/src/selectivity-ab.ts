/**
 * SELECTIVITY A/B — v1 "durable fact" versus v2 "consequence test".
 *
 * Same 20 fact-bearing turns, same 20 filler turns, same reconstructed windows,
 * same model, same pacing. Only the selection prompt differs.
 *
 * WHY BOTH POPULATIONS. Broadening selection is the easy way to fix recall and
 * the easy way to ruin the product. An extractor told to save everything turns
 * memory into a second transcript, drowns retrieval in trivia and exhausts
 * free-tier storage. So filler turns are run too, and a v2 that captures more
 * facts while ALSO firing on uneventful turns is a failure, not a win.
 *
 * The verdict therefore needs both to move the right way:
 *
 *   capture UP and filler firing FLAT or DOWN   -> adopt
 *   capture UP and filler firing UP             -> traded precision for recall
 *   capture FLAT                                -> the prompt was not the cause
 *
 * Pacing is 6s throughout, since the fact-turn probe showed pathological output
 * is load-driven and would otherwise contaminate the comparison.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";
import { capturesFact, extractionHealth, type AttemptOutcome } from "./contract/evaluation-contract.js";
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
const DELAY = 6000;

function windowFor(turnIndex: number): Array<{ speaker: string; content: string }> {
  const speaker = SUITE1.characters[0]!.name;
  const out: Array<{ speaker: string; content: string }> = [];
  for (let i = Math.max(0, turnIndex - 2); i <= turnIndex; i++) {
    out.push({ speaker: "user", content: SUITE1.script[i]! });
    out.push({ speaker, content: ACK });
  }
  return out.slice(-6);
}

/** Filler turns, spread across the script and none of them fact-bearing. */
function fillerTurns(count: number): number[] {
  const planted = new Set(SUITE1.facts.map((f) => f.plantedAt));
  const out: number[] = [];
  for (let i = 0; i < SUITE1.script.length && out.length < count; i += 1) {
    // Skip a turn adjacent to a planted one: its window carries that fact, so
    // an event there would be correct rather than a false positive.
    const near = planted.has(i) || planted.has(i - 1) || planted.has(i - 2);
    if (!near) out.push(i);
  }
  const step = Math.max(1, Math.floor(out.length / count));
  return out.filter((_, idx) => idx % step === 0).slice(0, count);
}

interface VariantResult {
  variant: "v1" | "v2";
  factsCaptured: number;
  factsTotal: number;
  perFact: Map<string, number>;
  fillerFired: number;
  fillerTotal: number;
  fillerEvents: number;
  outcomes: AttemptOutcome[];
  eventTypes: Map<string, number>;
}

async function runVariant(
  router: SchedulerRouter,
  variant: "v1" | "v2",
  filler: number[],
): Promise<VariantResult> {
  const knownEntities = SUITE1.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  const perFact = new Map<string, number>();
  const outcomes: AttemptOutcome[] = [];
  const eventTypes = new Map<string, number>();
  let factsCaptured = 0;
  let fillerFired = 0;
  let fillerEvents = 0;

  process.stdout.write(`  ${variant}  facts `);
  for (const fact of SUITE1.facts) {
    await sleep(DELAY);
    router.currentTurn = fact.plantedAt + 1;
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: SUITE1.id,
        transcript: windowFor(fact.plantedAt),
        worldDay: SUITE1.startingDay + Math.floor(fact.plantedAt / 2),
        knownEntities,
        aggressiveness: 0.5,
        sourceTurn: fact.plantedAt + 1,
        nextSeq: 0,
        promptVariant: variant,
      });
      outcomes.push(ev.outcome);
      for (const e of ev.events) eventTypes.set(e.type, (eventTypes.get(e.type) ?? 0) + 1);
      const got = capturesFact(ev.events, {
        id: fact.id,
        plantedAt: fact.plantedAt,
        kind: fact.kind,
        expect: fact.expect,
      });
      if (got) factsCaptured += 1;
      perFact.set(fact.id, got ? 1 : 0);
      process.stdout.write(got ? "+" : "!");
    } catch {
      outcomes.push("call_failed");
      perFact.set(fact.id, 0);
      process.stdout.write("x");
    }
  }

  process.stdout.write("  filler ");
  for (const turn of filler) {
    await sleep(DELAY);
    router.currentTurn = turn + 1;
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: SUITE1.id,
        transcript: windowFor(turn),
        worldDay: SUITE1.startingDay + Math.floor(turn / 2),
        knownEntities,
        aggressiveness: 0.5,
        sourceTurn: turn + 1,
        nextSeq: 0,
        promptVariant: variant,
      });
      outcomes.push(ev.outcome);
      if (ev.events.length > 0) {
        fillerFired += 1;
        fillerEvents += ev.events.length;
        for (const e of ev.events) eventTypes.set(e.type, (eventTypes.get(e.type) ?? 0) + 1);
      }
      process.stdout.write(ev.events.length > 0 ? "o" : ".");
    } catch {
      outcomes.push("call_failed");
      process.stdout.write("x");
    }
  }
  console.log("");

  return {
    variant,
    factsCaptured,
    factsTotal: SUITE1.facts.length,
    perFact,
    fillerFired,
    fillerTotal: filler.length,
    fillerEvents,
    outcomes,
    eventTypes,
  };
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

  const filler = fillerTurns(20);
  console.log("\n" + "=".repeat(78));
  console.log("SELECTIVITY A/B — v1 durable-fact vs v2 consequence test");
  console.log("=".repeat(78));
  console.log(
    `  ${String(SUITE1.facts.length)} fact turns + ${String(filler.length)} filler turns per variant, ` +
      `${String(DELAY)}ms apart\n  legend  + captured  ! missed  . filler quiet  o filler FIRED\n`,
  );

  const results: VariantResult[] = [];
  for (const variant of ["v1", "v2"] as const) {
    results.push(await runVariant(router, variant, filler));
    if (variant === "v1") await sleep(30_000);
  }

  console.log("-".repeat(78));
  console.log(
    `${"VARIANT".padEnd(9)}${"capture".padStart(10)}${"filler fired".padStart(15)}` +
      `${"filler events".padStart(15)}${"health".padStart(9)}`,
  );
  for (const r of results) {
    const h = extractionHealth(r.outcomes);
    console.log(
      [
        r.variant.padEnd(9),
        `${String(r.factsCaptured)}/${String(r.factsTotal)}`.padStart(10),
        `${String(r.fillerFired)}/${String(r.fillerTotal)}`.padStart(15),
        String(r.fillerEvents).padStart(15),
        `${h.health.toFixed(0)}%`.padStart(9),
      ].join(""),
    );
  }

  // The three v1 declined unpressured. They are the reason v2 exists.
  console.log("\nTHE FACTS v2 WAS WRITTEN FOR");
  for (const id of ["f12", "f13", "f15"]) {
    const fact = SUITE1.facts.find((f) => f.id === id);
    const cells = results.map((r) => `${r.variant} ${r.perFact.get(id) === 1 ? "captured" : "MISSED"}`);
    console.log(`  ${id} ${(fact?.kind ?? "").padEnd(14)} ${cells.join("   ")}`);
    console.log(`      "${SUITE1.script[fact?.plantedAt ?? 0] ?? ""}"`);
  }

  const regressions = SUITE1.facts.filter(
    (f) => results[0]?.perFact.get(f.id) === 1 && results[1]?.perFact.get(f.id) === 0,
  );
  console.log(
    `\n  facts v1 caught and v2 lost: ${regressions.length === 0 ? "none" : regressions.map((f) => f.id).join(", ")}`,
  );

  console.log("\nEVENT TYPES EMITTED");
  const allTypes = new Set(results.flatMap((r) => [...r.eventTypes.keys()]));
  for (const t of [...allTypes].sort()) {
    console.log(
      `  ${t.padEnd(20)} ` + results.map((r) => `${r.variant} ${String(r.eventTypes.get(t) ?? 0)}`).join("   "),
    );
  }

  // ── verdict against the criteria in the header ──────────────────────────
  const [v1, v2] = results;
  console.log("\n" + "=".repeat(78));
  if (v1 !== undefined && v2 !== undefined) {
    const captureGain = v2.factsCaptured - v1.factsCaptured;
    const fillerGain = v2.fillerFired - v1.fillerFired;
    console.log(
      `  capture ${captureGain >= 0 ? "+" : ""}${String(captureGain)} facts   ` +
        `filler firing ${fillerGain >= 0 ? "+" : ""}${String(fillerGain)} turns`,
    );
    console.log(
      captureGain >= 2 && fillerGain <= 1
        ? "  -> ADOPT v2. More of what matters, without turning memory into a transcript."
        : captureGain >= 2
          ? "  -> TRADED PRECISION FOR RECALL. v2 captures more but fires on quiet turns;\n" +
            "     that is a worse product, not a better one."
          : captureGain <= 0
            ? "  -> NO GAIN. Selection was not the cause; do not adopt v2."
            : "  -> MARGINAL at this sample size. One repetition cannot carry this.",
    );
  }
  console.log("=".repeat(78) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-selectivity.json`,
    JSON.stringify(
      results.map((r) => ({ ...r, perFact: [...r.perFact], eventTypes: [...r.eventTypes] })),
      null,
      2,
    ),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
