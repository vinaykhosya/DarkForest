/**
 * Lab CLI — `pnpm lab [world] [--real]`
 *
 * Runs the full memory loop and prints what happened. Free and offline by
 * default; `--real` swaps in Cloudflare Workers AI embeddings.
 *
 * That flag is the difference between measuring whether the PIPELINE works and
 * measuring whether RETRIEVAL works. The mock embedder is lexical only, so any
 * paraphrased probe fails on vocabulary rather than on ranking quality.
 */

import { readFileSync } from "node:fs";
import { CloudflareEmbeddingProvider } from "@darkforest/ai";
import type { EmbeddingProvider } from "@darkforest/contracts";
import { TEST_WORLDS, worldByName } from "./worlds/index.js";
import { formatRun, runLab } from "./lab.js";

/** Reads .env directly; the lab is a dev tool with no config layer. */
function realEmbedder(): EmbeddingProvider | null {
  let text: string;
  try {
    text = readFileSync(".env", "utf8");
  } catch {
    return null;
  }

  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const v = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
    if (v) env[m[1]] = v;
  }

  const account = env["CF_ACCOUNT_ID"];
  const token = (env["CF_API_TOKEN"] ?? "").split(",")[0];
  if (account === undefined || token === undefined || token.length === 0) return null;

  return new CloudflareEmbeddingProvider({
    accountId: account,
    getToken: () => ({ id: "cloudflare-1", key: token }),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useReal = args.includes("--real");
  const arg = args.find((a) => !a.startsWith("--"));

  let embedder: EmbeddingProvider | null = null;
  if (useReal) {
    embedder = realEmbedder();
    if (embedder === null) {
      console.error("--real needs CF_ACCOUNT_ID and CF_API_TOKEN in .env");
      process.exitCode = 1;
      return;
    }
    console.log(`\nembeddings: ${embedder.id}  [REAL — semantic]`);
  } else {
    console.log("\nembeddings: lexical mock  (pass --real for semantic)");
  }

  const worlds =
    arg === undefined
      ? TEST_WORLDS
      : [worldByName(arg)].filter((w): w is NonNullable<typeof w> => w !== undefined);

  if (worlds.length === 0) {
    console.error(`No world matching "${arg ?? ""}".`);
    console.error(`Available: ${TEST_WORLDS.map((w) => w.name).join(" · ")}`);
    process.exitCode = 1;
    return;
  }

  let totalRecalled = 0;
  let totalFacts = 0;

  for (const world of worlds) {
    // Probe turns are appended after the script and ask about facts planted
    // early — the actual recall test.
    const probes = world.plantedFacts.map((f) => f.question);
    const run = await runLab(world, {
      probes,
      ...(embedder === null ? {} : { embedder }),
    });
    console.log(formatRun(run));

    /*
     * Two SEPARATE metrics, as docs/15 suite 1 defines them:
     *
     *   recall@k        was the fact present in the RETRIEVED set
     *   answer accuracy did the character actually use it in the reply
     *
     * Conflating them measures the model's phrasing rather than the ranking, and
     * makes a retrieval regression indistinguishable from a generation one.
     * recall@k is the number that gates Phase 1.
     */
    console.log(`│`);
    console.log(`├─ probes                                    recall@k  answered`);
    const probeStart = world.script.length;
    let recalled = 0;
    let answered = 0;

    for (let i = 0; i < world.plantedFacts.length; i++) {
      const fact = world.plantedFacts[i];
      const turn = run.turns[probeStart + i];
      if (fact === undefined || turn === undefined) continue;

      const retrievedText = turn.retrievedContents.join(" ").toLowerCase();
      const inRetrieved = fact.expectedAnswerContains.some((needle) =>
        retrievedText.includes(needle.toLowerCase()),
      );
      const inResponse = fact.expectedAnswerContains.some((needle) =>
        turn.response.toLowerCase().includes(needle.toLowerCase()),
      );
      if (inRetrieved) recalled += 1;
      if (inResponse) answered += 1;

      const label = fact.question.padEnd(42).slice(0, 42);
      console.log(`│   ${label}   ${inRetrieved ? "✓" : "✗"}         ${inResponse ? "✓" : "✗"}`);
    }

    const n = world.plantedFacts.length;
    totalRecalled += recalled;
    totalFacts += n;
    const pct = (x: number): string => (n === 0 ? "100" : ((x / n) * 100).toFixed(0));
    console.log(
      `├─ recall@k:        ${String(recalled)}/${String(n)} (${pct(recalled)}%)   ← gates Phase 1`,
    );
    console.log(`╰─ answer accuracy: ${String(answered)}/${String(n)} (${pct(answered)}%)`);
    console.log();
  }

  if (worlds.length > 1) {
    const overall = totalFacts === 0 ? 0 : (totalRecalled / totalFacts) * 100;
    console.log("═".repeat(58));
    console.log(
      `OVERALL recall@k: ${String(totalRecalled)}/${String(totalFacts)} (${overall.toFixed(0)}%)   ` +
        `[${useReal ? "real embeddings" : "lexical mock"}]`,
    );
    // docs/15 suite 1. The mock cannot reach this; only a real provider can.
    console.log(`Phase 1 gate: recall@k ≥ 85%  →  ${overall >= 85 ? "PASS" : "not yet"}`);
    console.log("═".repeat(58) + "\n");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
