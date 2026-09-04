/**
 * SUITE 1 — memory recall. docs/15 § 3.
 *
 *   20 facts · 100 turns · probes at 30/60/100 + a fresh session · 5 repetitions
 *
 * Reports MEDIAN and MINIMUM, not the best run. A median alone hides the case
 * where one run in five falls off a cliff, and that case is what a user
 * actually experiences.
 *
 * The fresh-session probe is the one that matters most for the product thesis:
 * it clears the conversation transcript entirely and asks the character to
 * recall a fact from 100 turns earlier with no recent context to lean on. That
 * is precisely the "I came back a week later and it remembered" moment.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CloudflareEmbeddingProvider, CredentialRegistry, GroqProvider } from "@darkforest/ai";
import { AIError } from "@darkforest/contracts";
import type { EmbeddingProvider, ModelDescriptor, WorldState } from "@darkforest/contracts";
import { COMPACT_PROFILE } from "@darkforest/core";
import { InMemoryMemoryStore, extractMemories, retrieve, __resetMemoryIds } from "@darkforest/memory";
import { renderDialoguePrompt } from "@darkforest/prompts";
import { SUITE1, type Suite1Fact } from "./worlds/suite1.js";

interface ProbeOutcome {
  factId: string;
  checkpoint: string;
  recalled: boolean;
}

interface RunResult {
  run: number;
  probes: ProbeOutcome[];
  recallByCheckpoint: Record<string, { hit: number; total: number }>;
  overallRecall: number;
  memoriesStored: number;
  gateSkipped: number;
  turns: number;
  calls: number;
  failures: number;
  wallClockMs: number;
}

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

function stateFor(day: number): WorldState {
  return {
    worldId: SUITE1.id,
    version: 1n,
    day,
    timeOfDay: "evening",
    currentLocation: SUITE1.location,
    weather: null,
    chapter: 1,
    chapterTitle: null,
    sceneSummary: "",
    flags: {},
    numerics: {},
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

async function runOnce(
  runIndex: number,
  provider: GroqProvider,
  model: ModelDescriptor,
  embedder: EmbeddingProvider,
): Promise<RunResult> {
  __resetMemoryIds();
  const store = new InMemoryMemoryStore();
  const speaker = SUITE1.characters[0]!;
  const transcript: Array<{ speaker: string; content: string }> = [];

  let sinceExtraction = 0;
  let gateSkipped = 0;
  let calls = 0;
  let failures = 0;
  let retried = 0;
  const failureCodes = new Map<string, number>();
  const note = (stage: string, e: unknown): void => {
    const code = e instanceof AIError ? e.code : "UNEXPECTED";
    const key = `${stage}:${code}`;
    failureCodes.set(key, (failureCodes.get(key) ?? 0) + 1);
    if (failureCodes.get(key) === 1 && e instanceof Error) {
      console.log(`
      first ${key}: ${e.message.slice(0, 160)}`);
    }
  };
  const probes: ProbeOutcome[] = [];
  const started = Date.now();

  const knownEntities = SUITE1.characters.map((c) => ({
    ref: `character:${c.id}`,
    name: c.name,
  }));

  /**
   * Asks a probe question and reports whether the fact was RETRIEVED.
   * recall@k is measured against the retrieved set, never the reply text
   * (docs/15 § 3) — otherwise this measures the model's phrasing.
   */
  const probe = async (
    fact: Suite1Fact,
    checkpoint: string,
    recentLines: string[],
    day: number,
  ): Promise<void> => {
    const r = await retrieve(store, embedder, {
      worldId: SUITE1.id,
      characterId: speaker.id,
      userMessage: fact.question,
      recentLines,
      aliases: SUITE1.aliases,
      currentWorldDay: day,
      tokenBudget: COMPACT_PROFILE.memories,
      maxMemories: 8,
    });
    const text = r.memories.map((m) => m.memory.content).join(" ").toLowerCase();
    const recalled = fact.expect.some((n) => text.includes(n.toLowerCase()));
    probes.push({ factId: fact.id, checkpoint, recalled });
  };

  for (let i = 0; i < SUITE1.script.length; i++) {
    // Pace to stay under the pool's per-minute token ceiling. Real users do not
    // send 100 turns in 90 seconds, and sprinting measures the rate limiter
    // rather than the memory system.
    if (i > 0) await sleep(900);

    const userMessage = SUITE1.script[i]!;
    const day = SUITE1.startingDay + Math.floor(i / 2);

    const retrieval = await retrieve(store, embedder, {
      worldId: SUITE1.id,
      characterId: speaker.id,
      userMessage,
      recentLines: transcript.slice(-2).map((t) => t.content),
      aliases: SUITE1.aliases,
      currentWorldDay: day,
      tokenBudget: COMPACT_PROFILE.memories,
      maxMemories: 6,
    });

    const prompt = renderDialoguePrompt({
      profile: "compact",
      world: {
        name: SUITE1.name,
        genre: [...SUITE1.genre],
        tone: SUITE1.tone,
        perspective: "second",
      },
      rules: SUITE1.rules,
      character: speaker,
      memories: retrieval.memories.map((m) => ({
        worldDay: m.memory.worldDay,
        content: m.memory.content,
        certainty: 1,
      })),
      relationships: [],
      state: stateFor(day),
      presentCharacterNames: SUITE1.characters.map((c) => c.name),
      visibleNumerics: [],
      priorSpeakers: [],
    });

    let reply = "";
    for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await provider.generate(
        {
          taskClass: "dialogue",
          system: prompt.system,
          messages: [{ role: "user", content: userMessage }],
          maxTokens: 200,
          temperature: 0.8,
          timeoutMs: 30_000,
          meta: { requestId: `s1-${String(runIndex)}-${String(i)}`, worldId: SUITE1.id },
        },
        model,
      );
      reply = res.text;
      calls += 1;
      break;
    } catch (e) {
      /*
       * BUDGET_EXCEEDED is OUR OWN pool applying backpressure, not a provider
       * failure — every credential is momentarily over its per-minute token
       * ceiling. Treating it as fatal is what made runs 3-5 score 0%: the
       * runner gave up while the pool was simply asking it to wait.
       *
       * In production this path is a queued job, so waiting is exactly right.
       */
      const backpressure =
        e instanceof AIError && (e.code === "RATE_LIMITED" || e.code === "BUDGET_EXCEEDED");
      if (backpressure && attempt < 2) {
        retried += 1;
        await sleep(4000 * (attempt + 1));
        continue;
      }
      failures += 1;
      note("dialogue", e);
      if (!(e instanceof AIError)) throw e;
      break;
    }
    }

    transcript.push({ speaker: "user", content: userMessage });
    transcript.push({ speaker: speaker.name, content: reply });

    /*
     * Extraction RETRIES on rate limit — because in production it is a
     * background job with backoff (ADR-005, the jobs table), not a fire-and-
     * forget call.
     *
     * The first suite-1 run did not retry, and 21 of its failures were 429s
     * from the eval firing 100 turns in 90 seconds. Every throttled extraction
     * on a fact-bearing turn loses that fact permanently, so recall measured
     * 58-65% — a number about the rate limiter, not about memory. Modelling the
     * job queue removes that confound.
     */
    sinceExtraction += 1;
    let extracted = false;
    for (let attempt = 0; attempt < 4 && !extracted; attempt++) {
      try {
        const out = await extractMemories(store, provider, model, embedder, {
          worldId: SUITE1.id,
          transcript: transcript.slice(-6),
          worldDay: day,
          knownEntities,
          aggressiveness: 0.5,
          turnsSinceLastExtraction: sinceExtraction,
        });
        calls += out.usage.calls;
        if (out.skipped) gateSkipped += 1;
        else sinceExtraction = 0;
        extracted = true;
      } catch (e) {
        const backpressure =
          e instanceof AIError && (e.code === "RATE_LIMITED" || e.code === "BUDGET_EXCEEDED");
        if (backpressure) {
          retried += 1;
          await sleep(4000 * (attempt + 1));
          continue;
        }
        failures += 1;
        note("extract", e);
        if (!(e instanceof AIError)) throw e;
        break;
      }
    }
    if (!extracted) {
      failures += 1;
      failureCodes.set("extract:EXHAUSTED", (failureCodes.get("extract:EXHAUSTED") ?? 0) + 1);
    }

    // ── checkpoint probes ───────────────────────────────────────────────────
    const turnNumber = i + 1;
    if (SUITE1.checkpoints.includes(turnNumber as 30 | 60 | 100)) {
      const recent = transcript.slice(-2).map((t) => t.content);
      for (const fact of SUITE1.facts) {
        if (fact.probeAt.includes(turnNumber as 30 | 60 | 100)) {
          await probe(fact, String(turnNumber), recent, day);
        }
      }
      process.stdout.write(`    turn ${String(turnNumber)} probed  `);
    }
  }

  // ── fresh session: no transcript at all ───────────────────────────────────
  for (const fact of SUITE1.facts) {
    if (fact.probeAt.includes("fresh")) {
      await probe(fact, "fresh", [], SUITE1.startingDay + 60);
    }
  }
  process.stdout.write("fresh probed\n");

  const byCheckpoint: Record<string, { hit: number; total: number }> = {};
  for (const p of probes) {
    const b = (byCheckpoint[p.checkpoint] ??= { hit: 0, total: 0 });
    b.total += 1;
    if (p.recalled) b.hit += 1;
  }

  const hits = probes.filter((p) => p.recalled).length;

  if (retried > 0) console.log(`      rate-limit retries: ${String(retried)}`);
  if (failureCodes.size > 0) {
    console.log(`      failures: ${[...failureCodes].map(([k, n]) => `${k}×${String(n)}`).join(", ")}`);
  }

  return {
    run: runIndex,
    probes,
    recallByCheckpoint: byCheckpoint,
    overallRecall: probes.length === 0 ? 0 : hits / probes.length,
    memoriesStored: (await store.allByWorld(SUITE1.id)).length,
    gateSkipped,
    turns: SUITE1.script.length,
    calls,
    failures,
    wallClockMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);

  const provider = new GroqProvider({
    getCredential: (est) => {
      const g = registry.acquire("groq", est);
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

  const embedder = new CloudflareEmbeddingProvider({
    accountId: env["CF_ACCOUNT_ID"] ?? "",
    getToken: () => {
      const g = registry.acquire("cloudflare", 0);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
    onSuccess: (id, t) => {
      registry.reportSuccess(id, t);
    },
  });

  const model = provider.models.find((m) => m.tier === "fast") ?? provider.models[0]!;
  const reps = Number(process.env["SUITE1_REPS"] ?? "5");

  console.log("\n" + "═".repeat(72));
  console.log("SUITE 1 — memory recall");
  console.log("═".repeat(72));
  console.log(`facts ${String(SUITE1.facts.length)} · turns ${String(SUITE1.script.length)} · checkpoints 30/60/100 + fresh · reps ${String(reps)}`);
  console.log(`model ${model.id} · embeddings ${embedder.id}\n`);

  /*
   * Results are written to disk after EVERY repetition, not at the end.
   *
   * A previous run was killed mid-flight and produced nothing at all — 20
   * minutes of real API calls with no record. docs/15 § 7 asks for dated JSON
   * so trends survive; this also means an interrupted run still yields whatever
   * repetitions completed.
   */
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = "docs/benchmarks/runs";
  mkdirSync(outDir, { recursive: true });
  const outFile = `${outDir}/${stamp}-suite1.json`;

  const results: RunResult[] = [];
  for (let r = 1; r <= reps; r++) {
    process.stdout.write(`  run ${String(r)}/${String(reps)}  `);
    results.push(await runOnce(r, provider, model, embedder));
    const last = results[results.length - 1]!;
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          suite: "suite1",
          date: stamp,
          model: model.id,
          embedder: embedder.id,
          facts: SUITE1.facts.length,
          turns: SUITE1.script.length,
          completedReps: results.length,
          plannedReps: reps,
          runs: results.map((x) => ({
            run: x.run,
            recall: x.overallRecall,
            byCheckpoint: x.recallByCheckpoint,
            memoriesStored: x.memoriesStored,
            gateSkipped: x.gateSkipped,
            calls: x.calls,
            failures: x.failures,
            wallClockMs: x.wallClockMs,
            probes: x.probes,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(
      `    → recall ${(last.overallRecall * 100).toFixed(0)}%  ` +
        `memories ${String(last.memoriesStored)}  gate-skipped ${String(last.gateSkipped)}/${String(last.turns)}  ` +
        `${(last.wallClockMs / 1000).toFixed(0)}s`,
    );
  }

  // ── report ────────────────────────────────────────────────────────────────
  const recalls = results.map((r) => r.overallRecall * 100);
  const med = median(recalls);
  const min = Math.min(...recalls);
  const max = Math.max(...recalls);

  console.log("\n" + "─".repeat(72));
  console.log("RECALL BY CHECKPOINT (median across runs)");
  for (const cp of ["30", "60", "100", "fresh"]) {
    const rates = results
      .map((r) => r.recallByCheckpoint[cp])
      .filter((b): b is { hit: number; total: number } => b !== undefined)
      .map((b) => (b.total === 0 ? 0 : (b.hit / b.total) * 100));
    if (rates.length === 0) continue;
    const label = cp === "fresh" ? "fresh session" : `turn ${cp}`;
    console.log(`  ${label.padEnd(14)} ${median(rates).toFixed(0)}%   (min ${Math.min(...rates).toFixed(0)}%)`);
  }

  console.log("\n" + "─".repeat(72));
  console.log("PER-FACT RECALL — which facts are actually failing");
  const factHits = new Map<string, { hit: number; total: number; kind: string; q: string }>();
  for (const r of results) {
    for (const p of r.probes) {
      const fact = SUITE1.facts.find((f) => f.id === p.factId);
      if (!fact) continue;
      const e = factHits.get(p.factId) ?? { hit: 0, total: 0, kind: fact.kind, q: fact.question };
      e.total += 1;
      if (p.recalled) e.hit += 1;
      factHits.set(p.factId, e);
    }
  }
  const sorted = [...factHits.entries()].sort((a, b) => a[1].hit / a[1].total - b[1].hit / b[1].total);
  for (const [id, e] of sorted) {
    const rate = (e.hit / e.total) * 100;
    const mark = rate >= 80 ? " " : rate >= 40 ? "~" : "✗";
    console.log(`  ${mark} ${id} ${e.kind.padEnd(14)} ${rate.toFixed(0).padStart(3)}%  ${e.q}`);
  }

  console.log("\n" + "═".repeat(72));
  console.log(`recall@k   median ${med.toFixed(0)}%   min ${min.toFixed(0)}%   max ${max.toFixed(0)}%`);
  console.log(`runs       ${recalls.map((x) => `${x.toFixed(0)}%`).join("  ")}`);
  const pass = med >= 85 && min >= 85;
  console.log(
    `\nPHASE 1 GATE (median ≥85% AND min ≥85%):  ${pass ? "PASS" : "FAIL"}` +
      (med >= 85 && min < 85 ? "   — median clears, floor does not" : ""),
  );
  console.log("═".repeat(72));

  const totalCalls = results.reduce((n, r) => n + r.calls, 0);
  const totalTurns = results.reduce((n, r) => n + r.turns, 0);
  const totalSkipped = results.reduce((n, r) => n + r.gateSkipped, 0);
  const totalFailures = results.reduce((n, r) => n + r.failures, 0);
  console.log(`\ncalls/turn ${(totalCalls / totalTurns).toFixed(2)}   gate skipped ${((totalSkipped / totalTurns) * 100).toFixed(0)}%   failures ${String(totalFailures)}`);
  for (const s of registry.snapshotAll()) {
    console.log(`${s.providerId.padEnd(12)} ${String(s.available)}/${String(s.total)} available, headroom ${(s.aggregateHeadroom * 100).toFixed(1)}%`);
  }
  console.log();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
