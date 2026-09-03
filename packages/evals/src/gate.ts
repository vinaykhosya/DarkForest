/**
 * PHASE 1 GATE — the definitive end-to-end measurement.
 *
 * Everything before this was a capacity MODEL. This is the workload.
 *
 * Runs the complete loop against real providers only:
 *   retrieve → build prompt → generate dialogue → gate → extract → store → embed
 *
 * Measures the eleven quantities that decide whether Phase 1 passes, and — just
 * as importantly — whether the ~16.4K turns/day estimate survives contact with
 * reality. It will not survive intact: that number ignored reasoning tokens,
 * which are billed exactly like output tokens.
 *
 * Uses the COMPACT context profile. `full` (~11.3K) cannot run on Groq at all
 * (ADR-020), so measuring it here would measure nothing.
 */

import { readFileSync } from "node:fs";
import {
  CloudflareEmbeddingProvider,
  CredentialRegistry,
  GroqProvider,
} from "@darkforest/ai";
import type {
  Character,
  EmbeddingProvider,
  ModelDescriptor,
  WorldState,
} from "@darkforest/contracts";
import { AIError } from "@darkforest/contracts";

/**
 * Blind-casting an unknown error to AIError would silently mislabel a
 * TypeError as a provider failure. instanceof keeps the taxonomy honest.
 */
function errorCode(e: unknown): string {
  return e instanceof AIError ? e.code : "UNEXPECTED";
}
import { COMPACT_PROFILE, REQUEST_CEILINGS, totalBudget } from "@darkforest/core";
import { InMemoryMemoryStore, extractMemories, retrieve, __resetMemoryIds } from "@darkforest/memory";
import { renderDialoguePrompt } from "@darkforest/prompts";
import { TEST_WORLDS, type TestWorld } from "./worlds/index.js";

// ── metrics ──────────────────────────────────────────────────────────────────

interface CallMetric {
  taskClass: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
}

interface GateMetrics {
  calls: CallMetric[];
  turns: number;
  dialogueCalls: number;
  extractionCalls: number;
  extractionSkipped: number;
  malformed: number;
  ceilingRejections: number;
  factsRecalled: number;
  factsTotal: number;
  factsAnswered: number;
  memoriesStored: number;
  wallClockMs: number;
}

