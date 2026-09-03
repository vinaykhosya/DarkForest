import {
  ExtractionResultSchema,
  type AIProvider,
  type CharacterId,
  type EmbeddingProvider,
  type ExtractionResult,
  type Memory,
  type ModelDescriptor,
  type WorldId,
} from "@darkforest/contracts";
import {
  DEDUPE,
  KIND_IMPORTANCE_PRIOR,
  adjustImportance,
  estimateIrreversibility,
  shouldExtract,
  type GateInput,
  type GateResult,
} from "@darkforest/core";
import { renderExtractPrompt, renderRepairPrompt } from "@darkforest/prompts";
import type { InMemoryMemoryStore } from "./in-memory-store.js";

/**
 * Memory extraction — docs/04 § 4, ADR-016.
 *
 *   deterministic gate → LLM → validate → repair once → dedupe → store → embed
 *
 * Runs as a background job, never in the request path. A memory that arrives a
 * few seconds late costs nothing; four seconds of the user waiting to learn that
 * they prefer dark fantasy costs a session.
 */

export interface ExtractionInput {
  worldId: WorldId;
  transcript: ReadonlyArray<{ speaker: string; content: string }>;
  worldDay: number;
  knownEntities: ReadonlyArray<{ ref: string; name: string }>;
  aggressiveness: number;
  toolCallFired?: boolean;
  ruleDeltaApplied?: boolean;
  turnsSinceLastExtraction?: number;
  /**
   * How many entries at the end of `transcript` are new since the last gate
   * evaluation. The gate reads only these; extraction reads the whole window.
   * Defaults to 2 (one user turn plus one reply).
   */
  newTurnCount?: number;
  /** Characters present, so extracted memories can be scoped to who witnessed them. */
  presentCharacterIds?: readonly CharacterId[];
}

export interface ExtractionOutcome {
  gate: GateResult;
  /** True when the gate declined and no inference was spent. */
  skipped: boolean;
  stored: Memory[];
  merged: Array<{ existing: Memory; similarity: number }>;
  rejected: Array<{ reason: string; detail: string }>;
  repairAttempted: boolean;
  promptVersion: string | null;
}

// Names, not ids — see CharacterNameSchema in contracts for why.
const SCHEMA_HINT = `{"memories":[{"kind":"episodic|semantic|relational|world|persona","content":"string <=200 chars","subjects":["CharacterName"],"importance":0..1,"confidence":0..1,"worldDay":number|null,"knownBy":["CharacterName"],"visibility":"world|restricted|private"}],"relationshipDeltas":[{"from":"CharacterName","to":"CharacterName","deltas":{"trust":-15..15},"reason":"string >=8 chars"}],"events":[],"contradictions":[]}`;

