import { readFileSync } from "node:fs";
import {
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
  SchedulerRouter,
} from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";

/**
 * SELF-DESCRIPTION PROBE — does the event vocabulary have a slot for "I can't
 * swim"?
 *
 * The V0.1 acceptance test failed on exactly this. A stranger told Elena "I
 * can't swim. I never learned", the extractor returned VALID JSON with ZERO
 * events, and a day later there was nothing to remember. Not a parse failure,
 * not a validator throwing away good events — the model read the sentence and
 * decided it was not the kind of thing this system records.
 *
 * Which is a fair reading of the vocabulary it was given. The closest type is
 * `preference_stated`, described as "a like, dislike, fear or refusal of a
 * thing", and an inability is none of those.
 *
 * Same shape as the agency experiment that found perception missing: sentences
 * balanced across the shapes, one rep, no prompt changes yet. The question is
 * whether the ONTOLOGY has nowhere to put these facts, or whether the model is
 * simply judging them unimportant — those need opposite fixes, and guessing
 * between them is how a prompt gets rewritten four times.
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

/**
 * Ten sentences a player would actually say, across the shapes of
 * self-description. Each one is a fact a character SHOULD still know next week.
 *
 * The controls at the end are shapes the vocabulary already covers, so a total
 * failure here reads as a broken probe rather than a finding.
 */
const CASES: ReadonlyArray<{ id: string; shape: string; text: string; control?: boolean }> = [
  { id: "S01", shape: "inability", text: "I have to tell you something. I can't swim. I never learned." },
  { id: "S02", shape: "inability", text: "My right hand doesn't close properly. It hasn't since the winter." },
  { id: "S03", shape: "condition", text: "I don't see well in the dark. Never have." },
  { id: "S04", shape: "history", text: "I grew up in Ashford. I left when I was fifteen and never went back." },
  { id: "S05", shape: "history", text: "I used to be a ferryman on this same channel, years ago." },
  { id: "S06", shape: "identity", text: "My name is Cass. Everyone here has been calling me the traveller." },
  { id: "S07", shape: "capability", text: "I can read. Not many out here can, so I keep it quiet." },
  { id: "S08", shape: "constraint", text: "I can't be out after dark. It's a condition of my parole." },
  // Controls — the vocabulary already has slots for these.
  { id: "C01", shape: "control:preference", text: "I hate the smell of tar. Always have.", control: true },
  { id: "C02", shape: "control:promise", text: "I promise you I'll be back before sunset.", control: true },
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
  const openrouter = new OpenRouterProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("openrouter", est, Date.now(), modelId);
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
    // Benchmark fixtures, on a development machine. All three are false in the
    // product; see SchedulerRouterConfig.content.
    content: { pool: "development", environment: "local", isSyntheticContent: true },
  });

  console.log("\n" + "=".repeat(78));
  console.log("SELF-DESCRIPTION PROBE — is there a slot for \"I can't swim\"?");
  console.log("=".repeat(78) + "\n");

  let captured = 0;
  let missed = 0;
  const byShape = new Map<string, { hit: number; total: number }>();

  for (const c of CASES) {
    await sleep(4500);
    const out = await extractEvents(router, router.models[0]!, {
      worldId: "probe",
      transcript: [{ speaker: "the user", content: c.text }],
      knownEntities: [{ ref: "narrator", name: "the user" }],
      aggressiveness: 0.5,
      sourceTurn: 0,
      nextSeq: 0,
      worldDay: 1,
    }).catch(() => null);

    const events = out?.events ?? [];
    const hit = events.length > 0;
    const stat = byShape.get(c.shape) ?? { hit: 0, total: 0 };
    stat.total += 1;
    if (hit) stat.hit += 1;
    byShape.set(c.shape, stat);
    if (hit) captured += 1;
    else missed += 1;

    console.log(`  ${hit ? "kept" : "MISS"}  ${c.id}  ${c.shape.padEnd(18)} ${c.text.slice(0, 46)}`);
    for (const e of events) {
      console.log(
        `          -> ${e.type} actor=${e.actor} object=${String(e.object)} value=${String(e.value).slice(0, 50)}`,
      );
    }
    if (!hit) {
      console.log(
        `          -> nothing. proposed=${String(out?.proposed ?? 0)} ` +
          `rejected=${out?.rejected.map((r) => r.reason).join(",") ?? "n/a"}`,
      );
    }
  }

  console.log("\n" + "-".repeat(78));
  for (const [shape, s] of [...byShape.entries()].sort()) {
    console.log(`  ${shape.padEnd(20)} ${String(s.hit)}/${String(s.total)}`);
  }
  console.log(
    `\n  captured ${String(captured)}/${String(CASES.length)} · missed ${String(missed)}`,
  );
  console.log(
    "\n  Read the CONTROLS first. If they are kept and the rest are not, the\n" +
      "  ontology has nowhere to put a fact about oneself — which is a vocabulary\n" +
      "  gap, not a judgement failure, and the fix is a type rather than a prompt\n" +
      "  rewrite.\n",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
