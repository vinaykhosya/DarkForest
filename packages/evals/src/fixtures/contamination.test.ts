import { describe, expect, it } from "vitest";
import {
  renderExtractEventsPrompt,
  renderExtractEventsV2Prompt,
} from "@darkforest/prompts";
import {
  HELD_OUT_SENTENCES,
  INTENTIONAL_CONTROLS,
  longestSharedRun,
  normalise,
} from "./held-out.js";

/**
 * THE CONTAMINATION GUARD.
 *
 * A benchmark whose answers are in the prompt is not a benchmark. This project
 * learned that the expensive way: the V0.1 gate fixture was added to the
 * extraction prompt as a worked example, extraction "improved" from 1/10 to
 * 7-9/10, and the improvement was entirely the model reciting an example it had
 * been shown. Removing it returned the honest number, 1/10.
 *
 * Every part of that was known in advance and written down. What was missing
 * was something that would object, so this is it — offline, free, and part of
 * `pnpm check`.
 *
 * WHAT COUNTS AS CONTAMINATION here is a shared run of consecutive words, not a
 * verbatim match. Changing "I can't swim, I never learned" to "I cannot swim, I
 * never learned" before pasting it into a prompt would defeat an exact-match
 * check and teach the answer just as well.
 */

/**
 * Five words, and the number was measured rather than chosen.
 *
 * At six, the self-test below showed a fixture with TWO words swapped slipping
 * through at a shared run of five — and two substitutions is a light edit, not
 * a rewrite. Five catches it, and every real fixture still clears every real
 * prompt, so it costs no false positives here.
 *
 * WHAT IT DOES NOT CATCH: a genuinely rewritten sentence that teaches the same
 * category. No n-gram check can, and at that point the honest description is
 * that someone wrote a new example rather than pasted a test. The guard is for
 * the mistake that actually happened — a fixture pasted into a prompt — not for
 * a determined effort to defeat it.
 *
 * If a legitimate prompt ever trips this, the fix is to reword the PROMPT.
 * Loosening the threshold to make a failure go away is the same act as putting
 * the answer in the prompt, one step removed.
 */
const MAX_SHARED_WORDS = 4;

/** Every prompt on the extraction path, rendered as the model receives it. */
function renderedExtractionPrompts(): Array<{ name: string; text: string }> {
  const input = {
    transcript: [{ speaker: "the user", content: "placeholder" }],
    worldDay: 1,
    knownEntities: [{ ref: "narrator", name: "the user" }],
    aggressiveness: 0.5,
  };
  const v1 = renderExtractEventsPrompt(input);
  const v2 = renderExtractEventsV2Prompt(input);
  return [
    { name: "extract-events.v1 system", text: v1.system },
    { name: "extract-events.v1 user", text: v1.user },
    { name: "extract-events.v2 system", text: v2.system },
    { name: "extract-events.v2 user", text: v2.user },
  ];
}

describe("no held-out test sentence appears in any extraction prompt", () => {
  const prompts = renderedExtractionPrompts();

  for (const fixture of HELD_OUT_SENTENCES) {
    it(`${fixture.usedBy}: "${fixture.text.slice(0, 44)}…"`, () => {
      for (const prompt of prompts) {
        const shared = longestSharedRun(fixture.text, prompt.text);
        expect(
          shared,
          `${prompt.name} shares ${String(shared)} consecutive words with the ` +
            `${fixture.usedBy} fixture.\n` +
            `  fixture: ${fixture.text}\n` +
            `  Whichever one BORROWED gives way: if a prompt example was pasted ` +
            `from a fixture, move the example; if a fixture was written from an ` +
            `existing example, move the fixture. Never raise the threshold — that ` +
            `puts the answer back in the prompt with extra steps.`,
        ).toBeLessThanOrEqual(MAX_SHARED_WORDS);
      }
    });
  }

  it("checks something — the fixture list is not empty", () => {
    // A guard over an empty list passes forever and protects nothing.
    expect(HELD_OUT_SENTENCES.length).toBeGreaterThan(8);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p.text.length).toBeGreaterThan(200);
  });

  it("would actually catch a leak — the detector, tested against itself", () => {
    /*
     * Without this, a detector that silently returned 0 would make every test
     * above pass while protecting nothing. So the exact failure this file
     * exists to prevent is reconstructed: the real gate fixture, pasted into a
     * prompt as a worked example, which is what actually happened.
     */
    const fixture = "I have to tell you something. I can't swim. I never learned.";
    const contaminated = [
      "You convert a roleplay transcript into structured world events.",
      "WORKED EXAMPLES",
      `  "${fixture}"`,
      '     {"type":"preference_stated","actor":"the user"}',
    ].join("\n");
    expect(longestSharedRun(fixture, contaminated)).toBeGreaterThan(MAX_SHARED_WORDS);

    // And a lightly reworded paste, which an exact-match check would miss.
    const reworded = contaminated.replace("can't", "cannot").replace("I have to", "I ought to");
    expect(longestSharedRun(fixture, reworded)).toBeGreaterThan(MAX_SHARED_WORDS);

    // A genuinely unrelated prompt must NOT trip it, or the guard is a
    // tripwire that fires on everything and gets switched off.
    const clean = "You convert a roleplay transcript into structured world events.";
    expect(longestSharedRun(fixture, clean)).toBeLessThanOrEqual(MAX_SHARED_WORDS);
  });

  it("even the promise CONTROL is not contaminated, so there are no exemptions", () => {
    /*
     * This started as an exemption list. The control "I promise you I'll be
     * back before sunset" looked contaminated because the prompt teaches
     * promises with "I promise Elena I will return before sunset" — but the
     * two share only TWO consecutive words, well under the threshold. The
     * fixture was never contaminated and the exemption was never needed.
     *
     * So there is no exemption mechanism at all. An unused escape hatch on a
     * guard like this is just a hole waiting for someone in a hurry.
     */
    for (const control of INTENTIONAL_CONTROLS) {
      for (const p of prompts) {
        expect(
          longestSharedRun(control, p.text),
          `${control} now overlaps ${p.name}. There is no exemption list: change ` +
            `the prompt example or the fixture.`,
        ).toBeLessThanOrEqual(MAX_SHARED_WORDS);
      }
    }
  });

  it("normalisation makes punctuation and case irrelevant", () => {
    expect(normalise("I can't SWIM.  I never learned!")).toBe("i can t swim i never learned");
    // "swim i never learned" survives the rewording — which is the point.
    expect(longestSharedRun("I can't swim, I never learned", "i cannot swim i never learned")).toBe(
      4,
    );
  });
});
