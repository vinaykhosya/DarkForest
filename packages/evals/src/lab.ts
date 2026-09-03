import { MockEmbeddingProvider, MockProvider } from "@darkforest/ai";
import type { EmbeddingProvider } from "@darkforest/contracts";
import type {
  Character,
  CharacterId,
  ModelDescriptor,
  WorldState,
} from "@darkforest/contracts";
import { FULL_PROFILE, totalBudget } from "@darkforest/core";
import {
  InMemoryMemoryStore,
  extractMemories,
  retrieve,
  __resetMemoryIds,
} from "@darkforest/memory";
import { renderDialoguePrompt, renderPriorSpeakers } from "@darkforest/prompts";
import type { TestWorld } from "./worlds/index.js";

/**
 * The Phase 1 lab — P1-T08.
 *
 * Runs the whole loop end to end against the mock provider:
 *
 *   user turn → retrieve → build prompt → generate → extract → store → embed
 *
 * This is the first thing in the project that answers the only question Phase 1
 * exists to answer: CAN THE SYSTEM REMEMBER?
 *
 * It costs nothing and needs no network, which is the entire point of building
 * the mock provider first.
 */

export interface TurnResult {
  turn: number;
  userMessage: string;
  speaker: string;
  response: string;
  memoriesRetrieved: number;
  /**
   * Contents of what retrieval surfaced, in rank order.
   *
   * recall@k is measured against THIS, not against the response text. docs/15
   * suite 1 separates "was the fact retrieved" from "did the character use it",
   * and conflating them measures the model's phrasing rather than the ranking.
   */
  retrievedContents: string[];
  memoriesStored: number;
  extractionSkipped: boolean;
  gateSignals: readonly string[];
  promptTokens: number;
  droppedSections: readonly string[];
  sanitizerFindings: readonly string[];
}

export interface LabRun {
  world: string;
  turns: TurnResult[];
  totalMemories: number;
  /** Model calls actually made. Gate skips show up here as a lower number. */
  generateCalls: number;
  degradedRetrievals: number;
}

function stateFor(world: TestWorld, day: number): WorldState {
  return {
    worldId: world.id,
    version: 1n,
    day,
    timeOfDay: "evening",
    currentLocation: world.location,
    weather: null,
    chapter: 1,
    chapterTitle: null,
    sceneSummary: "",
    flags: {},
    numerics: {},
  };
}

export interface LabOptions {
  /**
   * Embedding provider. Defaults to the lexical mock.
   *
   * Swapping in the real provider is the difference between measuring whether
   * the PIPELINE works and measuring whether RETRIEVAL works — the mock has no
   * synonymy, so any paraphrased probe fails on vocabulary rather than on
   * ranking.
   */
  embedder?: EmbeddingProvider;
  /** Which character answers. Defaults to the first in the world. */
  speakerId?: CharacterId;
  /** Extra probe turns appended after the script, for recall testing. */
  probes?: readonly string[];
  seed?: string;
}

