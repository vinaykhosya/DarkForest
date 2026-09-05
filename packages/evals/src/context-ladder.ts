/**
 * CONTEXT LADDER — is the blind spot semantic, or does context suppress it?
 *
 * Rewriting the selection prompt did not work. v2 broadened the wording and
 * captured FEWER facts (10/20 against v1's 17/20), losing whole categories, so
 * the gate is not simply too conservatively phrased. f12 and f13 survived both
 * framings, including worked examples built to match them.
 *
 * So stop asking how to persuade the model and ask where the failure lives. The
 * same fact is extracted at four context sizes:
 *
 *   L0  the fact turn alone
 *   L1  the fact turn plus the reply it drew
 *   L2  one prior exchange as well
 *   L3  the full six-turn window the benchmark uses
 *
 *   fails at L0                  -> semantic: the model cannot classify this
 *   succeeds at L0, fails at L3  -> context suppresses it
 *   controls degrade too         -> a general context effect, not fact-specific
 *
 * CONTROLS MATTER MORE THAN THE SUSPECTS HERE. f19 is the one to watch: it is
 * also a world_event and it captures every time, while f12 - same type, same
 * schema, same machinery - never does. If f19 holds across the ladder while f12
 * fails at every rung, the difference is in the sentence, not the pipeline.
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
const DELAY = 6000;

/**
 * Suspects and controls.
 *
 * f19 against f12 is the sharpest pair available: identical event type, one
 * always captured and one never. f02/f04/f09 cover the categories v1 handles
 * reliably, so a general context effect would show up in them too.
 */
const SUSPECTS = ["f12", "f13", "f15"];
const CONTROLS = ["f19", "f02", "f04", "f09"];

/** The grammatical shape of the sentence, for the blind-spot matrix. */
const FORM: Record<string, string> = {
  f02: "I promise X",
  f04: "I admit I owe X",
  f09: "I buy X from Y",
  f12: "I see X",
  f13: "X saved my life",
  f15: "I discover X",
  f19: "X was named Y",
};

function windowAt(turnIndex: number, level: number): Array<{ speaker: string; content: string }> {
  const speaker = SUITE1.characters[0]!.name;
  const line = (i: number): Array<{ speaker: string; content: string }> => [
    { speaker: "user", content: SUITE1.script[i]! },
    { speaker, content: ACK },
  ];
  if (level === 0) return [{ speaker: "user", content: SUITE1.script[turnIndex]! }];
  if (level === 1) return line(turnIndex);
  if (level === 2) return [...(turnIndex >= 1 ? line(turnIndex - 1) : []), ...line(turnIndex)];
  const out: Array<{ speaker: string; content: string }> = [];
  for (let i = Math.max(0, turnIndex - 2); i <= turnIndex; i++) out.push(...line(i));
  return out.slice(-6);
}

