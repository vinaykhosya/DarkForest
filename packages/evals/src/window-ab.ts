import { readFileSync } from "node:fs";
import {
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
  SchedulerRouter,
} from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";

/**
 * DOES THE CHARACTER'S REPLY COST US THE PLAYER'S FACT?
 *
 * The V0.1 gate passed once and then failed on the same input: the player says
 * "I can't swim", and extraction returns valid JSON with zero events about half
 * the time. Extraction runs at temperature 0, so the model is not the variable —
 * the INPUT is. The API sends a two-turn window, the player's line plus the
 * character's generated reply, and that reply is different every run because
 * dialogue runs at 0.85.
 *
 * So the hypothesis is that the reply dilutes the extraction. A one-line probe
 * captured this sentence 2 of 2; the API path, with a reply appended, captures
 * it sometimes.
 *
 * A/B, same sentence, same number of repetitions:
 *   A  the player's line alone
 *   B  the player's line plus a character reply
 *
 * If B is materially worse, the fix is what the window contains — not the
 * prompt, and not the temperature.
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

const SYNTHETIC = process.env["AB_SYNTHETIC"] !== "false";

const PLAYER_LINE = "I have to tell you something. I can't swim. I never learned.";

/** Real replies, taken verbatim from failing and passing gate runs. */
const REPLIES = [
  "The sea doesn't care. You keep your feet on the sand and your mouth shut.",
  "That doesn't change much. Stay close to shore. I know where the tide pulls.",
  "That won't help you much here. Find someone who can. I'm not interested in your excuses.",
  "Then stay out of the water. Saltmarsh has drowned better swimmers than you.",
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
    content: SYNTHETIC
      ? { pool: "development", environment: "local", isSyntheticContent: true }
      : /*
         * The PRODUCT's classification. This is the arm that matters: real user
         * content excludes every provider whose terms permit training on it, so
         * the eligible bucket set — and therefore the model doing the
         * extraction — is not the one every benchmark was measured on.
         */
        { pool: "standard", environment: "local", isSyntheticContent: false },
  });

  const run = async (transcript: ReadonlyArray<{ speaker: string; content: string }>): Promise<number> => {
    await sleep(4500);
    const out = await extractEvents(router, router.models[0]!, {
      worldId: "ab",
      transcript,
      knownEntities: [
        { ref: "narrator", name: "the user" },
        { ref: "character:1", name: "Elena" },
      ],
      aggressiveness: 0.5,
      sourceTurn: 0,
      nextSeq: 0,
      worldDay: 1,
    }).catch(() => null);
    return out?.events.length ?? 0;
  };

  console.log("\n" + "=".repeat(78));
  console.log("WINDOW A/B — does the character's reply cost us the player's fact?");
  console.log("=".repeat(78) + "\n");

  let aHits = 0;
  for (let i = 0; i < REPLIES.length; i++) {
    const n = await run([{ speaker: "the user", content: PLAYER_LINE }]);
    if (n > 0) aHits += 1;
    process.stdout.write(n > 0 ? "+" : "!");
  }
  console.log(`   A  player line alone            ${String(aHits)}/${String(REPLIES.length)}`);

  let bHits = 0;
  for (const reply of REPLIES) {
    const n = await run([
      { speaker: "the user", content: PLAYER_LINE },
      { speaker: "Elena", content: reply },
    ]);
    if (n > 0) bHits += 1;
    process.stdout.write(n > 0 ? "+" : "!");
  }
  console.log(`   B  player line + Elena's reply  ${String(bHits)}/${String(REPLIES.length)}`);

  console.log(
    `\n  A ${String(aHits)}/${String(REPLIES.length)} · B ${String(bHits)}/${String(REPLIES.length)}\n`,
  );
  console.log(
    "  A materially higher than B means the window is the problem, and the fix\n" +
      "  is what goes into it. Equal means the variance is elsewhere and this\n" +
      "  hypothesis is refuted — record that rather than trying the next guess.\n",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
