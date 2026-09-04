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
 * granular telemetry (Groq primary -> OpenRouter failover). Distinguishes
 * RATE_LIMITED, BUDGET_EXCEEDED, NO_CREDENTIAL, and PROVIDER_ERROR.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CloudflareEmbeddingProvider,
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
} from "@darkforest/ai";
import { AIError } from "@darkforest/contracts";
import type {
  AIProvider,
  EmbeddingProvider,
  FallbackReason,
  GenerateRequest,
  GenerateResponse,
  ModelDescriptor,
  ProviderHealth,
  StreamChunk,
  WorldState,
} from "@darkforest/contracts";
import { COMPACT_PROFILE } from "@darkforest/core";
import { InMemoryMemoryStore, extractMemories, retrieve, __resetMemoryIds } from "@darkforest/memory";
import { renderDialoguePrompt } from "@darkforest/prompts";
import { SUITE1, type Suite1Fact } from "./worlds/suite1.js";

interface ProbeOutcome {
  factId: string;
  checkpoint: string;
  recalled: boolean;
}

interface ProviderCandidate {
  providerId: "groq" | "openrouter";
  provider: AIProvider;
  model: ModelDescriptor;
}

interface FallbackRecord {
  run: number;
  turnIndex: number;
  taskClass: "dialogue" | "extract";
  fallbackFrom: string;
  fallbackTo: string;
  fallbackReason: FallbackReason;
  attempt: number;
  detail?: string;
}

interface ProviderUsageMetrics {
  dialogueCalls: number;
  dialogueTokens: number;
  extractCalls: number;
  extractTokens: number;
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
  fallbacks: FallbackRecord[];
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

class MultiProviderRouter implements AIProvider {
  readonly id = "router";
  readonly enabled = true;
  readonly models: readonly ModelDescriptor[];

  currentRun = 1;
  currentTurn = 0;
  readonly fallbacks: FallbackRecord[] = [];
  readonly usageByProvider: Record<string, ProviderUsageMetrics> = {};

  constructor(
    private readonly pools: {
      dialogue: ProviderCandidate[];
      extract: ProviderCandidate[];
    },
  ) {
    this.models = [
      ...pools.dialogue.map((c) => c.model),
      ...pools.extract.map((c) => c.model),
    ];
    for (const pool of Object.values(pools)) {
      for (const c of pool) {
        if (!this.usageByProvider[c.providerId]) {
          this.usageByProvider[c.providerId] = {
            dialogueCalls: 0,
            dialogueTokens: 0,
            extractCalls: 0,
            extractTokens: 0,
          };
        }
      }
    }
  }

  health(): ProviderHealth {
    return {
      state: "closed",
      recentFailures: 0,
      recentRequests: 0,
      lastFailureAt: null,
      cooldownUntil: null,
    };
  }

  async generate(req: GenerateRequest, _model: ModelDescriptor): Promise<GenerateResponse> {
    const taskClass = req.taskClass === "extract" ? "extract" : "dialogue";
    const candidates = this.pools[taskClass];
    let lastError: unknown = null;
    let fallbackFrom: string | null = null;
    let fallbackReason: FallbackReason | null = null;

    for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
      const candidate = candidates[cIdx]!;

      if (cIdx > 0 && fallbackFrom && fallbackReason) {
        const ev: FallbackRecord = {
          run: this.currentRun,
          turnIndex: this.currentTurn,
          taskClass,
          fallbackFrom,
          fallbackTo: candidate.providerId,
          fallbackReason,
          attempt: cIdx + 1,
          detail: lastError instanceof Error ? lastError.message.slice(0, 120) : String(lastError),
        };
        this.fallbacks.push(ev);
        process.stdout.write(
          `\n        [FAILOVER] turn ${String(this.currentTurn)} ${taskClass}: ${ev.fallbackFrom} → ${ev.fallbackTo} (${ev.fallbackReason}) `,
        );
      }

      const maxAttempts = candidate.providerId === "groq" ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const res = await candidate.provider.generate(req, candidate.model);
          const totalTokens =
            res.usage.inputTokens + res.usage.outputTokens + (res.usage.reasoningTokens ?? 0);
          const stats = (this.usageByProvider[candidate.providerId] ??= {
            dialogueCalls: 0,
            dialogueTokens: 0,
            extractCalls: 0,
            extractTokens: 0,
          });
          if (taskClass === "extract") {
            stats.extractCalls += 1;
            stats.extractTokens += totalTokens;
          } else {
            stats.dialogueCalls += 1;
            stats.dialogueTokens += totalTokens;
          }

          if (fallbackFrom) {
            return {
              ...res,
              fallbackFrom,
              fallbackReason,
            };
          }
          return res;
        } catch (e) {
          lastError = e;
          const isRateLimit = e instanceof AIError && e.code === "RATE_LIMITED";
          const isBudgetExceeded = e instanceof AIError && e.code === "BUDGET_EXCEEDED";
          const isNoCred = e instanceof AIError && e.code === "AUTH_FAILED";

          if (isRateLimit) fallbackReason = "RATE_LIMITED";
          else if (isBudgetExceeded) fallbackReason = "BUDGET_EXCEEDED";
          else if (isNoCred) fallbackReason = "NO_CREDENTIAL";
          else fallbackReason = "PROVIDER_ERROR";

          if ((isRateLimit || isBudgetExceeded) && attempt < maxAttempts - 1) {
            await sleep(3000);
            continue;
          }

          fallbackFrom = candidate.providerId;
          break;
        }
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error(`All provider candidates exhausted for ${taskClass}`);
  }

