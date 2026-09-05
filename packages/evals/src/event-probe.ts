/**
 * EVENT EXTRACTION PROBE.
 *
 * The A/B run produced 1 accepted event against 66 rejections — 41 unparseable,
 * 25 schema — while reporting 100% validity, because validity counted only the
 * responses that had already parsed. This prints what the model ACTUALLY
 * returns, rather than inferring the cause from a rejection tally.
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider } from "@darkforest/ai";
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

const CASES: ReadonlyArray<{ speaker: string; content: string }>[] = [
  [{ speaker: "user", content: "I promise Elena I will return before sunset." }],
  [{ speaker: "user", content: "I buy a coil of rope from Odell." }],
  [{ speaker: "user", content: "Captain Vale tells me nine guards remain at the keep." }],
  [{ speaker: "user", content: "I ask Elena who sealed the room on the upper floor." }],
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
  });

  const model = groq.models.find((m) => m.id.includes("gpt-oss-20b")) ?? groq.models[0]!;
  console.log(`\nmodel: ${model.id}\n${"=".repeat(72)}`);

  for (const transcript of CASES) {
    const prompt = renderExtractEventsPrompt({
      transcript,
      worldDay: 3,
      knownEntities: [
        { ref: "e1", name: "Elena" },
        { ref: "e2", name: "Odell" },
        { ref: "e3", name: "Captain Vale" },
      ],
      aggressiveness: 0.5,
    });
    console.log(`\nIN : ${transcript[0]?.content ?? ""}`);
    console.log(`     prompt ~${String(prompt.estimatedTokens)} tokens`);
    try {
      const res = await groq.generate(
        {
          taskClass: "extract",
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          maxTokens: 900,
          temperature: 0,
          timeoutMs: 30_000,
          meta: { requestId: "event-probe" },
        },
        model,
      );
      const reasoning = res.usage.reasoningTokens ?? 0;
      console.log(
        `     usage in=${String(res.usage.inputTokens)} out=${String(res.usage.outputTokens)} reasoning=${String(reasoning)}`,
      );
      console.log(`RAW: ${JSON.stringify(res.text.slice(0, 400))}`);
      let parsed: unknown = null;
      try {
        const start = res.text.indexOf("{");
        const end = res.text.lastIndexOf("}");
        parsed = start >= 0 && end > start ? JSON.parse(res.text.slice(start, end + 1)) : null;
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        console.log(`     -> UNPARSEABLE`);
        continue;
      }
      const check = EventExtractionSchema.safeParse(parsed);
      console.log(
        check.success
          ? `     -> OK, ${String(check.data.events.length)} event(s): ${JSON.stringify(check.data.events)}`
          : `     -> SCHEMA FAIL: ${check.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(" | ")}`,
      );
    } catch (e) {
      console.log(`     -> THREW: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }
  console.log(`\n${"=".repeat(72)}\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
