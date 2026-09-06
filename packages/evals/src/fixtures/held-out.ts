/**
 * HELD-OUT TEST SENTENCES — every sentence used as an evaluation INPUT.
 *
 * One list, in one file, for one reason: so a machine can check that none of
 * them has leaked into a prompt.
 *
 * The rule they exist to enforce is that no test sentence may appear anywhere
 * in the prompt path — worked examples, system instructions, few-shot blocks,
 * or comments that get rendered into the prompt. The evaluator and the prompt
 * must be independently sourced.
 *
 * That rule was already understood and it was still broken. The V0.1 gate
 * fixture ("I can't swim. I never learned") and probe case S04 were added to
 * the extraction prompt as worked examples while fixing an ontology gap, and
 * every number measured afterwards was recall of an example rather than
 * generalisation of a category:
 *
 *     with the fixture in the prompt        extraction  7-9 / 10
 *     examples in unrelated domains         extraction    1 / 10
 *
 * Nothing objected, because the rule lived in a person's head. `contamination.test.ts`
 * is the version of it that cannot be forgotten.
 *
 * ADDING A FIXTURE: put its sentence here as well as in the probe. The guard
 * only protects what it can see.
 */

export interface HeldOutSentence {
  /** Where it is used, so a failure names the file to change. */
  usedBy: string;
  text: string;
}

export const HELD_OUT_SENTENCES: readonly HeldOutSentence[] = [
  // The V0.1 acceptance gate (scripts/return-visit.ts).
  { usedBy: "v01 gate", text: "I have to tell you something. I can't swim. I never learned." },
  { usedBy: "v01 gate", text: "The ferry's not running. Should we wade across the channel instead?" },

  // The self-description probe (selfdesc-probe.ts).
  { usedBy: "selfdesc S02", text: "My right hand doesn't close properly. It hasn't since the winter." },
  { usedBy: "selfdesc S03", text: "I don't see well in the dark. Never have." },
  { usedBy: "selfdesc S04", text: "I grew up in Ashford. I left when I was fifteen and never went back." },
  { usedBy: "selfdesc S05", text: "I used to be a ferryman on this same channel, years ago." },
  { usedBy: "selfdesc S06", text: "My name is Cass. Everyone here has been calling me the traveller." },
  { usedBy: "selfdesc S07", text: "I can read. Not many out here can, so I keep it quiet." },
  { usedBy: "selfdesc S08", text: "I can't be out after dark. It's a condition of my parole." },
  { usedBy: "selfdesc C01", text: "I hate the smell of tar. Always have." },

  // The extractor shootout (extractor-shootout.ts).
  { usedBy: "shootout F3", text: "I traded my father's compass for a lantern at the market." },
  { usedBy: "shootout F4", text: "I don't see well in the dark. Never have." },
  { usedBy: "shootout F5", text: "My name is Cass. Everyone here has been calling me the traveller." },
  { usedBy: "shootout N1", text: "Morning. Cold one today, isn't it?" },
];

/**
 * The CONTROL sentences, held to the same standard as everything else.
 *
 * These were nearly given an exemption. The promise control resembles the
 * prompt's promise example closely enough to look contaminated — and measured,
 * the two share only two consecutive words, far under the threshold. The
 * exemption was never needed, so there is none: a guard with an unused escape
 * hatch is a guard with a hole in it.
 *
 * They are listed separately only because a control that fails is a different
 * diagnosis from a fixture that fails: the harness is broken, not the model.
 */
export const INTENTIONAL_CONTROLS: readonly string[] = [
  "I promise you I'll be back before sunset.",
];

/** Lowercase, letters and digits only, single-spaced. Punctuation is not a defence. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The longest run of consecutive words shared by two strings.
 *
 * Compared as N-GRAMS rather than by substring equality, because contamination
 * does not need to be verbatim to matter. Changing one word of a test sentence
 * before pasting it into the prompt would defeat an exact-match check and teach
 * the model the answer just as thoroughly.
 */
export function longestSharedRun(a: string, b: string): number {
  const x = normalise(a).split(" ").filter(Boolean);
  const y = normalise(b).split(" ").filter(Boolean);
  if (x.length === 0 || y.length === 0) return 0;

  // Standard longest-common-substring over word arrays, one row at a time.
  let best = 0;
  let previous = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const current = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if ((current[j] ?? 0) > best) best = current[j] ?? 0;
      }
    }
    previous = current;
  }
  return best;
}
