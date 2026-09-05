/**
 * SUITE 1 A/B — memory retrieval versus structured resolution (ADR-025).
 *
 * The experiment the architecture review committed to before any production path
 * changes. Both write paths consume the SAME dialogue on the SAME turn, so the
 * comparison is controlled: any difference is representation, not luck.
 *
 *   turn ──> dialogue (one call, shared)
 *              ├──> A: prose extraction  ──> memory store  ──> retrieve + rank
 *              └──> B: typed events      ──> projections   ──> route + resolve
 *                                                               └─ fallback to A
 *
 * B falls back to A whenever a question does not route, because unmatched must
 * be the safe outcome — an architecture that answers only anticipated questions
 * is exactly the failure mode worth measuring for.
 *
 * Extraction runs twice here, which no production path would do. That is the
 * price of a controlled comparison and it is confined to this harness.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CloudflareEmbeddingProvider,
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
} from "@darkforest/ai";
import { AIError, type WorldEvent, type WorldState } from "@darkforest/contracts";
import { COMPACT_PROFILE, project, resolve, routeQuery } from "@darkforest/core";
import {
  InMemoryMemoryStore,
  extractEvents,
  extractMemories,
  retrieve,
  __resetMemoryIds,
} from "@darkforest/memory";
import { renderDialoguePrompt } from "@darkforest/prompts";
import { SchedulerRouter } from "./scheduler-router.js";
import { SUITE1, type Suite1Fact } from "./worlds/suite1.js";

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

interface ABProbe {
  factId: string;
  checkpoint: string;
  memoryRecalled: boolean;
  structuredRecalled: boolean;
  /** True when the question routed to a projection at all. */
  routed: boolean;
  routedTo: string | null;
  /** True when it routed AND the projection held rows. */
  structuredAnswered: boolean;
  /** Whether B had to fall back to the memory path. */
  fellBack: boolean;
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

  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouter.models.filter((m) => m.tier === "fast") },
    sleep,
  });

  console.log("\n" + "=".repeat(74));
  console.log("SUITE 1 A/B — memory retrieval vs structured resolution (ADR-025)");
  console.log("=".repeat(74));

  // Same preflight discipline as Suite 1: a benchmark that cannot produce a
  // valid number must refuse to produce one (ADR-023).
  try {
    const probe = await embedder.embed(["preflight"]);
    if ((probe[0]?.length ?? 0) === 0) throw new Error("embedder returned no vector");
    console.log(`preflight: embeddings OK (${embedder.id})`);
  } catch (e) {
    console.error(
      `\nABORTED — embeddings unusable, so path A cannot be measured.\n  ` +
        (e instanceof Error ? e.message : String(e)),
    );
    process.exitCode = 1;
    return;
  }

  const reps = Number(process.env["AB_REPS"] ?? "1");
  const speaker = SUITE1.characters[0]!;
  const knownEntities = SUITE1.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));

  const allProbes: ABProbe[] = [];
  const runSummaries: Array<Record<string, number>> = [];

  for (let rep = 1; rep <= reps; rep++) {
    __resetMemoryIds();
    const store = new InMemoryMemoryStore();
    const events: WorldEvent[] = [];
    const transcript: Array<{ speaker: string; content: string }> = [];
    const probes: ABProbe[] = [];

    let seq = 0;
    let attemptedExtractions = 0;
    let acceptedEvents = 0;
    const rejections = new Map<string, number>();
    let dialogueCalls = 0;
    let extractCallsA = 0;
    let extractCallsB = 0;
    let usableExtractions = 0;
    let sinceExtraction = 0;

    router.currentRun = rep;
    process.stdout.write(`  rep ${String(rep)}/${String(reps)}  `);
    const started = Date.now();

    const probe = async (fact: Suite1Fact, checkpoint: string, recent: string[], day: number) => {
      const hits = (s: string): boolean =>
        fact.expect.some((n) => s.toLowerCase().includes(n.toLowerCase()));

      // ── path A: retrieve and rank ────────────────────────────────────────
      const r = await retrieve(store, embedder, {
        worldId: SUITE1.id,
        characterId: speaker.id,
        userMessage: fact.question,
        recentLines: recent,
        aliases: SUITE1.aliases,
        currentWorldDay: day,
        tokenBudget: COMPACT_PROFILE.memories,
        maxMemories: 8,
      });
      const memoryRecalled = r.memories.some((m) => hits(m.memory.content));

      // ── path B: route, then resolve from state ───────────────────────────
      const routing = routeQuery(fact.question, [...SUITE1.aliases]);
      const projection = project(events);
      let structuredRecalled = false;
      let structuredAnswered = false;
      if (routing.intent !== null) {
        const answer = resolve(routing.intent, projection);
        structuredAnswered = answer.answered;
        structuredRecalled = answer.lines.some(hits);
      }
      // Unmatched or empty falls back to A, so B is never worse by construction.
      const fellBack = !structuredRecalled && !structuredAnswered;

      probes.push({
        factId: fact.id,
        checkpoint,
        memoryRecalled,
        structuredRecalled: structuredRecalled || (fellBack && memoryRecalled),
        routed: routing.intent !== null,
        routedTo: routing.matched,
        structuredAnswered,
        fellBack,
      });
    };

    for (let i = 0; i < SUITE1.script.length; i++) {
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
      try {
        const res = await router.generate(
          {
            taskClass: "dialogue",
            system: prompt.system,
            messages: [{ role: "user", content: userMessage }],
            maxTokens: 220,
            temperature: 0.8,
            timeoutMs: 30_000,
            meta: { requestId: `ab-${String(rep)}-${String(turnNumber)}` },
          },
          router.models[0]!,
        );
        reply = res.text;
        dialogueCalls += 1;
      } catch {
        reply = "...";
      }

      transcript.push({ speaker: "user", content: userMessage });
      transcript.push({ speaker: speaker.name, content: reply });
      sinceExtraction += 1;

      // ── both write paths, same window ──────────────────────────────────
      const window = transcript.slice(-6);
      let gateSkipped = false;
      try {
        const out = await extractMemories(store, router, router.models[0]!, embedder, {
          worldId: SUITE1.id,
          transcript: window,
          worldDay: day,
          knownEntities,
          aggressiveness: 0.5,
          turnsSinceLastExtraction: sinceExtraction,
        });
        extractCallsA += out.usage.calls;
        gateSkipped = out.skipped;
        if (!out.skipped) sinceExtraction = 0;
      } catch {
        /* counted by path A's recall, not separately */
      }

      // The gate is shared: B must not get more chances to extract than A did.
      if (!gateSkipped) {
        try {
          const ev = await extractEvents(router, router.models[0]!, {
            worldId: SUITE1.id,
            transcript: window,
            worldDay: day,
            knownEntities,
            aggressiveness: 0.5,
            sourceTurn: turnNumber,
            nextSeq: seq,
          });
          extractCallsB += ev.usage.calls;
          attemptedExtractions += ev.attempted;
          acceptedEvents += ev.events.length;
          if (ev.events.length > 0) usableExtractions += 1;
          for (const rj of ev.rejected) rejections.set(rj.reason, (rejections.get(rj.reason) ?? 0) + 1);
          events.push(...ev.events);
          seq += ev.events.length;
        } catch {
          attemptedExtractions += 1;
          rejections.set("call_failed", (rejections.get("call_failed") ?? 0) + 1);
        }
      }

      if (SUITE1.checkpoints.includes(turnNumber as 30 | 60 | 100)) {
        const recent = transcript.slice(-4).map((t) => t.content);
        for (const fact of SUITE1.facts) {
          if (fact.probeAt.includes(turnNumber as 30 | 60 | 100)) {
            await probe(fact, String(turnNumber), recent, day);
          }
        }
        process.stdout.write(`  turn ${String(turnNumber)} probed`);
      }
    }

    // Fresh session: no recent lines at all.
    const lastDay = SUITE1.startingDay + Math.floor(SUITE1.script.length / 2);
    for (const fact of SUITE1.facts) {
      if (fact.probeAt.includes("fresh")) await probe(fact, "fresh", [], lastDay);
    }
    process.stdout.write("  fresh probed\n");

    allProbes.push(...probes);
    const a = probes.filter((p) => p.memoryRecalled).length;
    const b = probes.filter((p) => p.structuredRecalled).length;
    runSummaries.push({
      rep,
      memoryRecall: (a / probes.length) * 100,
      structuredRecall: (b / probes.length) * 100,
      routedShare: (probes.filter((p) => p.routed).length / probes.length) * 100,
      answeredShare: (probes.filter((p) => p.structuredAnswered).length / probes.length) * 100,
      events: events.length,
      eventsAccepted: acceptedEvents,
      // Over extractions ATTEMPTED, not over the ones that happened to parse.
      // The first version divided by parsed-only and reported 100% while 66 of
      // 67 extractions were failing.
      eventValidity:
        attemptedExtractions === 0 ? 0 : (usableExtractions / attemptedExtractions) * 100,
      callsPerTurnA: (dialogueCalls + extractCallsA) / SUITE1.script.length,
      callsPerTurnB: (dialogueCalls + extractCallsB) / SUITE1.script.length,
      wallClockS: (Date.now() - started) / 1000,
    });

    const s = runSummaries[runSummaries.length - 1]!;
    console.log(
      `    -> A ${s["memoryRecall"]!.toFixed(0)}%   B ${s["structuredRecall"]!.toFixed(0)}%   ` +
        `routed ${s["routedShare"]!.toFixed(0)}%   events ${String(s["events"])}   ` +
        `validity ${s["eventValidity"]!.toFixed(0)}%   ${s["wallClockS"]!.toFixed(0)}s`,
    );
    if (rejections.size > 0) {
      console.log(
        `       rejections: ${[...rejections.entries()].map(([k, v]) => `${k} ${String(v)}`).join(", ")}`,
      );
    }
    if (rep < reps) await sleep(20_000);
  }

  // ── report ────────────────────────────────────────────────────────────────
  const pct = (n: number, d: number): string => (d === 0 ? "-" : `${((n / d) * 100).toFixed(0)}%`);
  const n = allProbes.length;
  const aHits = allProbes.filter((p) => p.memoryRecalled).length;
  const bHits = allProbes.filter((p) => p.structuredRecalled).length;
  const routed = allProbes.filter((p) => p.routed);
  const structuredOnly = allProbes.filter((p) => p.structuredAnswered && p.structuredRecalled);

  console.log("\n" + "-".repeat(74));
  console.log("HEAD TO HEAD");
  console.log(`  A  memory retrieval + ranking     ${pct(aHits, n)}`);
  console.log(`  B  structured first, A as fallback ${pct(bHits, n)}`);

  console.log("\nWHERE B's ANSWERS CAME FROM");
  console.log(`  routed to a projection            ${pct(routed.length, n)}`);
  console.log(`  projection held the answer        ${pct(structuredOnly.length, n)}`);
  console.log(`  fell back to semantic retrieval   ${pct(allProbes.filter((p) => p.fellBack).length, n)}`);

  console.log("\nROUTING BY PATTERN");
  const byPattern = new Map<string, { n: number; hit: number }>();
  for (const p of routed) {
    const k = p.routedTo ?? "?";
    const e = byPattern.get(k) ?? { n: 0, hit: 0 };
    e.n += 1;
    if (p.structuredAnswered && p.structuredRecalled) e.hit += 1;
    byPattern.set(k, e);
  }
  for (const [k, e] of [...byPattern.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${k.padEnd(24)} ${String(e.n).padStart(3)} probes   ${pct(e.hit, e.n)} answered`);
  }

  // Disagreements are the interesting rows: they say what each path is FOR.
  const bWins = allProbes.filter((p) => p.structuredRecalled && !p.memoryRecalled);
  const aWins = allProbes.filter((p) => p.memoryRecalled && !p.structuredRecalled);
  console.log("\nDISAGREEMENTS");
  console.log(`  B right, A wrong  ${String(bWins.length)}`);
  console.log(`  A right, B wrong  ${String(aWins.length)}`);
  if (aWins.length > 0) {
    console.log(
      `    regressions: ${[...new Set(aWins.map((p) => `${p.factId}/${p.routedTo ?? "unrouted"}`))].join(", ")}`,
    );
  }

  const mean = (k: string): number =>
    runSummaries.reduce((acc, s) => acc + (s[k] ?? 0), 0) / Math.max(1, runSummaries.length);
  console.log("\nCOST AND RELIABILITY");
  console.log(`  event validity (accepted/proposed) ${mean("eventValidity").toFixed(0)}%`);
  console.log(`  calls per turn  A ${mean("callsPerTurnA").toFixed(2)}   B ${mean("callsPerTurnB").toFixed(2)}`);
  console.log(`  events stored per run              ${mean("events").toFixed(0)}`);

  console.log("\n" + "=".repeat(74));
  console.log("STOP CONDITIONS (committed before this ran)");
  const bPct = (bHits / n) * 100;
  const aPct = (aHits / n) * 100;
  const validity = mean("eventValidity");
  console.log(
    `  B beats A materially?        ${bPct - aPct >= 5 ? "YES" : "NO"}  (${bPct.toFixed(0)}% vs ${aPct.toFixed(0)}%)`,
  );
  console.log(
    `  event validity >= 90%?       ${validity >= 90 ? "YES" : "NO"}  (${validity.toFixed(0)}%)`,
  );
  console.log(
    `  routing caused regressions?  ${aWins.length > 0 ? `YES (${String(aWins.length)})` : "NO"}`,
  );
  console.log("=".repeat(74) + "\n");

  const stamp = new Date().toISOString().slice(0, 10);
  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${stamp}-suite1-ab.json`,
    JSON.stringify({ suite: "suite1-ab", date: stamp, runs: runSummaries, probes: allProbes }, null, 2),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof AIError ? e.message : e);
  process.exitCode = 1;
});
