import { estimateTokens } from "./text.js";
import type { ScoredMemory } from "./scoring.js";

/**
 * Token-budget packing — docs/04-memory-engine.md § 7 and docs/09 § 2.
 *
 * Two rules that matter more than the arithmetic:
 *
 *  1. Memories are dropped WHOLE, never truncated. A half-sentence memory is worse
 *     than an absent one — the model will confidently complete the missing half.
 *
 *  2. Pinned memories are packed first and reported separately when they overflow,
 *     so the UI can tell the user their pins no longer fit rather than silently
 *     discarding an explicit instruction.
 */

export interface PackedMemories {
  selected: ScoredMemory[];
  dropped: ScoredMemory[];
  tokensUsed: number;
  /** True when pinned memories alone exceeded their slot. Surface this in the UI. */
  pinnedOverflow: boolean;
}

export interface PackOptions {
  tokenBudget: number;
  /** Share of the budget reserved for pinned memories before ranked ones compete. */
  pinnedShare?: number;
  maxCount?: number;
  /** Per-memory formatting overhead: bullet, day stamp, newline. */
  perItemOverhead?: number;
}

export function packMemories(
  ranked: readonly ScoredMemory[],
  opts: PackOptions,
): PackedMemories {
  const pinnedShare = opts.pinnedShare ?? 0.3;
  const overhead = opts.perItemOverhead ?? 8;
  const maxCount = opts.maxCount ?? Number.MAX_SAFE_INTEGER;

  const cost = (m: ScoredMemory): number => estimateTokens(m.memory.content) + overhead;

  const pinned = ranked.filter((m) => m.memory.isPinned);
  const unpinned = ranked.filter((m) => !m.memory.isPinned);

  const selected: ScoredMemory[] = [];
  const dropped: ScoredMemory[] = [];
  let used = 0;
  let pinnedOverflow = false;

  const pinnedBudget = Math.floor(opts.tokenBudget * pinnedShare);
  for (const m of pinned) {
    const c = cost(m);
    if (used + c <= pinnedBudget && selected.length < maxCount) {
      selected.push(m);
      used += c;
    } else {
      dropped.push(m);
      pinnedOverflow = true;
    }
  }

  // Ranked memories fill whatever remains — including any unused pinned allowance.
  for (const m of unpinned) {
    const c = cost(m);
    if (used + c <= opts.tokenBudget && selected.length < maxCount) {
      selected.push(m);
      used += c;
    } else {
      dropped.push(m);
    }
  }

  return { selected, dropped, tokensUsed: used, pinnedOverflow };
}

/**
 * Context section budgets — docs/09 § 2, extended by ADR-012.
 *
 * `compact` roughly halves the cost of a generation, which against Groq's
 * 200K tokens/day per-model cap is the difference between ~16 and ~32 generations.
 * Context size is an economic lever here, not only a quality one.
 */
export interface SectionBudget {
  systemFrame: number;
  worldIdentity: number;
  worldRules: number;
  characterIdentity: number;
  goalsSecrets: number;
  relationships: number;
  worldState: number;
  memories: number;
  recentEvents: number;
  conversationSummary: number;
  transcript: number;
  priorSpeakers: number;
  userMessage: number;
  outputInstruction: number;
}

export const FULL_PROFILE: Readonly<SectionBudget> = Object.freeze({
  systemFrame: 400,
  worldIdentity: 200,
  worldRules: 600,
  characterIdentity: 1200,
  goalsSecrets: 400,
  relationships: 400,
  worldState: 300,
  memories: 2500,
  recentEvents: 400,
  conversationSummary: 800,
  transcript: 3000,
  priorSpeakers: 600,
  userMessage: 300,
  outputInstruction: 200,
});

export const COMPACT_PROFILE: Readonly<SectionBudget> = Object.freeze({
  systemFrame: 350,
  worldIdentity: 150,
  worldRules: 350, // hard rules only
  characterIdentity: 900, // voice anchors kept, backstory trimmed
  goalsSecrets: 250,
  relationships: 250,
  worldState: 250,
  memories: 1100, // ~6 memories instead of ~12
  recentEvents: 0, // dropped
  conversationSummary: 0, // dropped
  transcript: 1100, // ~6 messages instead of ~12
  priorSpeakers: 400,
  userMessage: 300,
  outputInstruction: 150,
});

export function totalBudget(b: SectionBudget): number {
  let total = 0;
  for (const value of Object.values(b) as number[]) total += value;
  return total;
}

/**
 * Drop order under pressure — docs/09 § 2.
 *
 * Everything below the "never" line is structural: without it the generation is
 * not a worse answer, it is the wrong character answering a question they were
 * not asked. If the budget cannot be met above that line, the input is malformed
 * (usually a character profile of several thousand tokens) and the data should be
 * fixed rather than the prompt quietly mutilated.
 */
export const DROP_ORDER: readonly (keyof SectionBudget)[] = [
  "conversationSummary",
  "recentEvents",
  "memories",
  "transcript",
  "worldRules",
  "goalsSecrets",
] as const;

export const NEVER_DROP: readonly (keyof SectionBudget)[] = [
  "systemFrame",
  "characterIdentity",
  "worldState",
  "priorSpeakers",
  "userMessage",
  "outputInstruction",
] as const;
