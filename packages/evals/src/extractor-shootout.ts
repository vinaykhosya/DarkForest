import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import type { AIProvider, ModelDescriptor } from "@darkforest/contracts";
import { eligibleModels } from "@darkforest/core";
import { extractEvents } from "@darkforest/memory";

/**
 * EXTRACTOR SHOOTOUT — which production-eligible model should extract?
 *
 * V1-T19 and V1-T20. The V0.1 acceptance test passes 6 of 9, and every failure
 * is the same step: the player states a durable fact, and extraction returns
 * valid JSON with an empty array. Both failures that logged a model were
 * gpt-oss-20b. That is a correlation over two data points, which is a
 * hypothesis, not a finding.
 *
 * So this pins each eligible model in turn and runs the SAME fixtures against
 * each. Three things make it a comparison rather than another anecdote:
 *
 *  1. THE SCHEDULER IS BYPASSED. It ignores the model argument by design and
 *     chooses by capacity, so a run through it cannot attribute a result to a
 *     model. Each provider adapter is called directly, with the model pinned.
 *
 *  2. THE INPUT IS HELD CONSTANT. The character's reply is FIXED rather than
 *     generated. The gate's flakiness had a varying reply in it, and comparing
 *     models across varying inputs measures the inputs.
 *
 *  3. ELIGIBILITY IS COMPUTED, NOT ASSUMED. The candidate set comes from
 *     `eligibleModels` with the PRODUCT's intent — real user content, standard
 *     pool. A model that cannot legally carry a private roleplay is not a
 *     candidate however well it extracts, so it is not on the list.
 *
 * NO FIX IS IMPLEMENTED HERE. This establishes whether a routing change would
 * help before one is written.
 */

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
const REPS = Number(process.env["SHOOTOUT_REPS"] ?? "4");

/**
 * First-mention fixtures: a player states something for the first time, and a
 * character answers. Each `expect` is whether a durable fact is present at all,
 * not which type it should be — the question here is capture, not taxonomy.
 */
const FIXTURES: ReadonlyArray<{
  id: string;
  shape: string;
  player: string;
  reply: string;
  expect: boolean;
}> = [
  {
    id: "F1",
    shape: "inability (the gate fixture)",
    player: "I have to tell you something. I can't swim. I never learned.",
    reply: "The sea doesn't care. You keep your feet on the sand and your mouth shut.",
    expect: true,
  },
  {
    id: "F2",
    shape: "promise",
    player: "I promise you I'll be back before sunset.",
    reply: "Words are cheap in Saltmarsh. I'll be at the wall.",
    expect: true,
  },
  {
    id: "F3",
    shape: "acquisition",
    /*
     * CHANGED 2026-09-06, and the direction matters. The original was "I bought
     * a coil of rope from Odell this morning", which shares EIGHT consecutive
     * words with the v1 prompt's worked example for `acquired`. F3 scored 4/4
     * on both models and that result is withdrawn — it measured recall of an
     * example.
     *
     * The FIXTURE moved rather than the prompt, because here the prompt example
     * came first and the fixture was copied from it. Where a prompt example is
     * added that collides with an existing fixture, the prompt moves instead:
     * the rule is that whichever one borrowed is the one that gives way.
     */
    player: "I traded my father's compass for a lantern at the market.",
    reply: "A poor trade. Lanterns are common here.",
    expect: true,
  },
  {
    id: "F4",
    shape: "condition",
    player: "I don't see well in the dark. Never have.",
    reply: "Then stay in before dusk. The lanes here aren't kind.",
    expect: true,
  },
  {
    id: "F5",
    shape: "identity (a known gap)",
    player: "My name is Cass. Everyone here has been calling me the traveller.",
    reply: "Cass, then. It suits you better than traveller.",
    expect: true,
  },
  {
    /*
     * THE FALSE-POSITIVE CONTROL, and the reason this is not just a capture
     * score. A model that extracts everything scores 5/5 above and fills the
     * world with noise. Nothing here is durable, so an event is a FAILURE.
     */
    id: "N1",
    shape: "nothing durable (must stay empty)",
    player: "Morning. Cold one today, isn't it?",
    reply: "It always is. Mind the ice on the boards.",
    expect: false,
  },
];

