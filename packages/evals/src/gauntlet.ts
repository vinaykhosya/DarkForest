/**
 * THE GAUNTLET — the final gate before the memory architecture freezes.
 *
 * Not Suite 1.5. Suite 1 plants twenty labelled facts and asks for them back,
 * which measures extraction and retrieval of isolated statements. It cannot
 * measure the things a persistent world is actually made of: an object that
 * changes hands three times, a secret told to exactly one person, a lie that
 * contradicts what the player witnessed, a boundary that must hold for the rest
 * of the relationship.
 *
 * Two worlds, eleven dimensions, nineteen probes. Facts arrive through normal
 * play, roughly half of every script is mundane, nothing is probed at the turn
 * it happens, and several probes assert what must NOT come back — a leak is
 * worse than a miss, because it means a character knows something nobody told
 * them.
 *
 * PIPELINE PER PROBE
 *   events (this world, this far)
 *     -> filtered to what askedOf actually knows (knownBy, or empty = public)
 *     -> rendered as plain lines
 *     -> a small in-character generation, answering ONLY from those lines
 *     -> checked against expect/forbid with the frozen contract matcher
 *
 * This tests the full path a real turn would take — extraction, knowledge
 * filtering, and a character actually answering — not retrieval in isolation.
 * `structural` results (the filtered event set alone, before generation) are
 * recorded alongside `answered` results so a generation failure can be told
 * apart from an extraction failure.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import type { WorldEvent } from "@darkforest/contracts";
import { PLAYER, project, recallableBy, resolve, routeQuery } from "@darkforest/core";
import { extractEvents } from "@darkforest/memory";
import { capturesFact, type PlantedFact } from "./contract/evaluation-contract.js";
import { SchedulerRouter } from "./scheduler-router.js";
import { GAUNTLET_WORLDS, type GauntletProbe, type GauntletWorld } from "./worlds/gauntlet.js";

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
/*
 * 4500ms, not 2800.
 *
 * The paced-vs-contended experiment measured format failures at 29% with 1200ms
 * spacing and 20% at 4000ms, and the fact-turn probe found ZERO pathological
 * output when each call stood alone. This is the gate run, so it is paced past
 * the point where load is a plausible explanation for anything it reports —
 * a contaminated gate result is worse than a slow one.
 */
const DELAY = 4500;

/** A stock in-world acknowledgement. Static, so the transcript never leaks new facts. */
function ackFor(turn: string, world: GauntletWorld): { speaker: string; content: string } {
  const lower = turn.toLowerCase();
  const named = world.characters.find((c) => lower.includes(c.name.toLowerCase()));
  const speaker = named?.name ?? world.characters[0]!.name;
  return { speaker, content: `${speaker} takes it in and says little.` };
}

function windowFor(world: GauntletWorld, turnIndex: number): Array<{ speaker: string; content: string }> {
  const out: Array<{ speaker: string; content: string }> = [];
  for (let i = Math.max(0, turnIndex - 2); i <= turnIndex; i++) {
    out.push({ speaker: "user", content: world.script[i]! });
    out.push(ackFor(world.script[i]!, world));
  }
  return out.slice(-6);
}

/*
 * There is deliberately NO local knowledge rule here any more.
 *
 * The first run had one, and it disagreed with the projection's: an empty
 * audience meant "public" here and "the observer only" there. The player saw a
 * sealed door and told exactly one person; asked what she knew about that
 * cellar, a character who was never told described the door. One rule with two
 * implementations is what caused it, so this file now imports the only one.
 */