const LEVELS = [
  { level: 0, label: "L0 turn alone" },
  { level: 1, label: "L1 + reply" },
  { level: 2, label: "L2 + 1 prior" },
  { level: 3, label: "L3 full window" },
] as const;

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
  const REPS = Number(process.env["LADDER_REPS"] ?? "2");
  const ids = [...SUSPECTS, ...CONTROLS];
  const facts = ids
    .map((id) => SUITE1.facts.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);

  console.log("\n" + "=".repeat(80));
  console.log("CONTEXT LADDER — same fact, four context sizes");
  console.log("=".repeat(80));
  console.log(
    `  ${String(facts.length)} facts x ${String(LEVELS.length)} levels x ${String(REPS)} reps, ` +
      `${String(DELAY)}ms apart\n`,
  );

  /** factId -> level -> captures */
  const grid = new Map<string, Map<number, number>>();
  const emitted = new Map<string, string[]>();

  for (const fact of facts) {
    const row = new Map<number, number>();
    process.stdout.write(`  ${fact.id} ${(FORM[fact.id] ?? "").padEnd(18)} `);
    for (const { level } of LEVELS) {
      let hits = 0;
      for (let rep = 0; rep < REPS; rep++) {
        await sleep(DELAY);
        router.currentTurn = fact.plantedAt + 1;
        try {
          const ev = await extractEvents(router, router.models[0]!, {
            worldId: SUITE1.id,
            transcript: windowAt(fact.plantedAt, level),
            worldDay: SUITE1.startingDay + Math.floor(fact.plantedAt / 2),
            knownEntities,
            aggressiveness: 0.5,
            sourceTurn: fact.plantedAt + 1,
            nextSeq: 0,
          });
          if (
            capturesFact(ev.events, {
              id: fact.id,
              plantedAt: fact.plantedAt,
              kind: fact.kind,
              expect: fact.expect,
            })
          ) {
            hits += 1;
          }
          // What it emitted instead is the diagnostic when it missed.
          if (level === 0 && ev.events.length > 0) {
            const seen = emitted.get(fact.id) ?? [];
            for (const e of ev.events) seen.push(`${e.type}:${e.value ?? e.object ?? ""}`.slice(0, 52));
            emitted.set(fact.id, seen);
          }
        } catch {
          /* counted as a miss; call failures are visible in the totals */
        }
      }
      row.set(level, hits);
      process.stdout.write(` ${String(hits)}/${String(REPS)}`);
    }
    grid.set(fact.id, row);
    console.log("");
  }

  console.log("\n" + "-".repeat(80));
  console.log(
    `${"FACT".padEnd(6)}${"FORM".padEnd(20)}` + LEVELS.map((l) => l.label.padStart(16)).join(""),
  );
  const pct = (n: number): string => `${((n / REPS) * 100).toFixed(0)}%`;
  for (const group of [SUSPECTS, CONTROLS]) {
    console.log(group === SUSPECTS ? "  -- suspects --" : "  -- controls --");
    for (const id of group) {
      const row = grid.get(id);
      if (row === undefined) continue;
      console.log(
        id.padEnd(6) +
          (FORM[id] ?? "").padEnd(20) +
          LEVELS.map((l) => pct(row.get(l.level) ?? 0).padStart(16)).join(""),
      );
    }
  }

  console.log("\nWHAT THE SUSPECTS PRODUCED INSTEAD, AT L0");
  for (const id of SUSPECTS) {
    const seen = emitted.get(id);
    console.log(`  ${id}  ${seen === undefined || seen.length === 0 ? "(no events at all)" : seen.join(" | ")}`);
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  const at = (ids2: string[], level: number): number =>
    ids2.reduce((a, id) => a + (grid.get(id)?.get(level) ?? 0), 0) / (ids2.length * REPS);
  const sL0 = at(SUSPECTS, 0);
  const sL3 = at(SUSPECTS, 3);
  const cL0 = at(CONTROLS, 0);
  const cL3 = at(CONTROLS, 3);

  console.log("\n" + "=".repeat(80));
  console.log(
    `  suspects  L0 ${(sL0 * 100).toFixed(0)}%  ->  L3 ${(sL3 * 100).toFixed(0)}%` +
      `      controls  L0 ${(cL0 * 100).toFixed(0)}%  ->  L3 ${(cL3 * 100).toFixed(0)}%`,
  );
  console.log(
    sL0 < 0.34
      ? "  -> SEMANTIC. The suspects fail even alone, with nothing to distract the\n" +
          "     model. Context is not the cause and no window change will fix it."
      : sL0 >= 0.67 && sL3 < 0.34 && cL3 >= 0.67
        ? "  -> CONTEXT SUPPRESSION. The suspects are extractable alone and lost in\n" +
          "     the window, while controls survive it. The window is the suspect."
        : cL3 < 0.67
          ? "  -> GENERAL CONTEXT EFFECT. Controls degrade too, so this is not specific\n" +
            "     to these facts and the window hurts everything."
          : "  -> MIXED. Neither reading is carried at this sample size.",
  );
  console.log("=".repeat(80) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-context-ladder.json`,
    JSON.stringify(
      [...grid.entries()].map(([id, row]) => ({
        id,
        form: FORM[id],
        levels: [...row],
        emittedAtL0: emitted.get(id) ?? [],
      })),
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
