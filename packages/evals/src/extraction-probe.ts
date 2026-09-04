/**
 * EXTRACTION COMPETENCE PROBE.
 *
 * Suite 1 dropped 19 extractions once the scheduler began spreading load across
 * all four Groq models, where the previous wiring had pinned one. The scheduler
 * treats those models as interchangeable because each DECLARES
 * `supportsStructuredOutput`. This measures whether that declaration is true in
 * practice, per model, on the real extraction prompt.
 *
 * Declared capability is a vendor's claim. This is the check.
 */

import { readFileSync } from "node:fs";
import type { WorldId } from "@darkforest/contracts";
import { CredentialRegistry, GroqProvider } from "@darkforest/ai";
import { InMemoryMemoryStore, extractMemories, __resetMemoryIds } from "@darkforest/memory";
import { MockEmbeddingProvider } from "@darkforest/ai";

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

const WORLD = "probe" as unknown as WorldId;

/** Turns with unambiguous, extractable facts. A competent model finds these. */
const CASES = [
  [
    { speaker: "player", content: "I swear to Captain Vale that I will guard the north gate until dawn." },
    { speaker: "Elena", content: "Vale nods slowly. 'Dawn, then. I will hold you to it.'" },
  ],
  [
    { speaker: "player", content: "I bought the silver-hilted sword from Odell for forty crowns." },
    { speaker: "Elena", content: "Odell wraps the blade in oilcloth. 'She's yours now.'" },
  ],
  [
    { speaker: "player", content: "I refuse to travel by boat. I hate open water." },
    { speaker: "Elena", content: "Elena raises an eyebrow. 'Then we ride the long road.'" },
  ],
  [
    { speaker: "player", content: "I asked Elena what lies behind the sealed room in the east wing." },
    { speaker: "Elena", content: "She goes quiet. 'Some doors stay shut for a reason.'" },
  ],
  [
    { speaker: "player", content: "Marcus admitted to me that he forged the steward's seal." },
    { speaker: "Elena", content: "'If anyone learns of it,' Marcus mutters, 'I am finished.'" },
  ],
];

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
  const embedder = new MockEmbeddingProvider();
  const reps = Number(process.env["PROBE_REPS"] ?? "2");

  console.log("\n" + "═".repeat(76));
  console.log("EXTRACTION COMPETENCE — per Groq model, on the real extraction prompt");
  console.log("═".repeat(76));
  console.log(`${String(CASES.length)} cases x ${String(reps)} reps per model\n`);

  const results: Array<{
    model: string;
    stored: number;
    dropped: number;
    repaired: number;
    empty: number;
    attempts: number;
  }> = [];

  for (const model of groq.models) {
    let stored = 0;
    let dropped = 0;
    let repaired = 0;
    let empty = 0;
    let attempts = 0;

    for (let rep = 0; rep < reps; rep++) {
      for (const transcript of CASES) {
        __resetMemoryIds();
        const store = new InMemoryMemoryStore();
        attempts += 1;
        try {
          const out = await extractMemories(store, groq, model, embedder, {
            worldId: WORLD,
            transcript,
            worldDay: 1,
            knownEntities: [
              { ref: "e1", name: "Captain Vale" },
              { ref: "e2", name: "Odell" },
              { ref: "e3", name: "Elena" },
              { ref: "e4", name: "Marcus" },
            ],
            aggressiveness: 0.5,
            turnsSinceLastExtraction: 5,
          });
          if (out.repairAttempted) repaired += 1;
          const n = (await store.allByWorld(WORLD)).length;
          stored += n;
          if (out.rejected.some((r) => r.reason === "unparseable")) dropped += 1;
          else if (n === 0 && !out.skipped) empty += 1;
        } catch (e) {
          dropped += 1;
          console.log(`    ${model.id}: ${e instanceof Error ? e.message.slice(0, 90) : "error"}`);
        }
      }
    }

    results.push({ model: model.id, stored, dropped, repaired, empty, attempts });
    const rate = attempts === 0 ? 0 : ((attempts - dropped - empty) / attempts) * 100;
    console.log(
      `  ${model.id.padEnd(24)} ${rate.toFixed(0).padStart(3)}% usable   ` +
        `stored ${String(stored).padStart(3)}  dropped ${String(dropped).padStart(2)}  ` +
        `empty ${String(empty).padStart(2)}  repaired ${String(repaired).padStart(2)}`,
    );
  }

  console.log("\n" + "─".repeat(76));
  console.log("READING");
  const best = [...results].sort((a, b) => b.stored - a.stored)[0];
  const worst = [...results].sort((a, b) => a.stored - b.stored)[0];
  if (best && worst && best.model !== worst.model) {
    console.log(
      `  best  ${best.model} stored ${String(best.stored)} memories in ${String(best.attempts)} attempts`,
    );
    console.log(
      `  worst ${worst.model} stored ${String(worst.stored)} memories in ${String(worst.attempts)} attempts`,
    );
    console.log(
      `\n  A model that emits nothing also consumes almost no tokens, so it keeps\n` +
        `  the most headroom and a headroom-dominant scheduler keeps choosing it.\n` +
        `  Failing cheaply must not look like having capacity.`,
    );
  }
  console.log("═".repeat(76) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