function emptyMetrics(): GateMetrics {
  return {
    calls: [],
    turns: 0,
    dialogueCalls: 0,
    extractionCalls: 0,
    extractionSkipped: 0,
    malformed: 0,
    ceilingRejections: 0,
    factsRecalled: 0,
    factsTotal: 0,
    factsAnswered: 0,
    memoriesStored: 0,
    wallClockMs: 0,
  };
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

function stateFor(world: TestWorld, day: number): WorldState {
  return {
    worldId: world.id,
    version: 1n,
    day,
    timeOfDay: "evening",
    currentLocation: world.location,
    weather: null,
    chapter: 1,
    chapterTitle: null,
    sceneSummary: "",
    flags: {},
    numerics: {},
  };
}

const pct = (a: number, b: number): string =>
  b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

// ── the run ──────────────────────────────────────────────────────────────────

async function runWorld(
  world: TestWorld,
  provider: GroqProvider,
  model: ModelDescriptor,
  embedder: EmbeddingProvider,
  m: GateMetrics,
): Promise<void> {
  __resetMemoryIds();
  const store = new InMemoryMemoryStore();
  const speaker: Character = world.characters[0]!;
  const transcript: Array<{ speaker: string; content: string }> = [];
  let sinceExtraction = 0;

  const probes = world.plantedFacts.map((f) => f.question);
  const allTurns = [...world.script, ...probes];
  const probeStart = world.script.length;

  console.log(`\n╭─ ${world.name}`);

  for (let i = 0; i < allTurns.length; i++) {
    const userMessage = allTurns[i]!;
    const day = world.startingDay + i;

    // ── retrieve ────────────────────────────────────────────────────────────
    const retrieval = await retrieve(store, embedder, {
      worldId: world.id,
      characterId: speaker.id,
      userMessage,
      recentLines: transcript.slice(-2).map((t) => t.content),
      aliases: world.aliases,
      currentWorldDay: day,
      tokenBudget: COMPACT_PROFILE.memories,
      maxMemories: 6,
    });

    // ── prompt (compact — full does not fit on Groq, ADR-020) ───────────────
    const prompt = renderDialoguePrompt({
      profile: "compact",
      world: { name: world.name, genre: world.genre, tone: world.tone, perspective: "second" },
      rules: world.rules,
      character: speaker,
      memories: retrieval.memories.map((mem) => ({
        worldDay: mem.memory.worldDay,
        content: mem.memory.content,
        certainty: 1,
      })),
      relationships: [],
      state: stateFor(world, day),
      presentCharacterNames: world.characters.map((c) => c.name),
      visibleNumerics: [],
      priorSpeakers: [],
    });

    // ── generate dialogue ───────────────────────────────────────────────────
    let responseText = "";
    try {
      const res = await provider.generate(
        {
          taskClass: "dialogue",
          system: prompt.system,
          messages: [{ role: "user", content: userMessage }],
          maxTokens: 300,
          temperature: 0.8,
          timeoutMs: 30_000,
          meta: {
            requestId: `gate-${world.name}-${String(i)}`,
            worldId: world.id,
            characterId: speaker.id,
          },
        },
        model,
      );
      responseText = res.text;
      m.dialogueCalls += 1;
      m.calls.push({
        taskClass: "dialogue",
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens ?? 0,
        latencyMs: res.latencyMs,
        ok: true,
      });
    } catch (e) {
      const code = errorCode(e);
      if (code === "CAPABILITY_MISSING") m.ceilingRejections += 1;
      if (code === "MALFORMED_OUTPUT") m.malformed += 1;
      m.calls.push({
        taskClass: "dialogue",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        ok: false,
        errorCode: code,
      });
    }

    transcript.push({ speaker: "user", content: userMessage });
    transcript.push({ speaker: speaker.name, content: responseText });
    m.turns += 1;

    // ── extract (gated) ─────────────────────────────────────────────────────
    sinceExtraction += 1;
    try {
      const out = await extractMemories(store, provider, model, embedder, {
        worldId: world.id,
        transcript: transcript.slice(-6),
        worldDay: day,
        knownEntities: world.characters.map((c) => ({
          ref: `character:${c.id}`,
          name: c.name,
        })),
        aggressiveness: 0.5,
        turnsSinceLastExtraction: sinceExtraction,
      });
      if (out.skipped) {
        m.extractionSkipped += 1;
      } else {
        m.extractionCalls += out.usage.calls;
        if (out.rejected.length > 0) m.malformed += 1;
        m.memoriesStored += out.stored.length;
        sinceExtraction = 0;
        // Account extraction properly. Omitting it understated total load by
        // ~40% in the first gate run and made the token-bound capacity figure
        // meaningless.
        if (out.usage.calls > 0) {
          m.calls.push({
            taskClass: "extract",
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            reasoningTokens: out.usage.reasoningTokens,
            latencyMs: out.usage.latencyMs,
            ok: true,
          });
        }
      }
    } catch (e) {
      const code = errorCode(e);
      if (code === "MALFORMED_OUTPUT") m.malformed += 1;
      m.calls.push({
        taskClass: "extract",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        ok: false,
        errorCode: code,
      });
    }

    // ── score the probe turns ───────────────────────────────────────────────
    if (i >= probeStart) {
      const fact = world.plantedFacts[i - probeStart];
      if (fact) {
        m.factsTotal += 1;
        const retrievedText = retrieval.memories
          .map((mem) => mem.memory.content)
          .join(" ")
          .toLowerCase();
        const inRetrieved = fact.expectedAnswerContains.some((n) =>
          retrievedText.includes(n.toLowerCase()),
        );
        const inResponse = fact.expectedAnswerContains.some((n) =>
          responseText.toLowerCase().includes(n.toLowerCase()),
        );
        if (inRetrieved) m.factsRecalled += 1;
        if (inResponse) m.factsAnswered += 1;
        console.log(
          `│  ${inRetrieved ? "✓" : "✗"} recall  ${inResponse ? "✓" : "✗"} answered   ${fact.question}`,
        );
      }
    }
  }

  const stored = await store.allByWorld(world.id);
  console.log(`╰─ ${String(stored.length)} memories stored`);
  for (const mem of stored.slice(0, 4)) {
    console.log(`   • ${mem.content}`);
  }
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

  // fast tier: gpt-oss-20b, with reasoning_effort=low on structured tasks.
  const model = provider.models.find((mm) => mm.tier === "fast") ?? provider.models[0]!;

  console.log("\n" + "═".repeat(70));
  console.log("PHASE 1 GATE — real providers, compact profile");
  console.log("═".repeat(70));
  console.log(`dialogue + extraction : ${model.id}`);
  console.log(`embeddings            : ${embedder.id}`);
  console.log(`context profile       : compact (${String(totalBudget(COMPACT_PROFILE))} tok budget)`);
  console.log(`groq credentials      : ${String(registry.snapshot("groq")?.total ?? 0)}`);

  const m = emptyMetrics();
  const started = Date.now();
  for (const world of TEST_WORLDS) {
    await runWorld(world, provider, model, embedder, m);
  }
  m.wallClockMs = Date.now() - started;

  report(m, registry);
}

function report(m: GateMetrics, registry: CredentialRegistry): void {
  const ok = m.calls.filter((c) => c.ok);
  const failed = m.calls.filter((c) => !c.ok);
  const totalCalls = m.calls.length;

  const sum = (f: (c: CallMetric) => number): number => ok.reduce((n, c) => n + f(c), 0);
  const inTok = sum((c) => c.inputTokens);
  const outTok = sum((c) => c.outputTokens);
  const reasonTok = sum((c) => c.reasoningTokens);
  const totalTok = inTok + outTok;

  const latencies = ok.map((c) => c.latencyMs);
  const dialogueLat = ok.filter((c) => c.taskClass === "dialogue").map((c) => c.latencyMs);

  console.log("\n" + "═".repeat(70));
  console.log("RESULTS");
  console.log("═".repeat(70));

  console.log("\n1. MEMORY RECALL");
  console.log(`   recall@k          ${String(m.factsRecalled)}/${String(m.factsTotal)}  ${pct(m.factsRecalled, m.factsTotal)}`);
  console.log(`   answer accuracy   ${String(m.factsAnswered)}/${String(m.factsTotal)}  ${pct(m.factsAnswered, m.factsTotal)}`);
  console.log(`   memories stored   ${String(m.memoriesStored)}`);

  console.log("\n2-3. CALLS PER TURN");
  console.log(`   turns             ${String(m.turns)}`);
  console.log(`   dialogue calls    ${String(m.dialogueCalls)}   (${(m.dialogueCalls / m.turns).toFixed(2)}/turn)`);
  console.log(`   extraction calls  ${String(m.extractionCalls)}   (${(m.extractionCalls / m.turns).toFixed(2)}/turn)`);
  console.log(`   gate skipped      ${String(m.extractionSkipped)}   (${pct(m.extractionSkipped, m.turns)} of turns — inference saved)`);
  console.log(`   TOTAL calls/turn  ${(totalCalls / m.turns).toFixed(2)}`);

  console.log("\n4-6. TOKENS");
  console.log(`   input   /turn     ${String(Math.round(inTok / m.turns))}`);
  console.log(`   output  /turn     ${String(Math.round(outTok / m.turns))}`);
  console.log(`   reasoning/turn    ${String(Math.round(reasonTok / m.turns))}   ${pct(reasonTok, outTok)} of output`);
  console.log(`   TOTAL   /turn     ${String(Math.round(totalTok / m.turns))}`);

  console.log("\n7. GROQ 8K CEILING");
  const maxReq = Math.max(...ok.map((c) => c.inputTokens + c.outputTokens), 0);
  console.log(`   largest request   ${String(maxReq)} tok  (ceiling ${String(REQUEST_CEILINGS.groqFree)})`);
  console.log(`   headroom          ${String(REQUEST_CEILINGS.groqFree - maxReq)} tok`);
  console.log(`   size rejections   ${String(m.ceilingRejections)}`);

  console.log("\n8. LATENCY");
  console.log(`   dialogue p50      ${String(percentile(dialogueLat, 50))} ms`);
  console.log(`   dialogue p95      ${String(percentile(dialogueLat, 95))} ms`);
  console.log(`   all calls p95     ${String(percentile(latencies, 95))} ms`);

  console.log("\n9. FAILURES");
  console.log(`   failed calls      ${String(failed.length)}/${String(totalCalls)}  ${pct(failed.length, totalCalls)}`);
  console.log(`   malformed output  ${String(m.malformed)}`);
  const byCode = new Map<string, number>();
  for (const f of failed) byCode.set(f.errorCode ?? "?", (byCode.get(f.errorCode ?? "?") ?? 0) + 1);
  for (const [code, n] of byCode) console.log(`     ${code}: ${String(n)}`);

  console.log("\n10-11. MEASURED CAPACITY");
  /*
   * Request-bound and token-bound ceilings computed from what we ACTUALLY
   * observed, not from the earlier model. Reasoning tokens are included in
   * outTok, so they are counted here — which the ~16.4K estimate did not do.
   */
  const CREDENTIALS = registry.snapshot("groq")?.total ?? 1;
  const DIALOGUE_MODELS = 4;
  const rpdPool = 1000 * DIALOGUE_MODELS * CREDENTIALS;
  const tpmPool = 8000 * DIALOGUE_MODELS * CREDENTIALS;

  const callsPerTurn = totalCalls / m.turns;
  const tokensPerTurn = totalTok / m.turns;

  const turnsPerDayRequestBound = rpdPool / callsPerTurn;
  const turnsPerMinTokenBound = tpmPool / tokensPerTurn;
  /*
   * The token-bound DAILY figure is not TPM x 1440: sustaining peak tokens all
   * day would need far more requests than the daily cap allows. Requests bind
   * first, so the honest daily number is the request-bound one, and TPM only
   * limits how hard we can burst within any given minute.
   */
  const bindingDay = turnsPerDayRequestBound;

  console.log(`   calls/turn        ${callsPerTurn.toFixed(2)}   tokens/turn ${String(Math.round(tokensPerTurn))}`);
  console.log(`   request pool      ${String(rpdPool)} req/day   token pool ${String(tpmPool)} tok/min`);
  console.log(`   → turns/day       ${String(Math.round(bindingDay))}   (request-bound; requests exhaust before tokens)`);
  console.log(`   sustained         ${(bindingDay / 1440).toFixed(1)} turns/min`);
  console.log(`   burst             ${turnsPerMinTokenBound.toFixed(1)} turns/min`);
  console.log(`   DAU @ 20 turns    ~${String(Math.round(bindingDay / 20))}`);
  console.log(`\n   prior ESTIMATE was 16400 turns/day — that ignored reasoning tokens.`);

  console.log("\n" + "═".repeat(70));
  const recallPct = m.factsTotal === 0 ? 0 : (m.factsRecalled / m.factsTotal) * 100;
  const pass = recallPct >= 85;
  console.log(`PHASE 1 GATE: recall@k ${recallPct.toFixed(0)}% (need ≥85%)  →  ${pass ? "PASS" : "FAIL"}`);
  console.log("═".repeat(70));

  console.log(`\nwall clock: ${(m.wallClockMs / 1000).toFixed(1)}s for ${String(m.turns)} turns`);
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