export async function runLab(world: TestWorld, options: LabOptions = {}): Promise<LabRun> {
  __resetMemoryIds();

  const store = new InMemoryMemoryStore();
  const provider = new MockProvider(options.seed === undefined ? {} : { seed: options.seed });
  const embedder: EmbeddingProvider = options.embedder ?? new MockEmbeddingProvider();
  const model: ModelDescriptor =
    provider.models.find((m) => m.tier === "standard") ?? provider.models[0]!;

  const speaker: Character =
    world.characters.find((c) => c.id === options.speakerId) ?? world.characters[0]!;

  const turns: TurnResult[] = [];
  const transcript: Array<{ speaker: string; content: string }> = [];
  let degraded = 0;
  let turnsSinceExtraction = 0;

  const allTurns = [...world.script, ...(options.probes ?? [])];

  for (let i = 0; i < allTurns.length; i++) {
    const userMessage = allTurns[i]!;
    const day = world.startingDay + i;
    const state = stateFor(world, day);

    // ── retrieve ────────────────────────────────────────────────────────────
    const retrieval = await retrieve(store, embedder, {
      worldId: world.id,
      characterId: speaker.id,
      userMessage,
      recentLines: transcript.slice(-2).map((t) => t.content),
      aliases: world.aliases,
      currentWorldDay: day,
      tokenBudget: FULL_PROFILE.memories,
    });
    if (retrieval.degraded) degraded++;

    // ── build the prompt ────────────────────────────────────────────────────
    const prompt = renderDialoguePrompt({
      profile: "full",
      world: {
        name: world.name,
        genre: world.genre,
        tone: world.tone,
        perspective: "second",
      },
      rules: world.rules,
      character: speaker,
      memories: retrieval.memories.map((m) => ({
        worldDay: m.memory.worldDay,
        content: m.memory.content,
        certainty: 1,
      })),
      relationships: [],
      state,
      presentCharacterNames: world.characters.map((c) => c.name),
      visibleNumerics: [],
      priorSpeakers: [],
    });

    // ── generate ────────────────────────────────────────────────────────────
    const priorBlock = renderPriorSpeakers([], speaker.name);
    const response = await provider.generate(
      {
        taskClass: "dialogue",
        system: prompt.system,
        messages: [
          ...(priorBlock === null
            ? []
            : ([{ role: "system", content: priorBlock }] as const)),
          { role: "user" as const, content: userMessage },
        ],
        maxTokens: 400,
        temperature: 0.8,
        timeoutMs: 12_000,
        meta: {
          requestId: `lab-${String(i)}`,
          worldId: world.id,
          characterId: speaker.id,
          turnId: `turn-${String(i)}`,
        },
      },
      model,
    );

    transcript.push({ speaker: "user", content: userMessage });
    transcript.push({ speaker: speaker.name, content: response.text });

    // ── extract (gated) ─────────────────────────────────────────────────────
    turnsSinceExtraction += 1;
    const extraction = await extractMemories(store, provider, model, embedder, {
      worldId: world.id,
      // Rolling window of the last 3 turns — a promise made across two messages
      // is one memory (docs/04 § 4).
      transcript: transcript.slice(-6),
      worldDay: day,
      knownEntities: world.characters.map((c) => ({
        ref: `character:${c.id}`,
        name: c.name,
      })),
      aggressiveness: 0.5,
      turnsSinceLastExtraction: turnsSinceExtraction,
    });
    if (!extraction.skipped) turnsSinceExtraction = 0;

    turns.push({
      turn: i + 1,
      userMessage,
      speaker: speaker.name,
      response: response.text,
      memoriesRetrieved: retrieval.memories.length,
      retrievedContents: retrieval.memories.map((m) => m.memory.content),
      memoriesStored: extraction.stored.length,
      extractionSkipped: extraction.skipped,
      gateSignals: extraction.gate.signals,
      promptTokens: prompt.estimatedTokens,
      droppedSections: prompt.droppedSections,
      sanitizerFindings: prompt.sanitizerFindings,
    });
  }

  return {
    world: world.name,
    turns,
    totalMemories: await store.countByWorld(world.id),
    generateCalls: provider.callCount(),
    degradedRetrievals: degraded,
  };
}

/** Human-readable summary for the CLI. */
export function formatRun(run: LabRun): string {
  const lines: string[] = [
    ``,
    `╭─ ${run.world}`,
    `│`,
  ];

  for (const turn of run.turns) {
    lines.push(`│ ${String(turn.turn).padStart(2)}. » ${turn.userMessage}`);
    lines.push(`│     ${turn.speaker}: ${turn.response}`);
    const gate = turn.extractionSkipped
      ? "gate: skipped (no inference spent)"
      : `gate: ${turn.gateSignals.join("+")} → ${String(turn.memoriesStored)} stored`;
    lines.push(
      `│     ↳ ${String(turn.memoriesRetrieved)} retrieved · ${gate} · ~${String(turn.promptTokens)} tok`,
    );
    lines.push(`│`);
  }

  lines.push(`├─ memories in world: ${String(run.totalMemories)}`);
  lines.push(`├─ model calls:       ${String(run.generateCalls)}`);
  lines.push(`├─ degraded retrieval: ${String(run.degradedRetrievals)}`);
  lines.push(`╰─ full-profile budget: ${String(totalBudget(FULL_PROFILE))} tok`);
  return lines.join("\n");
}
