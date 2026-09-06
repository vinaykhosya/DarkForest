import { describe, expect, it } from "vitest";
import * as prompts from "@darkforest/prompts";
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

/**
 * Every extraction prompt the package exports, DISCOVERED rather than listed.
 *
 * The first version named v1 and v2 by hand. v1.2 was then written, shipped to
 * the product, and was invisible to this guard — the one prompt that actually
 * runs was the one prompt not being checked. A hand-maintained list of the
 * things to protect fails open exactly like an undeclared capability does
 * (ADR-031), and for the same reason: it protects what someone remembered.
 *
 * Reading the exports means a new prompt is covered the moment it exists.
 */
function renderedExtractionPrompts(): Array<{ name: string; text: string }> {
  const input = {
    transcript: [{ speaker: "the user", content: "placeholder" }],
    worldDay: 1,
    knownEntities: [{ ref: "narrator", name: "the user" }],
    aggressiveness: 0.5,
  };

  type Renderer = (i: typeof input) => { system: string; user: string };
  const out: Array<{ name: string; text: string }> = [];

  for (const [exportName, value] of Object.entries(prompts)) {
    if (!/^renderExtractEvents/.test(exportName) || typeof value !== "function") continue;
    const rendered = (value as Renderer)(input);
    out.push({ name: `${exportName} system`, text: rendered.system });
    out.push({ name: `${exportName} user`, text: rendered.user });
  }
  return out;
}

describe("no held-out test sentence appears in any extraction prompt", () => {
  const renderedPrompts = renderedExtractionPrompts();

  for (const fixture of HELD_OUT_SENTENCES) {
    it(`${fixture.usedBy}: "${fixture.text.slice(0, 44)}…"`, () => {
      for (const prompt of renderedPrompts) {
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

  it("checks something — the fixture list and the prompt list are both real", () => {
    // A guard over an empty list passes forever and protects nothing.
    expect(HELD_OUT_SENTENCES.length).toBeGreaterThan(8);
    for (const p of renderedPrompts) expect(p.text.length, p.name).toBeGreaterThan(200);
  });

  it("discovers EVERY extraction prompt, including the one the product uses", () => {
    /*
     * The gap this closes: v1.2 shipped to the product while the guard checked
     * only v1 and v2, so the single prompt that actually ran was the one not
     * being checked. Naming the versions here would rebuild the hand-maintained
     * list that failed; instead this asserts that discovery found more than the
     * two originals and that the product's version is among them.
     */
    const names = renderedPrompts.map((p) => p.name);
    expect(names.some((n) => n.includes("V1_2"))).toBe(true);
    expect(new Set(names.map((n) => n.split(" ")[0])).size).toBeGreaterThanOrEqual(3);
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
      for (const p of renderedPrompts) {
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
