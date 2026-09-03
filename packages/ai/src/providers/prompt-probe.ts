/**
 * Reads back the structured sections of a Dark Forest system prompt
 * (docs/09-context-builder-and-prompts.md § 3).
 *
 * WHY THE MOCK PARSES ITS OWN PROMPT
 * ----------------------------------
 * A mock that ignores its input can only prove that plumbing exists. This one
 * reads the prompt, so its output is a function of what the context builder
 * actually assembled.
 *
 * The practical effect: if retrieval silently returns nothing, or the budget
 * packer drops every memory, the mock produces a response with no memory echo
 * and the memory-loop test fails — instead of passing against a plausible-looking
 * canned string. That turns the mock from a stub into an assertion surface for
 * the one thing Phase 1 exists to prove (docs/15 § 3, suite 1).
 *
 * It is deliberately tolerant: a section that is absent yields an empty result,
 * never an exception. The mock must keep working while the prompt format evolves.
 */

export interface PromptProbe {
  characterName: string | null;
  /** Memory lines, with their day stamp where present. */
  memories: Array<{ day: number | null; content: string }>;
  presentCharacters: string[];
  worldDay: number | null;
  location: string | null;
  /** Lines this character is forbidden from doing — checked by the forbidden test. */
  forbidden: string[];
  hasVoiceAnchors: boolean;
  hasPriorSpeakers: boolean;
}

const SECTION = /^──\s*(.+?)\s*─+$/;

function sectionsOf(prompt: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "PREAMBLE";
  out.set(current, []);
  for (const line of prompt.split(/\r?\n/)) {
    const match = SECTION.exec(line.trim());
    if (match?.[1] !== undefined) {
      current = match[1].toUpperCase();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current)?.push(line);
  }
  return out;
}

export function probePrompt(prompt: string): PromptProbe {
  const sections = sectionsOf(prompt);

  // "── YOU ARE ELENA ──" — the heading itself carries the name.
  let characterName: string | null = null;
  for (const key of sections.keys()) {
    const m = /^YOU ARE\s+(.+)$/.exec(key);
    if (m?.[1] !== undefined) {
      characterName = m[1].trim();
      break;
    }
  }

  const memories: Array<{ day: number | null; content: string }> = [];
  for (const line of sections.get("WHAT YOU KNOW") ?? []) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("•")) continue;
    const body = trimmed.slice(1).trim();
    const dayMatch = /^\[day\s+(\d+)\]\s*(.*)$/i.exec(body);
    if (dayMatch?.[1] !== undefined && dayMatch[2] !== undefined) {
      memories.push({ day: Number(dayMatch[1]), content: dayMatch[2].trim() });
    } else if (body.length > 0) {
      memories.push({ day: null, content: body });
    }
  }

  const now = (sections.get("RIGHT NOW") ?? []).join("\n");
  const presentMatch = /Present:\s*(.+)/i.exec(now);
  const presentCharacters =
    presentMatch?.[1]
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [];

  const dayMatch = /Day\s+(\d+)/i.exec(now);
  const worldDay = dayMatch?.[1] !== undefined ? Number(dayMatch[1]) : null;

  const locMatch = /Day\s+\d+,\s*[\w_]+\s*·\s*([^\n·]+)/i.exec(now);
  const location = locMatch?.[1]?.trim() ?? null;

  const youAreSection =
    characterName === null ? [] : (sections.get(`YOU ARE ${characterName.toUpperCase()}`) ?? []);
  const youAreText = youAreSection.join("\n");

  const forbiddenMatch = /You never:\s*(.+)/i.exec(youAreText);
  const forbidden =
    forbiddenMatch?.[1]
      ?.split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [];

  return {
    characterName,
    memories,
    presentCharacters,
    worldDay,
    location,
    forbidden,
    // Voice anchors render as ›-prefixed quoted lines (docs/09 § 3).
    hasVoiceAnchors: /^\s*›\s*"/m.test(youAreText),
    hasPriorSpeakers: /Just now, in this moment/i.test(prompt),
  };
}
