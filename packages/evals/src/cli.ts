/**
 * Lab CLI — `pnpm lab [world]`
 *
 * Runs the full memory loop against the mock provider and prints what happened.
 * Free, offline, and the fastest way to see whether a change to retrieval,
 * ranking or the gate made things better or worse before running a full eval.
 */

import { TEST_WORLDS, worldByName } from "./worlds/index.js";
import { formatRun, runLab } from "./lab.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const worlds =
    arg === undefined
      ? TEST_WORLDS
      : [worldByName(arg)].filter((w): w is NonNullable<typeof w> => w !== undefined);

  if (worlds.length === 0) {
    console.error(`No world matching "${arg ?? ""}".`);
    console.error(`Available: ${TEST_WORLDS.map((w) => w.name).join(" · ")}`);
    process.exitCode = 1;
    return;
  }

  for (const world of worlds) {
    // Probe turns are appended after the script and ask about facts planted
    // early — the actual recall test.
    const probes = world.plantedFacts.map((f) => f.question);
    const run = await runLab(world, { probes });
    console.log(formatRun(run));

    /*
     * Two SEPARATE metrics, as docs/15 suite 1 defines them:
     *
     *   recall@k        was the fact present in the RETRIEVED set
     *   answer accuracy did the character actually use it in the reply
     *
     * Conflating them measures the model's phrasing rather than the ranking, and
     * makes a retrieval regression indistinguishable from a generation one.
     * recall@k is the number that gates Phase 1.
     */
    console.log(`│`);
    console.log(`├─ probes                                    recall@k  answered`);
    const probeStart = world.script.length;
    let recalled = 0;
    let answered = 0;

    for (let i = 0; i < world.plantedFacts.length; i++) {
      const fact = world.plantedFacts[i]!;
      const turn = run.turns[probeStart + i];
      if (turn === undefined) continue;

      const retrievedText = turn.retrievedContents.join(" ").toLowerCase();
      const inRetrieved = fact.expectedAnswerContains.some((needle) =>
        retrievedText.includes(needle.toLowerCase()),
      );
      const inResponse = fact.expectedAnswerContains.some((needle) =>
        turn.response.toLowerCase().includes(needle.toLowerCase()),
      );
      if (inRetrieved) recalled += 1;
      if (inResponse) answered += 1;

      const label = fact.question.padEnd(42).slice(0, 42);
      console.log(`│   ${label}   ${inRetrieved ? "✓" : "✗"}         ${inResponse ? "✓" : "✗"}`);
    }

    const n = world.plantedFacts.length;
    const pct = (x: number): string => (n === 0 ? "100" : ((x / n) * 100).toFixed(0));
    console.log(
      `├─ recall@k:        ${String(recalled)}/${String(n)} (${pct(recalled)}%)   ← gates Phase 1`,
    );
    console.log(
      `╰─ answer accuracy: ${String(answered)}/${String(n)} (${pct(answered)}%)`,
    );
    console.log();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
