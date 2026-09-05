/**
 * EVENT EXTRACTION DIAGNOSIS.
 *
 * "15% validity" was not enough information, and the metric that produced it was
 * wrong for the third time — it scored a correct empty extraction on a filler
 * turn as a failure, so perfect extraction could not have exceeded about 20%.
 *
 * This measures the thing that actually matters instead:
 *
 *     of the 20 planted facts, how many became a correct event?
 *
 * and reports a full outcome taxonomy per attempt. It runs event extraction
 * ALONE — no dialogue call, no prose extraction, no gate — which isolates it
 * from the A/B harness's contention. The A/B ran extraction twice per turn and
 * generated constant rate-limit reroutes, so the open question is whether we
 * measured a model weakness or a starved extractor. Running it alone answers
 * that: this is the CEILING for extraction, unstarved.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import type { WorldEvent } from "@darkforest/contracts";
import { project } from "@darkforest/core";
import { extractEvents, type ExtractionOutcomeKind } from "@darkforest/memory";
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

/**
 * A neutral acknowledgement in place of a real reply.
 *
 * Deliberate: the fact lives in the USER turn in this fixture, so a generated
 * reply would add cost and variance without adding anything to extract. It also
 * keeps the run reproducible.
 */
const ACK = "She listens, and says nothing for a moment.";

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

  console.log("\n" + "=".repeat(74));
  console.log("EVENT EXTRACTION DIAGNOSIS — extraction alone, no contention");
  console.log("=".repeat(74));

  const knownEntities = SUITE1.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  const factTurns = new Map(SUITE1.facts.map((f) => [f.plantedAt, f]));

  const events: WorldEvent[] = [];
  const outcomes = new Map<ExtractionOutcomeKind, number>();
  const rejectionReasons = new Map<string, number>();
  let callFailures = 0;
  let seq = 0;
  let calls = 0;
  const transcript: Array<{ speaker: string; content: string }> = [];
  /** Per fact-bearing turn: what the extraction did with it. */
  const factOutcomes: Array<{ factId: string; turn: number; outcome: string; captured: boolean }> = [];

  const started = Date.now();
  for (let i = 0; i < SUITE1.script.length; i++) {
    if (i > 0) await sleep(1200);
    const userMessage = SUITE1.script[i]!;
    const day = SUITE1.startingDay + Math.floor(i / 2);
    const turnNumber = i + 1;
    router.currentTurn = turnNumber;

    transcript.push({ speaker: "user", content: userMessage });
    transcript.push({ speaker: SUITE1.characters[0]!.name, content: ACK });

    let outcome: ExtractionOutcomeKind | "call_failed" = "call_failed";
    let produced: WorldEvent[] = [];
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: SUITE1.id,
        transcript: transcript.slice(-6),
        worldDay: day,
        knownEntities,
        aggressiveness: 0.5,
        sourceTurn: turnNumber,
        nextSeq: seq,
      });
      calls += ev.usage.calls;
      outcome = ev.outcome;
      produced = ev.events;
      events.push(...ev.events);
      seq += ev.events.length;
      for (const r of ev.rejected) {
        rejectionReasons.set(r.reason, (rejectionReasons.get(r.reason) ?? 0) + 1);
      }
    } catch {
      callFailures += 1;
    }
    outcomes.set(
      outcome as ExtractionOutcomeKind,
      (outcomes.get(outcome as ExtractionOutcomeKind) ?? 0) + 1,
    );

    // Fact-bearing turns are the only ones whose success is knowable.
    const fact = factTurns.get(i);
    if (fact !== undefined) {
      // `quantity` belongs here. Leaving it out marked f14 as MISSED when the
      // event was perfect — {numeric_stated, "guards at the keep", quantity: 9}
      // — because "9" lived in a number field the matcher never read. Fourth
      // time a metric in this area has under-reported a working system; the
      // matcher must see every field an expectation could land in.
      const blob = produced
        .map(
          (e) =>
            `${e.type} ${e.actor} ${e.target ?? ""} ${e.object ?? ""} ${e.value ?? ""} ` +
            (e.quantity === null ? "" : String(e.quantity)),
        )
        .join(" ")
        .toLowerCase();
      const captured = fact.expect.some((n) => blob.includes(n.toLowerCase()));
      factOutcomes.push({ factId: fact.id, turn: turnNumber, outcome, captured });
      process.stdout.write(captured ? "+" : "!");
    } else {
      process.stdout.write(outcome === "empty_valid" ? "." : outcome === "accepted" ? "o" : "x");
    }
  }
  console.log(`\n\n  legend  + fact captured   ! fact MISSED   . correctly empty   o extra event   x failure`);
  console.log(`  ${String(calls)} calls, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  // ── outcome taxonomy ──────────────────────────────────────────────────────
  const total = SUITE1.script.length;
  console.log("-".repeat(74));
  console.log("OUTCOME PER ATTEMPT");
  const LABEL: Record<string, string> = {
    accepted: "accepted        events stored",
    empty_valid: "empty (correct) nothing durable in the turn",
    truncated: "truncated       ran out of tokens mid-JSON",
    unparseable: "unparseable     output was not JSON",
    schema: "schema          JSON but wrong shape",
    all_rejected: "all rejected    proposed events failed validation",
    call_failed: "call failed     provider or rate limit",
  };
  for (const [k, v] of [...outcomes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${String(v).padStart(3)}  ${((v / total) * 100).toFixed(0).padStart(3)}%  ${LABEL[k] ?? k}`,
    );
  }
  if (callFailures > 0) console.log(`  ${String(callFailures).padStart(3)}         call failures`);
  if (rejectionReasons.size > 0) {
    console.log(
      `\n  rejection reasons: ${[...rejectionReasons.entries()].map(([k, v]) => `${k} ${String(v)}`).join(", ")}`,
    );
  }

  // ── the number that matters ───────────────────────────────────────────────
  const captured = factOutcomes.filter((f) => f.captured).length;
  console.log("\n" + "-".repeat(74));
  console.log("FACT CAPTURE — the metric that actually means something");
  console.log(
    `  ${String(captured)} of ${String(factOutcomes.length)} planted facts became a correct event  ` +
      `(${((captured / Math.max(1, factOutcomes.length)) * 100).toFixed(0)}%)`,
  );
  const missed = factOutcomes.filter((f) => !f.captured);
  if (missed.length > 0) {
    console.log("\n  MISSED");
    for (const m of missed) {
      const fact = SUITE1.facts.find((f) => f.id === m.factId);
      console.log(
        `    ${m.factId}  turn ${String(m.turn).padStart(3)}  ${m.outcome.padEnd(13)} ${fact?.kind ?? ""}`,
      );
      console.log(`         "${SUITE1.script[m.turn - 1] ?? ""}"`);
    }
  }

  // ── what the projections ended up holding ─────────────────────────────────
  const p = project(events);
  console.log("\n" + "-".repeat(74));
  console.log("PROJECTIONS BUILT");
  console.log(`  events        ${String(events.length)}`);
  console.log(`  ownership     ${String(p.ownership.size)}`);
  console.log(`  commitments   ${String(p.commitments.length)}`);
  console.log(`  questions     ${String(p.questions.length)}`);
  console.log(`  relations     ${String(p.relations.size)}`);
  console.log(`  persona       ${String(p.persona.length)}`);
  console.log(`  numerics      ${String(p.numerics.size)}`);
  console.log(`  disclosures   ${String(p.disclosures.length)}`);
  console.log(`  world events  ${String(p.worldEvents.length)}`);

  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(
    `\n  event types: ${[...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ")}`,
  );

  console.log("\n" + "=".repeat(74) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-event-diag.json`,
    JSON.stringify(
      { outcomes: [...outcomes], rejections: [...rejectionReasons], factOutcomes, events },
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
