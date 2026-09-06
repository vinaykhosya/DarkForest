/**
 * AGENCY EXPERIMENT — the last extraction experiment before the freeze.
 *
 * The context ladder placed the blind spot: sentences where the user is the
 * agent of an explicit act extract reliably; sentences where the user witnesses
 * or receives do not, even handed to the model alone. f12 and f19 are the same
 * event type on the same machinery, and one never captures while the other
 * always does.
 *
 * This tests that on thirty-two sentences the extractor has never seen, with a
 * cast that shares no name with Suite 1, balanced across four agency shapes plus
 * filler. Nothing tells the model which shape a sentence is.
 *
 * THE DECISION THIS FEEDS
 * Not "can we reach 100%". The question is whether the event ontology handles
 * what happens AROUND the player as well as what the player does, because a
 * world that only remembers the player's own actions is not a persistent world.
 *
 *   every category healthy, filler quiet  -> good enough; freeze and build
 *   one category collapses               -> fix the ontology once, re-run, freeze
 *
 * Deliberately NOT another prompt rewrite. v2 already established that
 * broadening the wording narrows the result.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider, SchedulerRouter } from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";
import { capturesFact } from "./contract/evaluation-contract.js";
import { AGENCY_CASES, AGENCY_ENTITIES, type AgencyCase } from "./worlds/agency.js";

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
const DELAY = 5500;
const ACK = "Sera says nothing, and the room is quiet.";
const WORLD = "agency-probe";

interface CaseResult {
  id: string;
  category: AgencyCase["category"];
  text: string;
  captured: number;
  fired: number;
  reps: number;
  /** What it emitted, so a miss can be read rather than guessed at. */
  emitted: string[];
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
    // Benchmark fixtures, on a development machine. All three are false in the
    // product; see SchedulerRouterConfig.content.
    content: { pool: "development", environment: "local", isSyntheticContent: true },
  });

  const knownEntities = AGENCY_ENTITIES.map((n, i) => ({ ref: `character:a${String(i)}`, name: n }));
  const REPS = Number(process.env["AGENCY_REPS"] ?? "2");

  console.log("\n" + "=".repeat(80));
  console.log("AGENCY EXPERIMENT — 32 unseen sentences, four agency shapes");
  console.log("=".repeat(80));
  console.log(
    `  ${String(AGENCY_CASES.length)} cases x ${String(REPS)} reps, ${String(DELAY)}ms apart\n` +
      `  legend  + captured   ! missed   . filler quiet   o filler FIRED\n`,
  );

  const results: CaseResult[] = [];
  for (const c of AGENCY_CASES) {
    const r: CaseResult = {
      id: c.id,
      category: c.category,
      text: c.text,
      captured: 0,
      fired: 0,
      reps: REPS,
      emitted: [],
    };
    process.stdout.write(`  ${c.id.padEnd(3)} ${c.category.padEnd(11)} `);
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(DELAY);
      router.currentTurn = rep;
      try {
        const ev = await extractEvents(router, router.models[0]!, {
          worldId: WORLD,
          transcript: [
            { speaker: "user", content: c.text },
            { speaker: "Sera", content: ACK },
          ],
          worldDay: 4,
          knownEntities,
          aggressiveness: 0.5,
          sourceTurn: rep,
          nextSeq: 0,
        });
        if (ev.events.length > 0) r.fired += 1;
        for (const e of ev.events) {
          r.emitted.push(`${e.type}:${(e.value ?? e.object ?? "").slice(0, 40)}`);
        }
        if (c.category === "filler") {
          process.stdout.write(ev.events.length > 0 ? "o" : ".");
        } else {
          const got = capturesFact(ev.events, {
            id: c.id,
            plantedAt: 0,
            kind: c.category,
            expect: c.expect,
          });
          if (got) r.captured += 1;
          process.stdout.write(got ? "+" : "!");
        }
      } catch {
        process.stdout.write("x");
      }
    }
    console.log(`  ${c.text.slice(0, 46)}`);
    results.push(r);
  }

  // ── by category ───────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(80));
  console.log(`${"CATEGORY".padEnd(14)}${"capture".padStart(10)}${"fired".padStart(10)}   what it means`);
  const MEANING: Record<string, string> = {
    user: "the user acts",
    other: "someone else acts",
    world: "the world acts, no actor",
    perception: "the user witnesses",
    filler: "nothing happened (any firing is a false positive)",
  };
  const byCategory = new Map<string, { cap: number; total: number; fired: number }>();
  for (const r of results) {
    const e = byCategory.get(r.category) ?? { cap: 0, total: 0, fired: 0 };
    e.cap += r.captured;
    e.total += r.reps;
    e.fired += r.fired;
    byCategory.set(r.category, e);
  }
  for (const cat of ["user", "other", "world", "perception", "filler"] as const) {
    const e = byCategory.get(cat);
    if (e === undefined) continue;
    const capture = cat === "filler" ? "-" : `${((e.cap / e.total) * 100).toFixed(0)}%`;
    console.log(
      cat.padEnd(14) +
        capture.padStart(10) +
        `${((e.fired / e.total) * 100).toFixed(0)}%`.padStart(10) +
        `   ${MEANING[cat] ?? ""}`,
    );
  }

  // ── misses, with what was emitted instead ────────────────────────────────
  const misses = results.filter((r) => r.category !== "filler" && r.captured < r.reps);
  if (misses.length > 0) {
    console.log("\nMISSED OR UNRELIABLE");
    for (const m of misses) {
      console.log(
        `  ${m.id} ${m.category.padEnd(11)} ${String(m.captured)}/${String(m.reps)}  "${m.text}"`,
      );
      console.log(`       emitted: ${m.emitted.length === 0 ? "(nothing)" : m.emitted.join(" | ")}`);
    }
  }
  const falsePositives = results.filter((r) => r.category === "filler" && r.fired > 0);
  if (falsePositives.length > 0) {
    console.log("\nFALSE POSITIVES ON FILLER");
    for (const f of falsePositives) {
      console.log(`  ${f.id} ${String(f.fired)}/${String(f.reps)}  "${f.text}"`);
      console.log(`       emitted: ${f.emitted.join(" | ")}`);
    }
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  const rate = (cat: string): number => {
    const e = byCategory.get(cat);
    return e === undefined || e.total === 0 ? 0 : (e.cap / e.total) * 100;
  };
  const fillerRate = (() => {
    const e = byCategory.get("filler");
    return e === undefined || e.total === 0 ? 0 : (e.fired / e.total) * 100;
  })();
  const signal = ["user", "other", "world", "perception"].map(rate);
  const worst = Math.min(...signal);
  const spread = Math.max(...signal) - worst;

  console.log("\n" + "=".repeat(80));
  console.log(
    `  weakest category ${worst.toFixed(0)}%   spread ${spread.toFixed(0)} pts   ` +
      `filler firing ${fillerRate.toFixed(0)}%`,
  );
  console.log(
    worst >= 75 && fillerRate <= 15
      ? "  -> GOOD ENOUGH. The ontology handles what happens around the player as\n" +
          "     well as what the player does. Freeze the contracts and build."
      : spread >= 40
        ? "  -> AGENCY BLIND SPOT CONFIRMED. One shape collapses while others hold.\n" +
          "     Fix the ontology once, re-run this, then freeze."
        : fillerRate > 15
          ? "  -> PRECISION PROBLEM. It fires on turns where nothing happened, which\n" +
            "     fills memory with weather. Fix before freezing."
          : "  -> UNIFORMLY WEAK. Not an agency problem; extraction is mediocre\n" +
            "     everywhere and the cause is elsewhere.",
  );
  console.log("=".repeat(80) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-agency.json`,
    JSON.stringify({ reps: REPS, byCategory: [...byCategory], results }, null, 2),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
