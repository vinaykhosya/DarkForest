/**
 * Extraction with a REAL model — the question the mock could not answer.
 *
 * The diagnostic showed retrieval hitting its ceiling in every world while
 * extraction stored 1 memory from 10 turns. That was the MOCK's keyword list
 * being narrow, not necessarily a design flaw. This checks what a real model
 * extracts from the same transcripts.
 */
import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, CloudflareEmbeddingProvider } from "@darkforest/ai";
import { InMemoryMemoryStore, extractMemories, __resetMemoryIds } from "@darkforest/memory";
import { TEST_WORLDS } from "./worlds/index.js";

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

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);

  const provider = new GroqProvider({
    getCredential: (est) => {
      const got = registry.acquire("groq", est);
      return got.ok ? { id: got.id, key: got.key } : null;
    },
    onSuccess: (id, tokens) => { registry.reportSuccess(id, tokens); },
    onRateLimited: (id, ms) => { registry.reportRateLimited(id, ms); },
    onRejected: (id, reason) => { registry.reportRejected(id, reason); },
    onFailure: (id) => { registry.reportFailure(id); },
  });

  const embedder = new CloudflareEmbeddingProvider({
    accountId: env["CF_ACCOUNT_ID"] ?? "",
    getToken: () => {
      const got = registry.acquire("cloudflare", 0);
      return got.ok ? { id: got.id, key: got.key } : null;
    },
    onSuccess: (id, tokens) => { registry.reportSuccess(id, tokens); },
  });

  const model = provider.models.find((m) => m.tier === "fast") ?? provider.models[0]!;
  console.log(`\nextraction model : ${model.id}`);
  console.log(`embeddings       : ${embedder.id}\n`);

  let totalStored = 0;
  let totalCeiling = 0;
  let totalFacts = 0;

  for (const world of TEST_WORLDS) {
    __resetMemoryIds();
    const store = new InMemoryMemoryStore();
    const transcript: Array<{ speaker: string; content: string }> = [];
    let sinceExtraction = 0;

    for (let i = 0; i < world.script.length; i++) {
      transcript.push({ speaker: "user", content: world.script[i]! });
      transcript.push({ speaker: world.characters[0]?.name ?? "npc", content: "..." });
      sinceExtraction += 1;
      try {
        const out: Awaited<ReturnType<typeof extractMemories>> =
          await extractMemories(store, provider, model, embedder, {
          worldId: world.id,
          transcript: transcript.slice(-6),
          worldDay: world.startingDay + i,
          knownEntities: world.characters.map((c) => ({
            ref: `character:${c.id}`,
            name: c.name,
          })),
          aggressiveness: 0.5,
          turnsSinceLastExtraction: sinceExtraction,
        });
        if (!out.skipped) sinceExtraction = 0;

        // Distinguish the three ways a turn produces no memory. Without this the
        // script reports "0 memories" and says nothing about whether the gate
        // declined, the model refused, or validation rejected the output.
        const why = out.skipped
          ? "gate skipped"
          : out.rejected.length > 0
            ? `REJECTED: ${out.rejected.map((r) => r.reason).join(",")}${out.repairAttempted ? " (repair tried)" : ""}`
            : out.stored.length === 0
              ? "model returned no memories"
              : `stored ${String(out.stored.length)}`;
        console.log(
          `│   t${String(i + 1).padStart(2)} [${out.gate.signals.join("+") || "-"}] ${why}`,
        );
      } catch (e) {
        console.log(`│   t${String(i + 1).padStart(2)} ERROR: ${(e as Error).message.slice(0, 110)}`);
      }
    }

    const stored = await store.allByWorld(world.id);
    totalStored += stored.length;
    console.log(`╭─ ${world.name} — ${String(stored.length)} memories from ${String(world.script.length)} turns`);
    for (const m of stored) {
      console.log(`│   • [${m.importance.toFixed(2)}] ${m.content}`);
    }

    const all = stored.map((m) => m.content.toLowerCase()).join(" ");
    let found = 0;
    for (const fact of world.plantedFacts) {
      const present = fact.expectedAnswerContains.some((n) => all.includes(n.toLowerCase()));
      if (present) found += 1;
      console.log(`│   ${present ? "✓" : "✗"} ${fact.question}`);
    }
    totalCeiling += found;
    totalFacts += world.plantedFacts.length;
    console.log(`╰─ extraction ceiling: ${String(found)}/${String(world.plantedFacts.length)}\n`);
  }

  const pct = totalFacts === 0 ? 0 : (totalCeiling / totalFacts) * 100;
  console.log("═".repeat(58));
  console.log(`Memories stored     : ${String(totalStored)}  (mock stored 8)`);
  console.log(`Extraction ceiling  : ${String(totalCeiling)}/${String(totalFacts)} (${pct.toFixed(0)}%)   [mock: 7/11 = 64%]`);
  console.log("═".repeat(58));
  for (const s of registry.snapshotAll()) {
    console.log(`${s.providerId}: ${String(s.available)}/${String(s.total)} available, headroom ${(s.aggregateHeadroom * 100).toFixed(1)}%`);
  }
  console.log();
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