/** A plain-language line for one event, for feeding a character's own recollection. */
function renderLine(e: WorldEvent): string {
  switch (e.type) {
    case "acquired":
      return `${e.actor} acquired ${e.object ?? "something"}.`;
    case "gave":
      return `${e.actor} gave ${e.object ?? "something"} to ${e.target ?? "someone"}.`;
    case "lost":
      return `${e.actor} lost ${e.object ?? "something"}.`;
    case "promised":
      return `${e.actor} promised ${e.target ?? "someone"}: ${e.value ?? ""}`;
    case "refused":
      return `${e.actor} refused: ${e.value ?? ""}`;
    case "fulfilled":
      return `${e.actor} fulfilled a promise: ${e.value ?? ""}`;
    case "asked":
      return `${e.actor} asked ${e.target ?? "someone"} about: ${e.value ?? ""}`;
    case "answered":
      return `An earlier question was answered: ${e.value ?? ""}`;
    case "revealed":
      return `${e.actor} revealed to ${e.target ?? "someone"}: ${e.value ?? ""}`;
    case "observed":
      return `${e.actor} personally observed: ${e.value ?? e.object ?? ""}`;
    case "relation_stated":
    case "relation_changed":
      return `${e.actor}'s standing with ${e.target ?? "someone"}: ${e.value ?? ""}`;
    case "preference_stated":
      return `${e.actor} feels this way about ${e.object ?? "something"}: ${e.value ?? ""}`;
    case "numeric_stated":
      return `${e.object ?? "a count"}: ${String(e.quantity ?? "")}`;
    case "world_event":
      return e.value ?? e.object ?? "";
  }
}

interface ProbeResult {
  probe: GauntletProbe;
  world: string;
  structuralCaptured: boolean;
  structuralLeak: boolean;
  answered: string;
  answerCaptured: boolean;
  answerLeak: boolean;
  /** A forbidden-in-answer term surfaced. Quality, never a boundary breach. */
  answerNoisy: boolean;
  /** Present only on a leak or a structural miss. See the comment at the call site. */
  knownEvents?: Array<{
    type: string;
    actor: string;
    target: string | null;
    value: string | null;
    knownBy: readonly string[];
    sourceTurn: number;
  }>;
  /** Stage-by-stage trace. The first `false` is where the fact was lost. */
  layers: {
    extracted: boolean;
    audience: boolean;
    /** The question routed to a projection at all. */
    projected: boolean;
    /** The resolver actually returned the fact. */
    routed: boolean;
    routedTo: string | null;
    inContext: boolean;
  };
  knownEventCount: number;
}

async function answerAsCharacter(
  router: SchedulerRouter,
  world: GauntletWorld,
  probe: GauntletProbe,
  lines: readonly string[],
): Promise<string> {
  const character = world.characters.find((c) => c.name.toLowerCase() === probe.askedOf.toLowerCase());
  const persona = character?.persona ?? "";
  const speaker =
    probe.perspective === "player"
      ? "the world's own record, answering the player about their history"
      : `${probe.askedOf}. ${persona}`;

  const system = [
    `You are ${speaker}`,
    `Answer only from what you personally know, listed below. If it is not`,
    `listed, you do not know it — say so plainly rather than guessing or`,
    `inventing. Stay brief and in character. Never mention "events" or "logs".`,
    ``,
    `WHAT YOU KNOW`,
    lines.length > 0 ? lines.map((l) => `- ${l}`).join("\n") : "(nothing relevant)",
  ].join("\n");

  try {
    const res = await router.generate(
      {
        taskClass: "dialogue",
        system,
        messages: [{ role: "user", content: probe.question }],
        maxTokens: 150,
        temperature: 0.3,
        timeoutMs: 30_000,
        meta: { requestId: `gauntlet-${probe.id}` },
      },
      router.models[0]!,
    );
    return res.text;
  } catch (e) {
    return `[call failed: ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}]`;
  }
}