interface Score {
  model: string;
  provider: string;
  captured: number;
  capturable: number;
  falsePositives: number;
  noiseTrials: number;
  errors: number;
  perFixture: Map<string, number>;
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
  });

  const adapters: Array<{ provider: AIProvider; models: readonly ModelDescriptor[] }> = [
    { provider: groq, models: groq.models },
    { provider: openrouter, models: openrouter.models },
  ];

  /*
   * The PRODUCT's intent, not the harness's. `environment: "local"` because
   * that is where this runs, but `isSyntheticContent: false` is the deciding
   * value: these are the models that may carry a real person's words.
   */
  const intent = { pool: "standard" as const, environment: "local" as const, isSyntheticContent: false };

  const candidates: Array<{ provider: AIProvider; model: ModelDescriptor }> = [];
  const excluded: string[] = [];
  for (const { provider, models } of adapters) {
    const ok = new Set(eligibleModels(models, intent).map((m) => m.id));
    for (const m of models) {
      if (!ok.has(m.id)) {
        excluded.push(`${m.id} — not eligible for real user content`);
        continue;
      }
      // No optional chain: the field is required now (ADR-031), and an empty
      // array is the honest "not measured yet".
      if (!m.verifiedTaskClasses.includes("extract")) {
        excluded.push(`${m.id} — not verified for 'extract' (ADR-022)`);
        continue;
      }
      candidates.push({ provider, model: m });
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("EXTRACTOR SHOOTOUT — same fixtures, one model at a time");
  console.log("=".repeat(78));
  console.log(`\n  CANDIDATES (eligible for real content AND verified for extract):`);
  for (const c of candidates) console.log(`    ${c.model.id}   [${c.provider.id}]`);
  console.log(`\n  EXCLUDED:`);
  for (const e of excluded) console.log(`    ${e}`);
  console.log(
    `\n  ${String(FIXTURES.length)} fixtures x ${String(REPS)} reps, ` +
      `input held constant, scheduler bypassed\n`,
  );

  if (candidates.length === 0) {
    console.log("  Nothing to compare.\n");
    return;
  }

  const scores: Score[] = [];

  for (const { provider, model } of candidates) {
    const score: Score = {
      model: model.id,
      provider: provider.id,
      captured: 0,
      capturable: 0,
      falsePositives: 0,
      noiseTrials: 0,
      errors: 0,
      perFixture: new Map(),
    };

    console.log(`  ${model.id}`);
    for (const f of FIXTURES) {
      let hits = 0;
      for (let rep = 0; rep < REPS; rep++) {
        await sleep(4500);
        try {
          const out = await extractEvents(provider, model, {
            worldId: "shootout",
            transcript: [
              { speaker: "the user", content: f.player },
              { speaker: "Elena", content: f.reply },
            ],
            knownEntities: [
              { ref: "narrator", name: "the user" },
              { ref: "character:1", name: "Elena" },
            ],
            aggressiveness: 0.5,
            sourceTurn: 0,
            nextSeq: 0,
            worldDay: 1,
          });
          const got = out.events.length > 0;
          if (got) hits += 1;
          if (f.expect) {
            score.capturable += 1;
            if (got) score.captured += 1;
          } else {
            score.noiseTrials += 1;
            if (got) score.falsePositives += 1;
          }
          process.stdout.write(got === f.expect ? "+" : "!");
        } catch {
          score.errors += 1;
          process.stdout.write("x");
        }
      }
      score.perFixture.set(f.id, hits);
      process.stdout.write(" ");
    }
    console.log(
      `\n     capture ${String(score.captured)}/${String(score.capturable)} · ` +
        `false positives ${String(score.falsePositives)}/${String(score.noiseTrials)} · ` +
        `errors ${String(score.errors)}\n`,
    );
    scores.push(score);
  }

  console.log("-".repeat(78));
  console.log("  BY FIXTURE (captured / " + String(REPS) + ")\n");
  const header = FIXTURES.map((f) => f.id.padStart(4)).join("");
  console.log(`    ${"".padEnd(34)}${header}`);
  for (const s of scores) {
    const cells = FIXTURES.map((f) => String(s.perFixture.get(f.id) ?? 0).padStart(4)).join("");
    console.log(`    ${s.model.padEnd(34)}${cells}`);
  }

  console.log("\n" + "=".repeat(78));
  for (const s of scores) {
    const rate = s.capturable === 0 ? 0 : (s.captured / s.capturable) * 100;
    console.log(
      `  ${s.model.padEnd(34)} capture ${rate.toFixed(0).padStart(3)}%  ` +
        `noise ${String(s.falsePositives)}/${String(s.noiseTrials)}`,
    );
  }
  console.log(
    "\n  Read capture and noise TOGETHER. A model that extracts everything wins\n" +
      "  on capture and fills the world with things nobody said. The decision is\n" +
      "  a routing one only if the difference is large and the noise is not.\n",
  );
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