export async function extractMemories(
  store: InMemoryMemoryStore,
  provider: AIProvider,
  model: ModelDescriptor,
  embedder: EmbeddingProvider,
  input: ExtractionInput,
): Promise<ExtractionOutcome> {
  const existing = await store.allByWorld(input.worldId);

  /*
   * The gate examines only the NEWEST turns, not the whole extraction window.
   *
   * This distinction is easy to miss and it matters: the window exists so that a
   * promise made across two messages becomes one memory, but if the GATE also
   * reads the window then a "promise" three turns back keeps re-firing and the
   * gate approves every subsequent turn. Observed in the first lab run — the
   * signal list grew monotonically (commissive+irreversible+preference+...)
   * until effectively nothing was being gated at all.
   *
   * So: gate on what is new, extract over the window.
   */
  const gateText = input.transcript
    .slice(-(input.newTurnCount ?? 2))
    .map((t) => t.content)
    .join(" ");

  const gateInput: GateInput = {
    windowText: gateText,
    knownEntities: input.knownEntities.map((e) => e.name),
    // Entities already named in stored memories. Word-split is crude but the
    // real implementation will match against the world's alias table.
    seenEntities: existing.flatMap((m) => m.content.split(/\W+/)),
    toolCallFired: input.toolCallFired ?? false,
    ruleDeltaApplied: input.ruleDeltaApplied ?? false,
    turnsSinceLastExtraction: input.turnsSinceLastExtraction ?? 0,
  };
  const gate = shouldExtract(gateInput);

  if (!gate.shouldExtract) {
    return {
      gate,
      skipped: true,
      stored: [],
      merged: [],
      rejected: [],
      repairAttempted: false,
      promptVersion: null,
    };
  }

  // ── generate ──────────────────────────────────────────────────────────────
  const prompt = renderExtractPrompt({
    transcript: input.transcript,
    worldDay: input.worldDay,
    knownEntities: input.knownEntities,
    aggressiveness: input.aggressiveness,
    existingMemories: existing.map((m) => m.content),
  });

  const rejected: ExtractionOutcome["rejected"] = [];
  let repairAttempted = false;
  let parsed: ExtractionResult | null = null;

  const raw = await provider.generate(
    {
      taskClass: "extract",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      maxTokens: 900,
      // Low temperature: extraction is transcription, not invention.
      temperature: 0.1,
      timeoutMs: 20_000,
      meta: { requestId: `extract-${input.worldId}-${String(input.worldDay)}` },
    },
    model,
  );

  parsed = tryParse(raw.text);

  // ── one repair attempt, then drop. A lost memory is acceptable; a corrupt
  // one is not, because it will be retrieved and believed for months.
  if (parsed === null) {
    repairAttempted = true;
    const repaired = await provider.generate(
      {
        taskClass: "extract",
        system: "You repair malformed JSON. Output JSON only.",
        messages: [{ role: "user", content: renderRepairPrompt(raw.text, SCHEMA_HINT) }],
        maxTokens: 900,
        temperature: 0,
        timeoutMs: 20_000,
        meta: { requestId: `extract-repair-${input.worldId}` },
      },
      model,
    );
    parsed = tryParse(repaired.text);
  }

  if (parsed === null) {
    rejected.push({
      reason: "unparseable",
      detail: "Model output failed validation twice; batch dropped.",
    });
    return {
      gate,
      skipped: false,
      stored: [],
      merged: [],
      rejected,
      repairAttempted,
      promptVersion: prompt.version,
    };
  }

  /*
   * Resolve character NAMES to ids.
   *
   * The model emits names because that is what it can say reliably; the backend
   * does the lookup because it can do it perfectly. An unrecognised name is
   * dropped from that memory's subject list rather than failing the batch — a
   * memory with a slightly wrong subject list is still a true memory, and
   * losing the whole extraction over one typo is a far worse trade.
   */
  const byName = new Map<string, string>();
  for (const entity of input.knownEntities) {
    byName.set(entity.name.toLowerCase(), entity.ref);
  }
  const resolveRef = (name: string): string | null => byName.get(name.toLowerCase()) ?? null;
  const resolveId = (name: string): CharacterId | null => {
    const ref = resolveRef(name);
    if (ref === null) return null;
    const idx = ref.indexOf(":");
    return (idx === -1 ? ref : ref.slice(idx + 1)) as CharacterId;
  };

  // ── store, with write-time dedupe ─────────────────────────────────────────
  const stored: Memory[] = [];
  const merged: ExtractionOutcome["merged"] = [];

  for (const candidate of parsed.memories) {
    const nearest = store.nearestByContent(input.worldId, candidate.content);

    // Near-identical to something we already hold: bump the existing row rather
    // than adding a fifth phrasing of the same fact (docs/04 § 4).
    if (nearest !== null && nearest.similarity >= DEDUPE.merge) {
      await store.update(nearest.memory.id, {
        importance: Math.max(nearest.memory.importance, candidate.importance),
      });
      merged.push({ existing: nearest.memory, similarity: nearest.similarity });
      continue;
    }

    const importance = adjustImportance({
      modelImportance: candidate.importance,
      kindPrior: KIND_IMPORTANCE_PRIOR[candidate.kind],
      subjectCentrality: candidate.subjects.length > 0 ? 0.8 : 0.4,
      emotionalCharge: estimateIrreversibility(candidate.content),
      irreversibility: estimateIrreversibility(candidate.content),
    });

    const memory = await store.insert({
      worldId: input.worldId,
      kind: candidate.kind,
      content: candidate.content,
      subjects: candidate.subjects.map(resolveRef).filter((r): r is string => r !== null),
      worldDay: candidate.worldDay ?? input.worldDay,
      importance,
      confidence: candidate.confidence,
      visibility: candidate.visibility,
    });

    // Knowledge isolation at birth. A restricted memory with no knownBy would be
    // invisible to everyone, so an explicit grant is required (docs/06 § 3).
    for (const name of candidate.knownBy) {
      const characterId = resolveId(name);
      if (characterId === null) continue;
      await store.grantKnowledge(characterId, memory.id, "witnessed", 1, input.worldDay);
    }

    stored.push(memory);
  }

  // ── embed. Background in production; inline here because the lab needs the
  // vectors immediately and the mock embedder costs nothing.
  if (stored.length > 0) {
    const vectors = await embedder.embed(stored.map((m) => m.content));
    for (let i = 0; i < stored.length; i++) {
      const vector = vectors[i];
      const memory = stored[i];
      if (vector && memory) {
        await store.setEmbedding(memory.id, vector, embedder.id, embedder.version);
      }
    }
  }

  return {
    gate,
    skipped: false,
    stored,
    merged,
    rejected,
    repairAttempted,
    promptVersion: prompt.version,
  };
}

/**
 * Tolerant parse: models wrap JSON in prose or code fences even when told not to.
 * Extracts the first balanced JSON object, then validates with Zod. Never returns
 * an unvalidated object — an unvalidated model object reaching a database write
 * is a hard-rule violation (CLAUDE.md § 5).
 */
function tryParse(text: string): ExtractionResult | null {
  const candidates = [text, stripFence(text), firstJsonObject(text)].filter(
    (c): c is string => c !== null,
  );

  for (const candidate of candidates) {
    try {
      const result = ExtractionResultSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {
      continue;
    }
  }
  return null;
}

function stripFence(text: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