async function runWorld(router: SchedulerRouter, world: GauntletWorld): Promise<ProbeResult[]> {
  const knownEntities = world.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name }));
  const probesByTurn = new Map<number, GauntletProbe[]>();
  for (const p of world.probes) {
    const arr = probesByTurn.get(p.at) ?? [];
    arr.push(p);
    probesByTurn.set(p.at, arr);
  }

  const events: WorldEvent[] = [];
  let seq = 0;
  const results: ProbeResult[] = [];

  console.log(`\n${"=".repeat(78)}\n${world.name.toUpperCase()}\n${"=".repeat(78)}`);
  process.stdout.write("  extracting  ");

  for (let i = 0; i < world.script.length; i++) {
    if (i > 0) await sleep(DELAY);
    const day = world.startingDay + Math.floor(i / 2);
    router.currentTurn = i + 1;
    try {
      const ev = await extractEvents(router, router.models[0]!, {
        worldId: world.id,
        transcript: windowFor(world, i),
        worldDay: day,
        knownEntities,
        aggressiveness: 0.6,
        sourceTurn: i + 1,
        nextSeq: seq,
      });
      events.push(...ev.events);
      seq += ev.events.length;
      process.stdout.write(ev.events.length > 0 ? "o" : ".");
    } catch {
      process.stdout.write("x");
    }

    const due = probesByTurn.get(i);
    if (due !== undefined) {
      for (const probe of due) {
        await sleep(DELAY);
        /*
         * Player perspective reads the player's own life; character perspective
         * reads only what that character was told or witnessed. Conflating them
         * marked three CORRECT refusals as failures in the first run — asking
         * Elena what the player told Sera, when Elena was not there.
         */
        const viewer = probe.perspective === "player" ? PLAYER : probe.askedOf;
        const known = recallableBy(events, viewer);
        const asFacts: PlantedFact = {
          id: probe.id,
          plantedAt: 0,
          kind: probe.dimension,
          expect: probe.expect,
        };
        const structuralCaptured = probe.expect.length === 0 ? true : capturesFact(known, asFacts);

        /*
         * WHERE A MISS HAPPENED, stage by stage.
         *
         * "Structural miss" is as undifferentiated as "not retrieved" was before
         * the retrieval funnel, and it hides four different bugs with four
         * different fixes. Each stage below can only fail if the one above it
         * succeeded, so the first false is the culprit.
         *
         *   extracted   the event was never written        -> extraction
         *   audience    written, but this viewer cannot see it -> isolation too tight
         *   projected   visible, but the fold lost it      -> projection
         *   routed      folded, but the resolver missed it -> query routing
         *   inContext   resolved, but never reached the model -> context builder
         */
        const inAnyEvent = probe.expect.length === 0 || capturesFact(events, asFacts);
        const inAudience = probe.expect.length === 0 || capturesFact(known, asFacts);
        const projection = project(known);
        const routing = routeQuery(probe.question, [...world.aliases]);
        const resolved =
          routing.intent === null ? [] : resolve(routing.intent, projection).lines;
        const inResolved =
          probe.expect.length === 0
            ? true
            : resolved.some((l) =>
                probe.expect.some((t) => l.toLowerCase().includes(t.toLowerCase())),
              );

        /*
         * A LEAK is only ever a forbidKnown hit. `forbidInAnswer` marks a
         * quality problem — a detail the viewer may legitimately know but that
         * should not crowd out the answer.
         *
         * One field previously meant both, and it manufactured two false leaks:
         * the player legitimately remembers both what they saw AND what they
         * lied about, so forbidding the lie structurally flagged correct memory
         * as a breach. A gate whose headline metric is "zero leaks" cannot
         * afford to invent them.
         */
        const structuralLeak =
          (probe.forbidKnown?.length ?? 0) > 0 &&
          capturesFact(known, { ...asFacts, expect: probe.forbidKnown ?? [] });

        const lines = known.map(renderLine).filter((l) => l.trim().length > 0);
        const inContext =
          probe.expect.length === 0
            ? true
            : lines.some((l) => probe.expect.some((t) => l.toLowerCase().includes(t.toLowerCase())));
        const answer = await answerAsCharacter(router, world, probe, lines);
        const lowerAnswer = answer.toLowerCase();
        const answerCaptured =
          probe.expect.length === 0 ? true : probe.expect.some((t) => lowerAnswer.includes(t.toLowerCase()));
        const answerLeak =
          (probe.forbidKnown?.length ?? 0) > 0 &&
          (probe.forbidKnown ?? []).some((t) => lowerAnswer.includes(t.toLowerCase()));
        // Not a leak. Recorded separately so noise is visible without inflating
        // the number the freeze decision turns on.
        const answerNoisy =
          (probe.forbidInAnswer?.length ?? 0) > 0 &&
          (probe.forbidInAnswer ?? []).some((t) => lowerAnswer.includes(t.toLowerCase()));

        results.push({
          probe,
          world: world.name,
          structuralCaptured,
          structuralLeak,
          answered: answer,
          answerCaptured,
          answerLeak,
          answerNoisy,
          /*
           * The viewer's whole recallable set, saved only when something went
           * wrong. Run B leaked and run A did not, on identical isolation code,
           * and the focused probe could not reproduce it — 0 of 7 events reached
           * the wrong character. Without the actual events there was nothing to
           * examine, so the next occurrence is evidence rather than another
           * round of guessing.
           */
          ...(structuralLeak || answerLeak || !structuralCaptured
            ? {
                knownEvents: known.map((e) => ({
                  type: e.type,
                  actor: e.actor,
                  target: e.target,
                  value: e.value ?? e.object,
                  knownBy: e.knownBy,
                  sourceTurn: e.sourceTurn,
                })),
              }
            : {}),
          layers: {
            extracted: inAnyEvent,
            audience: inAudience,
            projected: routing.intent !== null,
            routed: inResolved,
            routedTo: routing.matched,
            inContext,
          },
          knownEventCount: known.length,
        });
      }
    }
  }
  console.log("");
  return results;
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

  console.log("\n" + "#".repeat(78));
  console.log("THE GAUNTLET — final gate before the memory architecture freezes");
  console.log("#".repeat(78));
  console.log(
    `  ${String(GAUNTLET_WORLDS.length)} worlds, ${String(
      GAUNTLET_WORLDS.reduce((a, w) => a + w.probes.length, 0),
    )} probes, ${String(GAUNTLET_WORLDS.reduce((a, w) => a + w.script.length, 0))} turns total\n` +
      `  legend  o event extracted   . correctly quiet   x extraction failed\n`,
  );

  const all: ProbeResult[] = [];
  for (const world of GAUNTLET_WORLDS) {
    all.push(...(await runWorld(router, world)));
    if (world !== GAUNTLET_WORLDS[GAUNTLET_WORLDS.length - 1]) {
      console.log("  [cooldown] 30s between worlds");
      await sleep(30_000);
    }
  }

  // ── per-probe ────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(78));
  console.log("PER PROBE");
  for (const r of all) {
    const structOk = r.structuralCaptured && !r.structuralLeak;
    const ansOk = r.answerCaptured && !r.answerLeak;
    const mark = ansOk ? " " : structOk ? "~" : "X";
    console.log(
      `  ${mark} ${r.probe.id.padEnd(20)} ${r.probe.dimension.padEnd(13)} ` +
        `struct=${structOk ? "ok" : r.structuralLeak ? "LEAK" : "miss"}  ` +
        `answer=${ansOk ? "ok" : r.answerLeak ? "LEAK" : "miss"}  known=${String(r.knownEventCount)}`,
    );
    if (!ansOk) {
      console.log(`      Q: ${r.probe.question}`);
      console.log(`      A: ${r.answered.slice(0, 140)}`);
      console.log(`      why it matters: ${r.probe.why}`);
    }
  }

  // ── by dimension ─────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(78));
  console.log("BY DIMENSION");
  const byDim = new Map<string, { n: number; struct: number; answer: number; leaks: number }>();
  for (const r of all) {
    const e = byDim.get(r.probe.dimension) ?? { n: 0, struct: 0, answer: 0, leaks: 0 };
    e.n += 1;
    if (r.structuralCaptured && !r.structuralLeak) e.struct += 1;
    if (r.answerCaptured && !r.answerLeak) e.answer += 1;
    if (r.structuralLeak || r.answerLeak) e.leaks += 1;
    byDim.set(r.probe.dimension, e);
  }
  for (const [dim, e] of [...byDim.entries()].sort()) {
    console.log(
      `  ${dim.padEnd(14)} n=${String(e.n)}   structural ${((e.struct / e.n) * 100).toFixed(0)}%   ` +
        `end-to-end ${((e.answer / e.n) * 100).toFixed(0)}%   leaks ${String(e.leaks)}`,
    );
  }

  // ── the sharpest instrument: leaks ───────────────────────────────────────
  const leaks = all.filter((r) => r.structuralLeak || r.answerLeak);
  console.log("\n" + "-".repeat(78));
  console.log(`KNOWLEDGE ISOLATION — ${String(leaks.length)} leak(s) of ${String(all.filter((r) => (r.probe.forbidKnown?.length ?? 0) > 0).length)} guarded probes`);
  for (const l of leaks) {
    console.log(`  LEAK  ${l.probe.id}  ${l.probe.question}`);
    console.log(`        answered: ${l.answered.slice(0, 140)}`);
  }
  if (leaks.length === 0) console.log("  none — every guarded probe held.");

  /*
   * Noise is reported apart from leaks on purpose. The freeze turns on "zero
   * knowledge leaks", so anything that is not a boundary breach must not be
   * counted as one — otherwise the gate is measuring answer quality while
   * claiming to measure security.
   */
  const noisy = all.filter((r) => r.answerNoisy);
  console.log(
    `
ANSWER NOISE — ${String(noisy.length)} of ` +
      `${String(all.filter((r) => (r.probe.forbidInAnswer?.length ?? 0) > 0).length)} checked ` +
      `(legitimately known, but crowding out the answer — quality, not a breach)`,
  );
  for (const nz of noisy) console.log(`  noisy  ${nz.probe.id}  ${nz.probe.question}`);

  // ── where structural misses were lost ────────────────────────────────────
  const structMisses = all.filter((r) => !r.structuralCaptured);
  console.log("\n" + "-".repeat(78));
  console.log(`WHERE STRUCTURAL MISSES WERE LOST — ${String(structMisses.length)} probe(s)`);
  if (structMisses.length === 0) console.log("  none");
  for (const m of structMisses) {{
    const L = m.layers;
    const stage = !L.extracted
      ? "EXTRACTION   the event was never written"
      : !L.audience
        ? "ISOLATION    written, but this viewer cannot see it (too tight)"
        : !L.projected
          ? `ROUTING      no projection matched the question (routedTo=${L.routedTo ?? "none"}})`
          : !L.routed
            ? "PROJECTION   routed, but the fold or resolver did not surface it"
            : !L.inContext
              ? "CONTEXT      resolved, but never reached the model"
              : "UNKNOWN      every stage reports success";
    console.log(`  ${m.probe.id.padEnd(22)} ${m.probe.dimension.padEnd(14)} ${stage}`);
    console.log(`      Q: ${m.probe.question}`);
  }}

  // ── verdict ──────────────────────────────────────────────────────────────
  const total = all.length;
  const endToEnd = all.filter((r) => r.answerCaptured && !r.answerLeak).length;
  const structural = all.filter((r) => r.structuralCaptured && !r.structuralLeak).length;
  /*
   * THREE LAYERS, JUDGED SEPARATELY.
   *
   * One score conflates failures with different fixes, and this run proved it:
   * end-to-end sat at 42% on both depleted and fresh quota while structural
   * moved 74% -> 84%, because most of the gap was a token-budget bug in dialogue
   * generation rather than anything about memory.
   */
  const truthLayer = all.filter((r) => r.structuralCaptured).length;
  const knowledgeLayer = all.filter((r) => !r.structuralLeak && !r.answerLeak).length;
  const expressionBase = all.filter((r) => r.structuralCaptured).length;
  const expressionLayer = all.filter((r) => r.structuralCaptured && r.answerCaptured).length;
  console.log("\n" + "-".repeat(78));
  console.log("THE THREE LAYERS");
  console.log(
    `  TRUTH       ${String(truthLayer)}/${String(all.length)} — events, projections and state are correct`,
  );
  console.log(
    `  KNOWLEDGE   ${String(knowledgeLayer)}/${String(all.length)} — nobody knows what they were not told`,
  );
  console.log(
    `  EXPRESSION  ${String(expressionLayer)}/${String(expressionBase)} — of what the character KNEW, ` +
      `how much they actually said`,
  );

  console.log("\n" + "#".repeat(78));
  console.log(
    `  structural (extraction+isolation, no generation)  ${String(structural)}/${String(total)} (${((structural / total) * 100).toFixed(0)}%)`,
  );
  console.log(`  end-to-end (what a player would actually see)    ${String(endToEnd)}/${String(total)} (${((endToEnd / total) * 100).toFixed(0)}%)`);
  console.log(
    leaks.length > 0
      ? "  -> DO NOT FREEZE. Any knowledge leak is disqualifying regardless of the\n" +
          "     recall percentage — it means characters are one narrator wearing\n" +
          "     several names, which is the specific failure this gate exists to catch."
      : endToEnd / total >= 0.8
        ? "  -> PASS. Structured state, history, isolation and perception all hold\n" +
          "     end-to-end. Freeze the architecture."
        : "  -> BELOW BAR. No leaks, but end-to-end recall is not yet reliable enough\n" +
          "     to freeze. Read which dimension is weak above before changing anything.",
  );
  console.log("#".repeat(78) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-gauntlet.json`,
    JSON.stringify(all, null, 2),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
