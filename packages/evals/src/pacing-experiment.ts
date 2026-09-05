/**
 * PACED vs CONTENDED — is extraction failure a load artefact?
 *
 * Two runs of the SAME extraction workload. Identical model set, prompts,
 * fixture, schema, evaluator, turn count and retry behaviour. The ONLY
 * difference is the delay between turns.
 *
 * WHY
 * The extraction diagnosis produced 17% malformed output: bare `[]`, empty
 * strings, a stray "User Safety: safe", and two reasoning preambles that blew
 * the token budget. Two hypotheses were tested and both refuted — JSON mode made
 * output worse, and Groq already separates reasoning from content. Against the
 * raw API, the exact filler turn that produced `""` under load returns a clean
 * {"events":[]}.
 *
 * What remains is that those shapes appeared only under sustained pressure, and
 * that the probe run itself hit a 429 after six calls. If malformed output is a
 * load artefact then it is a capacity problem wearing an extraction problem's
 * clothes, and "fixing" extraction would have papered over it.
 *
 * PREDICTION, recorded before running so it cannot be adjusted afterwards:
 *   if load-driven   -> anomalies fall sharply when paced, fact capture rises
 *   if model-driven  -> anomaly rate is roughly equal in both conditions
 *
 * The second outcome is the informative one. It would mean the extractor is
 * simply unreliable at this rate and no amount of scheduling fixes it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import type { WorldEvent } from "@darkforest/contracts";
import { extractEvents } from "@darkforest/memory";
import {
  capturesFact,
  extractionHealth,
  factCaptureRate,
  type AttemptOutcome,
} from "./contract/evaluation-contract.js";
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
 * The two conditions.
 *
 * CONTENDED reproduces the spacing that produced the failures. PACED is slow
 * enough that a single extraction bucket cannot approach its 8000 TPM ceiling:
 * at roughly 1300 tokens per call and 15 calls per minute spread over 16
 * gpt-oss buckets, no bucket sees more than about 1,300 TPM.
 */
const CONDITIONS = [
  { name: "CONTENDED", delayMs: 1200 },
  { name: "PACED", delayMs: 4000 },
] as const;

/** Shapes seen in the failing run, counted by name rather than lumped together. */
function classifyAnomaly(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return "empty string";
  if (t === "[]") return "bare array";
  if (t === "{}") return "bare object";
  if (/^user safety:/i.test(t)) return "safety verdict";
  if (/thinking process|^we need/i.test(t)) return "reasoning preamble";
  return null;
}

interface ConditionResult {
  name: string;
  delayMs: number;
  outcomes: AttemptOutcome[];
  anomalies: Map<string, number>;
  factsCaptured: number;
  factsTotal: number;
  events: number;
  reroutes: number;
  wallClockS: number;
  tokensPerMinute: number;
}

