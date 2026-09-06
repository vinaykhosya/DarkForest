import { readFileSync } from "node:fs";
import {
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
  SchedulerRouter,
} from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";

/**
 * CAN A GENERATED REPLY SUPPRESS A FACT THE PLAYER STATED?
 *
 * The shootout answered the model question and refuted it: gpt-oss-120b and
 * gpt-oss-20b capture the gate fixture 4/4 EACH, identically, fixture for
 * fixture. So the live gate failing 1 run in 3 on that same sentence is not a
 * model difference.
 *
 * The one thing the shootout held constant that the live product does not is
 * the character's reply. The shootout pins it; the product generates it at
 * temperature 0.85, so every run extracts from a different second turn.
 *
 * PAIRED design, which is what the earlier attempt got wrong. Each repetition
 * generates ONE reply and then extracts twice from it:
 *
 *   A  the player's line alone
 *   B  the player's line + that same generated reply
 *
 * Pairing matters because both arms then see the identical reply. An unpaired
 * comparison across different replies measures the replies, which is how the
 * first version of this returned 4/4 against 4/4 and refuted nothing.
 *
 * If B loses to A, a generated sentence is deleting a fact a person actually
 * typed — and the fix is about which turn extraction trusts, not about prompts,
 * models or temperature.
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
const REPS = Number(process.env["NOISE_REPS"] ?? "8");

const PLAYER = "I have to tell you something. I can't swim. I never learned.";

/** The API's own character prompt, so the replies are the ones production makes. */
const SYSTEM = [
  "You are Elena.",
  "Watchful, dry, slow to trust. She has lived in Saltmarsh her whole life.",
  "You speak like this: Short sentences. Rarely explains herself.",
  "",
  "Reply in character, in one to three sentences. Let what you remember shape",
  "what you say and what you decide — do not recite it, and do not mention",
  "anything you were not told.",
].join("\n");

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
    // The PRODUCT's classification, since this reproduces a production failure.
    content: { pool: "standard", environment: "local", isSyntheticContent: false },
  });

  const extract = async (
    transcript: ReadonlyArray<{ speaker: string; content: string }>,
  ): Promise<boolean> => {
    await sleep(4500);
    const out = await extractEvents(router, router.models[0]!, {
      worldId: "noise",
      transcript,
      knownEntities: [
        { ref: "character:1", name: "Elena" },
        { ref: "narrator", name: "the user" },
      ],
      aggressiveness: 0.5,
      sourceTurn: 0,
      nextSeq: 0,
      worldDay: 1,
    }).catch(() => null);
    return (out?.events.length ?? 0) > 0;
  };

  console.log("\n" + "=".repeat(78));
  console.log("REPLY NOISE — paired, same generated reply in both arms");
  console.log("=".repeat(78) + "\n");

  let aHits = 0;
  let bHits = 0;
  let bothLost = 0;
  const losses: string[] = [];

  for (let rep = 0; rep < REPS; rep++) {
    await sleep(4500);
    const spoken = await router.generate(
      {
        taskClass: "dialogue",
        system: SYSTEM,
        messages: [{ role: "user", content: PLAYER }],
        maxTokens: 220,
        temperature: 0.85,
        timeoutMs: 30_000,
        meta: { requestId: `noise-${String(rep)}` },
      },
      router.models[0]!,
    );
    const reply = spoken.text.trim();

    const a = await extract([{ speaker: "the user", content: PLAYER }]);
    const b = await extract([
      { speaker: "the user", content: PLAYER },
      { speaker: "Elena", content: reply },
    ]);

    if (a) aHits += 1;
    if (b) bHits += 1;
    if (a && !b) losses.push(reply);
    if (!a && !b) bothLost += 1;

    console.log(`  ${a ? "A+" : "A!"} ${b ? "B+" : "B!"}  ${reply.slice(0, 62)}`);
  }

  console.log("\n" + "-".repeat(78));
  console.log(`  A  player's line alone            ${String(aHits)}/${String(REPS)}`);
  console.log(`  B  player's line + that reply     ${String(bHits)}/${String(REPS)}`);
  console.log(`  lost only when the reply was present: ${String(losses.length)}`);
  console.log(`  lost in both arms:                    ${String(bothLost)}`);

  if (losses.length > 0) {
    console.log("\n  REPLIES THAT DELETED THE FACT:");
    for (const l of losses) console.log(`    ${l.slice(0, 72)}`);
  }

  console.log(
    "\n  A > B means a sentence the CHARACTER invented is deleting a fact a\n" +
      "  PERSON typed. That is a decision about which turn extraction trusts,\n" +
      "  and it is not fixed by a prompt, a model, or a temperature.\n",
  );
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
