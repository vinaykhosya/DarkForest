/**
 * JSON MODE PROBE — is the bare-empty output a model fault or ours?
 *
 * The extraction diagnosis found 14% "unparseable", of which most were the model
 * saying "nothing here" as `[]`, `{}` or `""` rather than `{"events":[]}`, plus
 * two cases where a reasoning preamble was emitted as content and blew the token
 * budget. Every failure was gpt-oss-120b; 20b had none.
 *
 * Before touching the frozen evaluation contract (ADR-026) to accept bare-empty
 * forms, establish whether those outputs are a protocol violation at all.
 *
 * RESULT: the hypothesis this file was written to confirm is REFUTED, and the
 * text that stood here asserted it as fact before the probe had run. Recorded
 * rather than deleted, because a confident wrong comment is how the next person
 * inherits the same mistake.
 *
 * What was claimed: `response_format` is sent only when a caller passes
 * `responseSchema`, no extractor ever passed one, so JSON mode was never
 * switched on and the model was free to return anything.
 *
 * The first half is true. The conclusion is not. Turning JSON mode ON made
 * output WORSE on both models:
 *
 *   120b  json OFF  valid 7/8   reasoning  553 tok
 *   120b  json ON   valid 6/8   reasoning 4938 tok   9x more reasoning
 *   20b   json OFF  valid 7/8   reasoning 2515 tok
 *   20b   json ON   valid 5/8   reasoning 3703 tok   added ```json fences
 *
 * A follow-up against the raw API settled it: Groq already separates reasoning
 * from content, and on the exact filler turn that produced "" under load it
 * returns a clean {"events":[]}. The malformed shapes appear only under
 * sustained pressure, which makes contention the live hypothesis - see the
 * paced-vs-contended experiment.
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider, SchedulerRouter } from "@darkforest/ai";
import { EventExtractionSchema } from "@darkforest/contracts";
import { renderExtractEventsPrompt } from "@darkforest/prompts";

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

/** A mix of fact-bearing and deliberately empty turns, as the fixture has. */
const TURNS = [
  "I promise Elena I will return before sunset.",
  "I sit by the window and watch the rain.",
  "Elena saved my life on the north road.",
  "I wait.",
  "Captain Vale tells me nine guards remain at the keep.",
  "The fire burns low.",
  "I see the eastern watchtower signal fire.",
  "I say nothing for a while.",
];

const ACK = "She listens, and says nothing for a moment.";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SCHEMA_HINT = { type: "object", properties: { events: { type: "array" } } };

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

  const openrouter = new OpenRouterProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("openrouter", est, Date.now(), modelId);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
  });
  /*
   * Through the scheduler, not straight at the provider.
   *
   * The first version of this probe called groq.generate directly and 4 of 8
   * calls in EVERY condition returned "Groq rate limit" - the flag's effect was
   * buried under contention the scheduler exists to absorb. A probe that starves
   * its own subject measures the starvation.
   */
  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouter.models.filter((m) => m.tier === "fast") },
    sleep,
    // Benchmark fixtures, on a development machine. All three are false in the
    // product; see SchedulerRouterConfig.content.
    content: { pool: "development", environment: "local", isSyntheticContent: true },
  });

  // 120b carried every failure in the diagnosis; 20b had none. Both are probed
  // so the flag's effect can be separated from the model's.
  const models = groq.models.filter((m) => m.id.includes("gpt-oss"));

  console.log("\n" + "=".repeat(76));
  console.log("JSON MODE PROBE — same turns, same model, flag on vs off");
  console.log("=".repeat(76));

  for (const model of models) {
    for (const jsonMode of [false, true]) {
      let ok = 0;
      let bareEmpty = 0;
      let other = 0;
      let reasoningTotal = 0;
      const shapes: string[] = [];

      for (const [i, turn] of TURNS.entries()) {
        if (i > 0) await sleep(1500);
        const prompt = renderExtractEventsPrompt({
          transcript: [
            { speaker: "user", content: turn },
            { speaker: "Elena", content: ACK },
          ],
          worldDay: 3,
          knownEntities: [
            { ref: "e1", name: "Elena" },
            { ref: "e2", name: "Captain Vale" },
          ],
          aggressiveness: 0.5,
        });
        try {
          const res = await router.generate(
            {
              taskClass: "extract",
              system: prompt.system,
              messages: [{ role: "user", content: prompt.user }],
              maxTokens: 1400,
              temperature: 0,
              timeoutMs: 30_000,
              meta: { requestId: `jsonmode-${String(i)}` },
              ...(jsonMode ? { responseSchema: SCHEMA_HINT } : {}),
            },
            model,
          );
          reasoningTotal += res.usage.reasoningTokens ?? 0;
          const text = res.text.trim();
          let parsed: unknown = null;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          const valid = parsed !== null && EventExtractionSchema.safeParse(parsed).success;
          if (valid) ok += 1;
          else if (text === "" || text === "[]" || text === "{}") {
            bareEmpty += 1;
            shapes.push(text === "" ? '""' : text);
          } else {
            other += 1;
            shapes.push(text.slice(0, 28).replace(/\s+/g, " "));
          }
        } catch (e) {
          other += 1;
          shapes.push(`THREW ${e instanceof Error ? e.message.slice(0, 24) : ""}`);
        }
      }

      const label = `${model.id.split("/").pop() ?? ""}  json_mode=${jsonMode ? "ON " : "OFF"}`;
      console.log(
        `\n  ${label.padEnd(30)} valid ${String(ok)}/${String(TURNS.length)}   ` +
          `bare-empty ${String(bareEmpty)}   other ${String(other)}   ` +
          `reasoning ${String(reasoningTotal)} tok`,
      );
      if (shapes.length > 0) console.log(`    non-conforming: ${shapes.join(" | ")}`);
    }
  }

  console.log("\n" + "=".repeat(76));
  console.log("If json_mode=ON removes the bare-empty shapes, the outputs were never a");
  console.log("protocol violation — we simply never requested the protocol. No change to");
  console.log("ADR-026 is warranted in that case; the fix is at the provider boundary.");
  console.log("=".repeat(76) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
