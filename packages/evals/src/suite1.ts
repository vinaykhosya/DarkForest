/**
 * SUITE 1 — memory recall. docs/15 § 3.
 *
 *   20 facts · 100 turns · probes at 30/60/100 + a fresh session · 3 repetitions
 *
 * Reports MEDIAN and MINIMUM, not the best run. A median alone hides the case
 * where one run in three falls off a cliff, and that case is what a user
 * actually experiences.
 *
 * P1-T24: Multi-provider candidate pools with explicit fallback tracking and
 * granular telemetry. Distinguishes RATE_LIMITED, BUDGET_EXCEEDED,
 * NO_CREDENTIAL, and PROVIDER_ERROR.
 *
 * P1-T25 (ADR-021): routing goes through the CAPACITY SCHEDULER rather than a
 * Groq-primary/OpenRouter-fallback chain. The previous wiring pinned one Groq
 * model for every call and acquired credentials without naming it, so it used 8
 * of Groq's 32 buckets and mis-attributed the ones it used. Runs were partly
 * measuring the rate limiter: run 3 scored 70% against 91% and 84% with six
 * rate-limit retries and Groq down to 2/8 credentials.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CloudflareEmbeddingProvider,
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
} from "@darkforest/ai";
import { AIError } from "@darkforest/contracts";
import type { EmbeddingProvider, WorldState } from "@darkforest/contracts";
import {
  SchedulerRouter,
  type ProviderUsageMetrics,
  type RoutingAttempt,
} from "./scheduler-router.js";
import { COMPACT_PROFILE } from "@darkforest/core";
import { InMemoryMemoryStore, extractMemories, retrieve, __resetMemoryIds } from "@darkforest/memory";
import { renderDialoguePrompt } from "@darkforest/prompts";
import { SUITE1, type Suite1Fact } from "./worlds/suite1.js";

interface ProbeOutcome {
  factId: string;
  checkpoint: string;
  /** The fact was in the RETRIEVED set. This is recall@k (docs/15 § 3). */
  recalled: boolean;
  /**
   * The fact was in the STORE, whether or not retrieval surfaced it.
   *
   * Without this, `recalled: false` is ambiguous between two failures with
   * opposite fixes: the memory was never extracted, or it was extracted and
   * out-ranked. The 3-rep gate produced ten facts that scored `Y..` at turn 100
   * — recalled in run 1, missed in runs 2 and 3, with ZERO extraction drops —
   * and no way to tell which half of the pipeline lost them.
   */
  inStore: boolean;
  /** Rank of the matching memory in the retrieved set, or null if absent. */
  rank: number | null;
  storeSize: number;
  retrieved: number;
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
  extractionDrops: number;
  wallClockMs: number;
  providerUsage: Record<string, ProviderUsageMetrics>;
  /** Every routing attempt, including the ones that were rerouted. */
  attempts: RoutingAttempt[];
  /** Distinct capacity buckets that carried load. 1 = single point of failure. */
  bucketsUsed: number;
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
  router: SchedulerRouter,
  embedder: EmbeddingProvider,
): Promise<RunResult> {
  __resetMemoryIds();
  const store = new InMemoryMemoryStore();
  const speaker = SUITE1.characters[0]!;
  const transcript: Array<{ speaker: string; content: string }> = [];

  router.currentRun = runIndex;
  const initialAttemptCount = router.attempts.length;
  const initialProviderUsage = JSON.parse(
    JSON.stringify(router.usageByProvider),
  ) as Record<string, ProviderUsageMetrics>;

  let sinceExtraction = 0;
  let gateSkipped = 0;
  let calls = 0;
  let failures = 0;
  let extractionDrops = 0;
  let retried = 0;
  const failureCodes = new Map<string, number>();
  const note = (stage: string, e: unknown): void => {
    const code = e instanceof AIError ? e.code : "UNEXPECTED";
    const key = `${stage}:${code}`;
    failureCodes.set(key, (failureCodes.get(key) ?? 0) + 1);
    if (failureCodes.get(key) === 1 && e instanceof Error) {
      console.log(`\n      first ${key}: ${e.message.slice(0, 160)}`);
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
    const hits = (content: string): boolean =>
      fact.expect.some((n) => content.toLowerCase().includes(n.toLowerCase()));

    const rank = r.memories.findIndex((m) => hits(m.memory.content));
    // Same matcher against the whole store: separates "never extracted" from
    // "extracted but out-ranked". Those have opposite fixes.
    const all = await store.allByWorld(SUITE1.id);
    probes.push({
      factId: fact.id,
      checkpoint,
      recalled: rank >= 0,
      inStore: all.some((m) => hits(m.content)),
      rank: rank >= 0 ? rank : null,
      storeSize: all.length,
      retrieved: r.memories.length,
    });
  };

  for (let i = 0; i < SUITE1.script.length; i++) {
    // Pace to stay under the pool's per-minute token ceiling.
    if (i > 0) await sleep(1800);

    const userMessage = SUITE1.script[i]!;
    const day = SUITE1.startingDay + Math.floor(i / 2);
    const turnNumber = i + 1;
    router.currentTurn = turnNumber;

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
        const res = await router.generate(
          {
            taskClass: "dialogue",
            system: prompt.system,
            messages: [{ role: "user", content: userMessage }],
            maxTokens: 200,
            temperature: 0.8,
            timeoutMs: 30_000,
            meta: { requestId: `s1-${String(runIndex)}-${String(i)}`, worldId: SUITE1.id },
          },
          router.models[0]!,
        );
        reply = res.text;
        calls += 1;
        break;
      } catch (e) {
        const backpressure =
          e instanceof AIError && (e.code === "RATE_LIMITED" || e.code === "BUDGET_EXCEEDED");
        if (backpressure && attempt < 2) {
          retried += 1;
          await sleep(3000 * (attempt + 1));
          continue;
        }
        failures += 1;
        note("dialogue", e);
        break;
      }
    }

    transcript.push({ speaker: "user", content: userMessage });
    transcript.push({ speaker: speaker.name, content: reply });

    sinceExtraction += 1;
    let extracted = false;
    for (let attempt = 0; attempt < 3 && !extracted; attempt++) {
      try {
        const out = await extractMemories(store, router, router.models[0]!, embedder, {
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
        if (backpressure && attempt < 2) {
          retried += 1;
          await sleep(3000 * (attempt + 1));
          continue;
        }
        failures += 1;
        note("extract", e);
        break;
      }
    }
    if (!extracted) {
      failures += 1;
      extractionDrops += 1;
      failureCodes.set("extract:EXHAUSTED", (failureCodes.get("extract:EXHAUSTED") ?? 0) + 1);
    }

    // ── checkpoint probes ───────────────────────────────────────────────────
    if (SUITE1.checkpoints.includes(turnNumber as 30 | 60 | 100)) {
      const recent = transcript.slice(-2).map((t) => t.content);
      for (const fact of SUITE1.facts) {
        if (fact.probeAt.includes(turnNumber as 30 | 60 | 100)) {
          await probe(fact, String(turnNumber), recent, day);
        }
      }
      process.stdout.write(`    turn ${String(turnNumber)} probed  `);
    }

    await sleep(1500);
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
    console.log(
      `      failures: ${[...failureCodes].map(([k, n]) => `${k}×${String(n)}`).join(", ")}`,
    );
  }

  const runAttempts = router.attempts.slice(initialAttemptCount);
  const runUsageDelta: Record<string, ProviderUsageMetrics> = {};
  for (const [pId, usage] of Object.entries(router.usageByProvider)) {
    const init = initialProviderUsage[pId] ?? {
      dialogueCalls: 0,
      dialogueTokens: 0,
      extractCalls: 0,
      extractTokens: 0,
    };
    runUsageDelta[pId] = {
      dialogueCalls: usage.dialogueCalls - init.dialogueCalls,
      dialogueTokens: usage.dialogueTokens - init.dialogueTokens,
      extractCalls: usage.extractCalls - init.extractCalls,
      extractTokens: usage.extractTokens - init.extractTokens,
    };
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
    extractionDrops,
    wallClockMs: Date.now() - started,
    providerUsage: runUsageDelta,
    attempts: runAttempts,
    bucketsUsed: new Set(runAttempts.filter((a) => a.status === "ok").map((a) => a.bucketId)).size,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);

  const groq = new GroqProvider({
    getCredential: (est, modelId) => {
      // modelId is essential, not decorative: Groq meters per model, so
      // omitting it can debit a bucket metering a DIFFERENT model's budget.
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

  /*
   * No primary/fallback pair any more. The scheduler picks a bucket per request
   * from every wired provider, so all four Groq models are in play rather than
   * one — which is where the 4x capacity actually gets used.
   */
  /*
   * OpenRouter is narrowed to ONE model deliberately. Its adapter offers three,
   * but the 50/day free allowance is account-wide: offering all three would show
   * the scheduler three independent buckets backed by a single budget. The
   * bucket builder refuses to do this silently, and caught exactly this mistake
   * the first time Suite 1 ran through it.
   */
  const openrouterScheduled = openrouter.models.filter((m) => m.tier === "fast");

  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouterScheduled },
    sleep,
  });

  const reps = Number(process.env["SUITE1_REPS"] ?? "3");

  console.log("\n" + "═".repeat(72));
  console.log("SUITE 1 — multi-provider memory recall benchmark");
  console.log("═".repeat(72));
  console.log(
    `facts ${String(SUITE1.facts.length)} · turns ${String(SUITE1.script.length)} · checkpoints 30/60/100 + fresh · reps ${String(reps)}`,
  );
  /*
   * PREFLIGHT: prove the embedder works before measuring anything.
   *
   * Without this the suite runs to completion on a dead embedding credential,
   * stores memories with no vectors, silently degrades retrieval to text-only,
   * and prints a recall number that looks like a memory-quality result. That
   * happened: two full runs reported 67% recall while every one of 12 embedding
   * calls was returning 401. A benchmark that cannot produce a valid number must
   * refuse to produce one at all.
   */
  try {
    const probe = await embedder.embed(["preflight: the sword beneath the floorboards"]);
    const dims = probe[0]?.length ?? 0;
    if (dims === 0) throw new Error("embedder returned no vector");
    console.log(`preflight: embeddings OK (${embedder.id}, ${String(dims)} dims)`);
  } catch (e) {
    console.error(
      `
ABORTED — the embedding provider is not usable, so recall cannot be measured.
` +
        `  ${e instanceof Error ? e.message : String(e)}

` +
        `  Retrieval would silently fall back to text-only search and the run would
` +
        `  still print a recall figure. That figure would not mean what it says.
`,
    );
    process.exitCode = 1;
    return;
  }

  const inv = router.capacityOverview();
  console.log("routing: capacity scheduler (ADR-021) — no primary/fallback chain");
  for (const [pid, st] of Object.entries(inv.byProvider)) {
    console.log(
      `  ${pid.padEnd(11)} ${String(st.buckets).padStart(3)} buckets  ` +
        `${String(st.models.length)} model(s)  headroom ${(st.headroom * 100).toFixed(0)}%`,
    );
  }
  console.log(`  TOTAL ${String(inv.totalBuckets)} buckets · embeddings ${embedder.id}`);

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = "docs/benchmarks/runs";
  mkdirSync(outDir, { recursive: true });
  const outFile = `${outDir}/${stamp}-suite1.json`;

  const results: RunResult[] = [];
  for (let r = 1; r <= reps; r++) {
    process.stdout.write(`  run ${String(r)}/${String(reps)}  `);
    results.push(await runOnce(r, router, embedder));
    const last = results[results.length - 1]!;

    writeFileSync(
      outFile,
      JSON.stringify(
        {
          suite: "suite1",
          date: stamp,
          // Every bucket the scheduler could draw on, not a fixed pair.
          capacity: router.capacityOverview(),
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
            extractionDrops: x.extractionDrops,
            wallClockMs: x.wallClockMs,
            providerUsage: x.providerUsage,
            attempts: x.attempts,
            bucketsUsed: x.bucketsUsed,
            probes: x.probes,
          })),
          telemetrySummary: {
            totalDialogueCalls: {
              groq: results.reduce(
                (acc, x) => acc + (x.providerUsage["groq"]?.dialogueCalls ?? 0),
                0,
              ),
              openrouter: results.reduce(
                (acc, x) => acc + (x.providerUsage["openrouter"]?.dialogueCalls ?? 0),
                0,
              ),
            },
            totalExtractCalls: {
              groq: results.reduce(
                (acc, x) => acc + (x.providerUsage["groq"]?.extractCalls ?? 0),
                0,
              ),
              openrouter: results.reduce(
                (acc, x) => acc + (x.providerUsage["openrouter"]?.extractCalls ?? 0),
                0,
              ),
            },
            routing: {
              totalAttempts: router.attempts.length,
              reroutes: router.attempts.filter((a) => a.status !== "ok").length,
              byReason: {
                RATE_LIMITED: router.attempts.filter((a) => a.status !== "ok").filter((a) => a.status === "RATE_LIMITED").length,
                BUDGET_EXCEEDED: router.attempts.filter((a) => a.status !== "ok").filter((a) => a.status === "BUDGET_EXCEEDED").length,
                NO_CREDENTIAL: router.attempts.filter((a) => a.status !== "ok").filter((a) => a.status === "NO_CREDENTIAL").length,
                PROVIDER_ERROR: router.attempts.filter((a) => a.status !== "ok").filter((a) => a.status === "PROVIDER_ERROR").length,
              },
              distinctBucketsUsed: new Set(
                router.attempts.filter((a) => a.status === "ok").map((a) => a.bucketId),
              ).size,
              byBucket: Object.fromEntries(
                Object.entries(
                  router.attempts.reduce<Record<string, number>>((acc, a) => {
                    if (a.status === "ok") acc[a.bucketId] = (acc[a.bucketId] ?? 0) + 1;
                    return acc;
                  }, {}),
                ).sort((a, b) => b[1] - a[1]),
              ),
            },
            extractionDrops: results.reduce((acc, x) => acc + x.extractionDrops, 0),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const groqCalls =
      (last.providerUsage["groq"]?.dialogueCalls ?? 0) +
      (last.providerUsage["groq"]?.extractCalls ?? 0);
    const orCalls =
      (last.providerUsage["openrouter"]?.dialogueCalls ?? 0) +
      (last.providerUsage["openrouter"]?.extractCalls ?? 0);

    console.log(
      `    → recall ${(last.overallRecall * 100).toFixed(0)}%  ` +
        `memories ${String(last.memoriesStored)}  gate-skipped ${String(last.gateSkipped)}/${String(last.turns)}  ` +
        `groq:${String(groqCalls)} or:${String(orCalls)}  ` +
        `buckets ${String(last.bucketsUsed)}  reroutes ${String(last.attempts.filter((a) => a.status !== "ok").length)}  ` +
        `${(last.wallClockMs / 1000).toFixed(0)}s`,
    );

    if (r < reps) {
      console.log(
        "\n  [COOLDOWN] waiting 20s for credential pool windows to reset before next repetition...",
      );
      await sleep(20000);
    }
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
    console.log(
      `  ${label.padEnd(14)} ${median(rates).toFixed(0)}%   (min ${Math.min(...rates).toFixed(0)}%)`,
    );
  }

  console.log("\n" + "─".repeat(72));
  console.log("PER-FACT RECALL — which facts are actually failing");
  const factHits = new Map<
    string,
    { hit: number; total: number; inStore: number; kind: string; q: string }
  >();
  for (const r of results) {
    for (const p of r.probes) {
      const fact = SUITE1.facts.find((f) => f.id === p.factId);
      if (!fact) continue;
      const e = factHits.get(p.factId) ?? {
        hit: 0,
        total: 0,
        inStore: 0,
        kind: fact.kind,
        q: fact.question,
      };
      e.total += 1;
      if (p.recalled) e.hit += 1;
      if (p.inStore) e.inStore += 1;
      factHits.set(p.factId, e);
    }
  }
  const sorted = [...factHits.entries()].sort(
    (a, b) => a[1].hit / a[1].total - b[1].hit / b[1].total,
  );
  console.log("  (stored = the fact was in the store; recall = retrieval surfaced it)");
  for (const [id, e] of sorted) {
    const rate = (e.hit / e.total) * 100;
    const stored = (e.inStore / e.total) * 100;
    const mark = rate >= 80 ? " " : rate >= 40 ? "~" : "✗";
    // A wide gap here is a RETRIEVAL failure; a low stored figure is an
    // EXTRACTION failure. They have opposite fixes, so never merge the columns.
    const gap = stored - rate >= 25 ? "  << retrieval" : "";
    console.log(
      `  ${mark} ${id} ${e.kind.padEnd(14)} recall ${rate.toFixed(0).padStart(3)}%  ` +
        `stored ${stored.toFixed(0).padStart(3)}%  ${e.q}${gap}`,
    );
  }

  const allProbes = results.flatMap((r) => r.probes);
  const storedNotRecalled = allProbes.filter((p) => p.inStore && !p.recalled).length;
  const neverStored = allProbes.filter((p) => !p.inStore).length;
  console.log(
    `
  SPLIT  ${String(storedNotRecalled)} probes stored-but-not-retrieved · ` +
      `${String(neverStored)} never stored · ${String(allProbes.length)} total`,
  );
  const ranks = allProbes.map((p) => p.rank).filter((r): r is number => r !== null);
  if (ranks.length > 0) {
    console.log(
      `  RANK   median ${median(ranks).toFixed(1)} of ${String(
        Math.max(...allProbes.map((p) => p.retrieved)),
      )} retrieved · store grows to ${String(Math.max(...allProbes.map((p) => p.storeSize)))}`,
    );
  }

  // ── Multi-Provider Failover & Telemetry Audit ──────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("MULTI-PROVIDER TELEMETRY & FAILOVER AUDIT");
  const totGroqDiag = results.reduce(
    (acc, x) => acc + (x.providerUsage["groq"]?.dialogueCalls ?? 0),
    0,
  );
  const totOrDiag = results.reduce(
    (acc, x) => acc + (x.providerUsage["openrouter"]?.dialogueCalls ?? 0),
    0,
  );
  const totGroqExt = results.reduce(
    (acc, x) => acc + (x.providerUsage["groq"]?.extractCalls ?? 0),
    0,
  );
  const totOrExt = results.reduce(
    (acc, x) => acc + (x.providerUsage["openrouter"]?.extractCalls ?? 0),
    0,
  );
  const totGroqCalls = totGroqDiag + totGroqExt;
  const totOrCalls = totOrDiag + totOrExt;
  const allCalls = totGroqCalls + totOrCalls;
  const groqPct = allCalls > 0 ? (totGroqCalls / allCalls) * 100 : 0;
  const orPct = allCalls > 0 ? (totOrCalls / allCalls) * 100 : 0;

  console.log(
    `  dialogue:   groq ${String(totGroqDiag)} calls · openrouter ${String(totOrDiag)} calls`,
  );
  console.log(
    `  extraction: groq ${String(totGroqExt)} calls · openrouter ${String(totOrExt)} calls`,
  );
  console.log(
    `  share:      groq ${groqPct.toFixed(1)}% · openrouter ${orPct.toFixed(1)}%`,
  );
  const reroutes = router.attempts.filter((a) => a.status !== "ok");
  const usedBuckets = new Set(
    router.attempts.filter((a) => a.status === "ok").map((a) => a.bucketId),
  );
  console.log(`  buckets:    ${String(usedBuckets.size)} distinct carried load`);
  console.log(`  reroutes:   ${String(reroutes.length)} total`);
  const reasonCounts: Record<string, number> = {};
  for (const fb of reroutes) {
    reasonCounts[fb.status] = (reasonCounts[fb.status] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasonCounts)) {
    console.log(`    - ${reason}: ${String(count)}`);
  }

  const totalDrops = results.reduce((acc, x) => acc + x.extractionDrops, 0);
  console.log(`  extraction drops: ${String(totalDrops)}`);

  console.log("\n" + "═".repeat(72));
  console.log(`recall@k   median ${med.toFixed(0)}%   min ${min.toFixed(0)}%   max ${max.toFixed(0)}%`);
  console.log(`runs       ${recalls.map((x) => `${x.toFixed(0)}%`).join("  ")}`);
  console.log(`memories   ${results.map((x) => String(x.memoriesStored)).join("  ")}`);

  const freshRates = results
    .map((r) => r.recallByCheckpoint["fresh"])
    .filter((b): b is { hit: number; total: number } => b !== undefined)
    .map((b) => (b.total === 0 ? 0 : (b.hit / b.total) * 100));
  const freshMed = median(freshRates);

  const pass =
    med >= 85 && min >= 85 && freshMed >= 80 && totalDrops === 0 && recalls.every((r) => r >= 85);
  console.log(
    `\nPHASE 1 GATE (Run 1-3 ≥85%, min ≥85%, fresh ≥80%, 0 drops):  ${pass ? "PASS" : "FAIL"}` +
      (med >= 85 && min < 85 ? "   — median clears, floor does not" : "") +
      (totalDrops > 0 ? `   — ${String(totalDrops)} extraction drops` : ""),
  );
  console.log("═".repeat(72));

  for (const s of registry.snapshotAll()) {
    console.log(
      `${s.providerId.padEnd(12)} ${String(s.available)}/${String(s.total)} available, headroom ${(s.aggregateHeadroom * 100).toFixed(1)}%`,
    );
  }
  console.log();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
