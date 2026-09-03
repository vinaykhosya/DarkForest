/**
 * P1-T07 verification — the lab against REAL semantic embeddings.
 *
 * The question this answers: does swapping the lexical mock embedder for real
 * semantic embeddings change recall? If it does, the pipeline is sound and the
 * mock was the limit. If it does not, retrieval has a genuine problem.
 *
 * Specifically targets the paraphrase gap. The mock cannot connect
 * "who dislikes the monarchy" to "Elena distrusts the crown" — zero shared
 * tokens. A real model should.
 */
import { readFileSync } from "node:fs";
import { CloudflareEmbeddingProvider, MockEmbeddingProvider, cosineSimilarity } from "@darkforest/ai";

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

/** Memory ←→ question pairs. Increasingly paraphrased. */
const PROBES: Array<{ memory: string; question: string; kind: string }> = [
  {
    kind: "lexical overlap",
    memory: "The user owns Ravenblade, a legendary sword.",
    question: "What sword do I own?",
  },
  {
    kind: "partial overlap",
    memory: "The user promised Elena he would return before sunset.",
    question: "What did I promise Elena?",
  },
  {
    kind: "PARAPHRASE — no shared content words",
    memory: "Elena distrusts the crown.",
    question: "Who dislikes the monarchy?",
  },
  {
    kind: "PARAPHRASE — no shared content words",
    memory: "Marcus conceals a blade beneath his cloak.",
    question: "Is anyone carrying a hidden weapon?",
  },
  {
    kind: "PARAPHRASE — no shared content words",
    memory: "The granary burned during the siege.",
    question: "What happened to the food stores?",
  },
];

const DISTRACTOR = "The queen's physician resigned without explanation.";

async function main(): Promise<void> {
  const env = loadEnv();
  const mock = new MockEmbeddingProvider();
  const real = new CloudflareEmbeddingProvider({
    accountId: env["CF_ACCOUNT_ID"] ?? "",
    getToken: () => ({ id: "cloudflare-1", key: (env["CF_API_TOKEN"] ?? "").split(",")[0] ?? "" }),
  });

  console.log("\n╭─ P1-T07 — real embeddings vs lexical mock");
  console.log("│  each row: similarity(memory, question) minus similarity(distractor, question)");
  console.log("│  positive = the right memory ranks above an unrelated one\n");
  console.log("│  " + "case".padEnd(36) + "  mock     real     verdict");
  console.log("│  " + "─".repeat(66));

  let mockWins = 0;
  let realWins = 0;

  for (const probe of PROBES) {
    const texts = [probe.memory, probe.question, DISTRACTOR];
    const [mm, mq, md] = await mock.embed(texts);
    const [rm, rq, rd] = await real.embed(texts);

    const mockMargin = cosineSimilarity(mm!, mq!) - cosineSimilarity(md!, mq!);
    const realMargin = cosineSimilarity(rm!, rq!) - cosineSimilarity(rd!, rq!);

    if (mockMargin > 0) mockWins += 1;
    if (realMargin > 0) realWins += 1;

    const verdict =
      realMargin > 0 && mockMargin <= 0
        ? "REAL RESCUES IT"
        : realMargin > 0
          ? "both ok"
          : "both fail";

    console.log(
      `│  ${probe.kind.padEnd(36)}  ${mockMargin >= 0 ? "+" : ""}${mockMargin.toFixed(3)}  ${realMargin >= 0 ? "+" : ""}${realMargin.toFixed(3)}   ${verdict}`,
    );
  }

  console.log("│");
  console.log(`├─ mock retrieves correctly: ${String(mockWins)}/${String(PROBES.length)}`);
  console.log(`├─ real retrieves correctly: ${String(realWins)}/${String(PROBES.length)}`);
  console.log(`╰─ cache: ${JSON.stringify(real.stats)}\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
