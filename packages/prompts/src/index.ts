/**
 * @darkforest/prompts
 *
 * Versioned prompt templates. Every model_requests row records the version that
 * produced it, so a quality regression is always attributable to a specific
 * change (docs/09 § 6).
 *
 * Rules:
 *  · a prompt change is a code change — PR, eval run, recorded results
 *  · no prompt change ships without an eval comparison against the previous
 *    version (CLAUDE.md § 5)
 *  · old versions are retained for at least two releases so a regression can
 *    be bisected
 */

export {
  renderDialoguePrompt,
  renderPriorSpeakers,
  DIALOGUE_PROMPT_VERSION,
  type DialoguePromptInput,
  type DialogueMemory,
  type DialogueRelationship,
  type RenderedPrompt,
} from "./dialogue.v1.js";

export {
  renderExtractPrompt,
  renderRepairPrompt,
  EXTRACT_PROMPT_VERSION,
  type ExtractPromptInput,
} from "./extract.v1.js";

export {
  sanitizeUserContent,
  fence,
  fenceNonce,
  detectPromptLeak,
  TEMPLATE_FINGERPRINTS,
  type SanitizeResult,
} from "./sanitize.js";

/** taskClass → active prompt version. The registry docs/09 § 6 specifies. */
export const ACTIVE_PROMPT_VERSIONS = {
  dialogue: "dialogue/v1",
  dialogue_reaction: "dialogue/v1",
  dialogue_deep: "dialogue/v1",
  extract: "extract/v1",
} as const;

export {
  renderExtractEventsPrompt,
  EXTRACT_EVENTS_PROMPT_VERSION,
  type ExtractEventsInput,
} from "./extract-events.v1.js";

export {
  renderExtractEventsV2Prompt,
  EXTRACT_EVENTS_V2_VERSION,
  type ExtractEventsV2Input,
} from "./extract-events.v2.js";