  async *stream(req: GenerateRequest, model: ModelDescriptor): AsyncGenerator<StreamChunk, void> {
    const res = await this.generate(req, model);
    yield { type: "text", delta: res.text };
    for (const call of res.toolCalls) {
      yield { type: "tool_call", call };
    }
    yield { type: "done", response: res };
  }
}

async function runOnce(
  runIndex: number,
  router: MultiProviderRouter,
  embedder: EmbeddingProvider,
): Promise<RunResult> {
  __resetMemoryIds();
  const store = new InMemoryMemoryStore();
  const speaker = SUITE1.characters[0]!;
  const transcript: Array<{ speaker: string; content: string }> = [];

  router.currentRun = runIndex;
  const initialFallbackCount = router.fallbacks.length;
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
    const text = r.memories.map((m) => m.memory.content).join(" ").toLowerCase();
    const recalled = fact.expect.some((n) => text.includes(n.toLowerCase()));
    probes.push({ factId: fact.id, checkpoint, recalled });
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

  const runFallbacks = router.fallbacks.slice(initialFallbackCount);
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
    fallbacks: runFallbacks,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);

  const groq = new GroqProvider({
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

  const openrouter = new OpenRouterProvider({
    getCredential: (est) => {
      const g = registry.acquire("openrouter", est);
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

  const groqFast = groq.models.find((m) => m.tier === "fast") ?? groq.models[0]!;
  const openrouterFast =
    openrouter.models.find((m) => m.tier === "fast") ?? openrouter.models[0]!;

  const router = new MultiProviderRouter({
    dialogue: [
      { providerId: "groq", provider: groq, model: groqFast },
      { providerId: "openrouter", provider: openrouter, model: openrouterFast },
    ],
    extract: [
      { providerId: "groq", provider: groq, model: groqFast },
      { providerId: "openrouter", provider: openrouter, model: openrouterFast },
    ],
  });

  const reps = Number(process.env["SUITE1_REPS"] ?? "3");

  console.log("\n" + "═".repeat(72));
  console.log("SUITE 1 — multi-provider memory recall benchmark");
  console.log("═".repeat(72));
  console.log(
    `facts ${String(SUITE1.facts.length)} · turns ${String(SUITE1.script.length)} · checkpoints 30/60/100 + fresh · reps ${String(reps)}`,
  );
  console.log(
    `primary dialogue:  ${groqFast.id} (groq)\n` +
      `failover dialogue: ${openrouterFast.id} (openrouter)\n` +
      `primary extract:   ${groqFast.id} (groq)\n` +
      `failover extract:  ${openrouterFast.id} (openrouter)\n` +
      `embeddings:        ${embedder.id}\n`,
  );

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
          candidates: {
            dialogue: [groqFast.id, openrouterFast.id],
            extract: [groqFast.id, openrouterFast.id],
          },
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
            fallbacks: x.fallbacks,
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
            totalFallbacks: router.fallbacks.length,
            fallbacksByReason: {
              RATE_LIMITED: router.fallbacks.filter((f) => f.fallbackReason === "RATE_LIMITED")
                .length,
              BUDGET_EXCEEDED: router.fallbacks.filter((f) => f.fallbackReason === "BUDGET_EXCEEDED")
                .length,
              NO_CREDENTIAL: router.fallbacks.filter((f) => f.fallbackReason === "NO_CREDENTIAL")
                .length,
              PROVIDER_ERROR: router.fallbacks.filter((f) => f.fallbackReason === "PROVIDER_ERROR")
                .length,
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
        `groq:${String(groqCalls)} or:${String(orCalls)}  fallbacks ${String(last.fallbacks.length)}  ` +
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
  const sorted = [...factHits.entries()].sort(
    (a, b) => a[1].hit / a[1].total - b[1].hit / b[1].total,
  );
  for (const [id, e] of sorted) {
    const rate = (e.hit / e.total) * 100;
    const mark = rate >= 80 ? " " : rate >= 40 ? "~" : "✗";
    console.log(`  ${mark} ${id} ${e.kind.padEnd(14)} ${rate.toFixed(0).padStart(3)}%  ${e.q}`);
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
  console.log(`  fallbacks:  ${String(router.fallbacks.length)} total`);
  const reasonCounts: Record<string, number> = {};
  for (const fb of router.fallbacks) {
    reasonCounts[fb.fallbackReason] = (reasonCounts[fb.fallbackReason] ?? 0) + 1;
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