async function runCondition(
  router: SchedulerRouter,
  name: string,
  delayMs: number,
): Promise<ConditionResult> {
  const knownEntities = SUITE1.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  const factTurns = new Map(SUITE1.facts.map((f) => [f.plantedAt, f]));
  const transcript: Array<{ speaker: string; content: string }> = [];
  const events: WorldEvent[] = [];
  const outcomes: AttemptOutcome[] = [];
  const anomalies = new Map<string, number>();
  const factResults: Array<{ factId: string; captured: boolean }> = [];
  const rerouteBefore = router.attempts.filter((a) => a.status !== "ok").length;

  let seq = 0;
  let totalTokens = 0;
  const started = Date.now();
  process.stdout.write(`  ${name.padEnd(10)} `);

  for (let i = 0; i < SUITE1.script.length; i++) {
    if (i > 0) await sleep(delayMs);
    const day = SUITE1.startingDay + Math.floor(i / 2);
    router.currentTurn = i + 1;
    transcript.push({ speaker: "user", content: SUITE1.script[i]! });
    transcript.push({ speaker: SUITE1.characters[0]!.name, content: ACK });

    let produced: WorldEvent[] = [];
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: SUITE1.id,
        transcript: transcript.slice(-6),
        worldDay: day,
        knownEntities,
        aggressiveness: 0.5,
        sourceTurn: i + 1,
        nextSeq: seq,
      });
      outcomes.push(ev.outcome);
      produced = ev.events;
      events.push(...ev.events);
      seq += ev.events.length;
      totalTokens += ev.usage.inputTokens + ev.usage.outputTokens;
      if (ev.debug !== undefined) {
        const kind = classifyAnomaly(ev.debug.rawOutput);
        if (kind !== null) anomalies.set(kind, (anomalies.get(kind) ?? 0) + 1);
        else anomalies.set("other malformed", (anomalies.get("other malformed") ?? 0) + 1);
      }
    } catch {
      outcomes.push("call_failed");
    }

    const fact = factTurns.get(i);
    if (fact !== undefined) {
      const captured = capturesFact(produced, {
        id: fact.id,
        plantedAt: fact.plantedAt,
        kind: fact.kind,
        expect: fact.expect,
      });
      factResults.push({ factId: fact.id, captured });
      process.stdout.write(captured ? "+" : "!");
    } else {
      const last = outcomes[outcomes.length - 1];
      process.stdout.write(last === "empty_valid" ? "." : last === "accepted" ? "o" : "x");
    }
  }

  const wallClockS = (Date.now() - started) / 1000;
  const capture = factCaptureRate(factResults);
  console.log("");
  return {
    name,
    delayMs,
    outcomes,
    anomalies,
    factsCaptured: capture.captured,
    factsTotal: capture.total,
    events: events.length,
    reroutes: router.attempts.filter((a) => a.status !== "ok").length - rerouteBefore,
    wallClockS,
    tokensPerMinute: totalTokens / (wallClockS / 60),
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

  console.log("\n" + "=".repeat(76));
  console.log("PACED vs CONTENDED — only the spacing differs");
  console.log("=".repeat(76));
  console.log("  legend  + fact captured   ! MISSED   . correctly empty   o event   x failure\n");

  const results: ConditionResult[] = [];
  for (const c of CONDITIONS) {
    results.push(await runCondition(router, c.name, c.delayMs));
    // Let every bucket's minute window roll before the next condition, so the
    // second condition does not inherit the first one's exhaustion.
    if (c !== CONDITIONS[CONDITIONS.length - 1]) {
      console.log("  [cooldown] 90s for rate windows to reset");
      await sleep(90_000);
    }
  }

  console.log("\n" + "-".repeat(76));
  console.log(
    `${"CONDITION".padEnd(12)}${"delay".padStart(7)}${"health".padStart(9)}${"format fail".padStart(13)}` +
      `${"capture".padStart(10)}${"events".padStart(8)}${"reroutes".padStart(10)}${"tok/min".padStart(9)}`,
  );
  for (const r of results) {
    const h = extractionHealth(r.outcomes);
    const cells = [
      r.name.padEnd(12),
      `${String(r.delayMs)}ms`.padStart(7),
      `${h.health.toFixed(0)}%`.padStart(9),
      `${h.formatFailureRate.toFixed(0)}%`.padStart(13),
      `${String(r.factsCaptured)}/${String(r.factsTotal)}`.padStart(10),
      String(r.events).padStart(8),
      String(r.reroutes).padStart(10),
      r.tokensPerMinute.toFixed(0).padStart(9),
    ];
    console.log(cells.join(""));
  }

  console.log("\nANOMALOUS OUTPUT SHAPES");
  const kinds = new Set(results.flatMap((r) => [...r.anomalies.keys()]));
  if (kinds.size === 0) console.log("  none in either condition");
  for (const kind of kinds) {
    console.log(
      `  ${kind.padEnd(20)} ` +
        results.map((r) => `${r.name} ${String(r.anomalies.get(kind) ?? 0)}`).join("   "),
    );
  }

  // ── verdict against the prediction recorded in the header ────────────────
  const contended = results.find((r) => r.name === "CONTENDED");
  const paced = results.find((r) => r.name === "PACED");
  console.log("\n" + "=".repeat(76));
  if (contended !== undefined && paced !== undefined) {
    const cf = extractionHealth(contended.outcomes).formatFailureRate;
    const pf = extractionHealth(paced.outcomes).formatFailureRate;
    const drop = cf - pf;
    console.log(
      `  format failures  CONTENDED ${cf.toFixed(0)}%   PACED ${pf.toFixed(0)}%   ` +
        `delta ${drop.toFixed(0)} pts`,
    );
    console.log(
      drop >= 8
        ? "  -> LOAD-DRIVEN. Malformed output is a capacity artefact, not an extraction\n" +
            "     defect. Fix the scheduler's pressure on a bucket, not the prompt."
        : Math.abs(drop) < 4
          ? "  -> MODEL-DRIVEN. Pacing changed nothing: the extractor is simply this\n" +
            "     reliable at this prompt. Scheduling cannot fix it."
          : "  -> INCONCLUSIVE at this sample size. Neither hypothesis is carried.",
    );
  }
  console.log("=".repeat(76) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-pacing.json`,
    JSON.stringify(
      results.map((r) => ({ ...r, anomalies: [...r.anomalies], outcomes: r.outcomes })),
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
