/**
 * EXPRESSION PROBE — why does a character with the fact say nothing?
 *
 * The 3x gauntlet said expression was 27/48, and the natural reading was that
 * context construction was starving the model or that generation was ignoring
 * what it had. Both are wrong. Of the 21 silent cases:
 *
 *   fact was in the context handed to the model   21 of 21
 *   starved                                        0
 *   answers that came back EMPTY                  18 of 21
 *
 * So it is not "the character talked and failed to mention it". The character
 * produced nothing.
 *
 * FOUND, and it was ONE model. At the gauntlet's own 150-token budget:
 *
 *   gpt-oss-120b  out= 60  answers
 *   gpt-oss-20b   out= 74  answers
 *   qwen3.8-27b   out= 20  answers
 *   qwen3.6-27b   out=550  finish=length, EMPTY, 2 of 2
 *
 * qwen3.6 spent the whole budget on a <think> block. Not reasoning tokens —
 * reasoning=0 — just running until cut off.
 *
 * The cause was a boolean that could not express the truth.
 * `supportsEffortLevels` meant "graded levels or nothing", so qwen got NO
 * reasoning_effort at all. It rejects the graded levels but accepts "none", and
 * with that set the same prompt answers in 15 tokens, in character. A model
 * needing a DIFFERENT value looked identical to one needing none.
 *
 * Three states, encoded as two. Now `reasoningEffort` per model, and all four
 * answer.
 *
 * Keep this probe: it is the cheapest check that a model can still speak at the
 * budget the product actually gives it.
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, stripReasoningTrace } from "@darkforest/ai";

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

/** The gauntlet's own budget. Changing it here would measure a different thing. */
const MAX_TOKENS = 150;

const SYSTEM = [
  "You are Bram, a smith in Saltmarsh. Blunt, not unkind, says little.",
  "",
  "WHAT YOU KNOW",
  "  The user told you there is a sealed door in the cellar of the Drowned Bell.",
  "  The user bought a silver ring from you for eleven marks.",
  "",
  "Answer in character, in one or two sentences. If you do not know, say so.",
].join("\n");

const QUESTION = "What do you know about the cellar under the Bell?";

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
  });

  console.log("\n" + "=".repeat(78));
  console.log(`EXPRESSION PROBE — same question, every model, maxTokens=${String(MAX_TOKENS)}`);
  console.log("=".repeat(78));
  console.log(`  Q: ${QUESTION}\n`);

  const REPS = Number(process.env["EXPR_REPS"] ?? "2");
  for (const model of groq.models) {
    let empties = 0;
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(4000);
      try {
        const res = await groq.generate(
          {
            taskClass: "dialogue",
            system: SYSTEM,
            messages: [{ role: "user", content: QUESTION }],
            maxTokens: MAX_TOKENS,
            temperature: 0.7,
            timeoutMs: 30_000,
            meta: { requestId: `expr-${String(rep)}` },
          },
          model,
        );
        // `res.text` is already stripped by the provider; the raw form is gone by
        // here, so an empty result means the trace was all there was.
        const after = res.text.trim();
        if (after.length === 0) empties += 1;
        console.log(
          `  ${model.id.split("/").pop()?.padEnd(16) ?? ""} rep ${String(rep + 1)}  ` +
            `finish=${res.finishReason.padEnd(6)} out=${String(res.usage.outputTokens).padStart(3)} ` +
            `reasoning=${String(res.usage.reasoningTokens ?? 0).padStart(4)}  ` +
            (after.length === 0 ? "*** EMPTY ***" : JSON.stringify(after.slice(0, 72))),
        );
      } catch (err) {
        console.log(
          `  ${model.id.split("/").pop()?.padEnd(16) ?? ""} rep ${String(rep + 1)}  threw: ` +
            (err instanceof Error ? err.message.slice(0, 50) : ""),
        );
      }
    }
    console.log(
      `  ${" ".repeat(16)} -> ${String(empties)}/${String(REPS)} empty` +
        (empties > 0 ? "   <-- this model cannot be given dialogue as configured" : ""),
      "\n",
    );
  }

  // Sanity check that the stripper is not the thing eating good answers.
  console.log("-".repeat(78));
  console.log("STRIPPER SANITY — it must remove traces and nothing else");
  for (const [label, input] of [
    ["ordinary reply", "The air is colder than it should be down there."],
    ["trace then reply", "<think>weighing it</think>There is a sealed door at the back."],
    ["trace only", "<think>the user asks about the cellar and I should"],
  ] as const) {
    const out = stripReasoningTrace(input);
    console.log(`  ${label.padEnd(18)} -> ${JSON.stringify(out.slice(0, 60))}`);
  }
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
