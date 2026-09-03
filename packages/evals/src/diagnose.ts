/**
 * Why did real embeddings not move recall?
 *
 * Splits the failure into its two possible causes:
 *   (a) the fact was never STORED  -> extraction problem; no embedding can help
 *   (b) the fact was stored but not RETRIEVED -> ranking problem
 *
 * These need completely different fixes, and the aggregate recall number cannot
 * tell them apart.
 */
import { InMemoryMemoryStore, extractMemories, __resetMemoryIds } from "@darkforest/memory";
import { MockEmbeddingProvider, MockProvider } from "@darkforest/ai";
import { TEST_WORLDS } from "./worlds/index.js";

async function main(): Promise<void> {
  for (const world of TEST_WORLDS) {
    __resetMemoryIds();
    const store = new InMemoryMemoryStore();
    const provider = new MockProvider();
    const embedder = new MockEmbeddingProvider();
    const model = provider.models[1]!;

    const transcript: Array<{ speaker: string; content: string }> = [];
    let sinceExtraction = 0;

    for (let i = 0; i < world.script.length; i++) {
      transcript.push({ speaker: "user", content: world.script[i]! });
      transcript.push({ speaker: "npc", content: "..." });
      sinceExtraction += 1;
      const out = await extractMemories(store, provider, model, embedder, {
        worldId: world.id,
        transcript: transcript.slice(-6),
        worldDay: world.startingDay + i,
        knownEntities: world.characters.map((c) => ({ ref: `character:${c.id}`, name: c.name })),
        aggressiveness: 0.5,
        turnsSinceLastExtraction: sinceExtraction,
      });
      if (!out.skipped) sinceExtraction = 0;
    }

    const stored = await store.allByWorld(world.id);
    console.log(`\n╭─ ${world.name}  —  ${String(stored.length)} memories stored from ${String(world.script.length)} turns`);
    for (const m of stored) console.log(`│   • ${m.content}`);

    console.log(`│`);
    console.log(`├─ can each probed fact even be FOUND in what was stored?`);
    const all = stored.map((m) => m.content.toLowerCase()).join(" ");
    let storable = 0;
    for (const fact of world.plantedFacts) {
      const present = fact.expectedAnswerContains.some((n) => all.includes(n.toLowerCase()));
      if (present) storable += 1;
      console.log(
        `│   ${present ? "✓ stored " : "✗ MISSING"}  ${fact.question}  (needs: ${fact.expectedAnswerContains.join(" / ")})`,
      );
    }
    console.log(
      `╰─ ceiling: recall@k can be at most ${String(storable)}/${String(world.plantedFacts.length)} — retrieval cannot find what was never written\n`,
    );
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
