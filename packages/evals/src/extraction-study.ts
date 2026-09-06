import { readFileSync } from "node:fs";
import { AIError, type ModelDescriptor } from "@darkforest/contracts";
import { CredentialRegistry, GroqProvider } from "@darkforest/ai";
import { extractEvents } from "@darkforest/memory";
import { STUDY_CASES, type StudyCase } from "./fixtures/extraction-study.js";

/**
 * THE EXTRACTION STUDY — v1.1 against v1.2, on held-out sentences. V1-T19.
 *
 * Four design decisions, each because a previous measurement went wrong in
 * exactly that way:
 *
 *  1. ONE MODEL, PINNED. The scheduler ignores the model argument and chooses
 *     by capacity, so a run through it cannot attribute a result to anything.
 *     Pinning also makes rate limiting VISIBLE instead of silently rerouting to
 *     a different model mid-run.
 *
 *  2. THE ARMS ARE INTERLEAVED, per fixture, A then B. Running all of A and
 *     then all of B measures whatever happened to capacity in between — and
 *     capacity demonstrably degrades over a long run here.
 *
 *  3. IT REFUSES TO REPORT A RATE IT CANNOT STAND BEHIND (ADR-023). A call that
 *     was rate-limited or errored is UNMEASURED, never a miss. The last study
 *     produced a control failure under rate limiting that would have read as a
 *     quality result.
 *
 *  4. NEGATIVES ARE SCORED AS LOUDLY AS POSITIVES. v1.2 deliberately loosens
 *     capture, and the way to score 22/22 on capture is to record everything.
 *     Precision is the thing this change could break, so it is reported first.
 */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const v = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
    if (v) out[m[1]] = v;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env["STUDY_DELAY_MS"] ?? "5000");
/** Both arms of one fixture, then the next. Never all of A then all of B. */
const VARIANTS = ["v1", "v1.2"] as const;
type Variant = (typeof VARIANTS)[number];

type Outcome = "captured" | "empty" | "unmeasured";

interface Cell {
  outcome: Outcome;
  detail: string;
}

/**
 * One extraction, with ONE retry on rate limiting and then an honest surrender.
 *
 * Retrying forever would turn a capacity problem into a very slow quality
 * number; not retrying at all discards work to a transient 429. One retry after
 * a long pause is the compromise, and anything still limited is `unmeasured`.
 */
async function runOne(
  provider: GroqProvider,
  model: ModelDescriptor,
  variant: Variant,
  c: StudyCase,
): Promise<Cell> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(attempt === 0 ? DELAY : 30_000);
    try {
      const out = await extractEvents(provider, model, {
        worldId: "study",
        transcript: [{ speaker: "the user", content: c.text }],
        knownEntities: [
          { ref: "narrator", name: "the user" },
          { ref: "character:1", name: "Sera" },
        ],
        aggressiveness: 0.5,
        sourceTurn: 0,
        nextSeq: 0,
        worldDay: 1,
        promptVariant: variant,
      });
      if (out.events.length > 0) {
        const e = out.events[0];
        return {
          outcome: "captured",
          detail: `${e?.type ?? "?"}: ${e?.value ?? e?.object ?? ""}`.slice(0, 58),
        };
      }
      // A parse or schema failure is NOT the model declining — different fix.
      if (out.rejected.length > 0) {
        return { outcome: "unmeasured", detail: out.rejected.map((r) => r.reason).join(",") };
      }
      return { outcome: "empty", detail: "returned []" };
    } catch (e) {
      const limited = e instanceof AIError && e.code === "RATE_LIMITED";
      if (limited && attempt === 0) continue;
      return {
        outcome: "unmeasured",
        detail: limited ? "rate limited" : e instanceof Error ? e.message.slice(0, 40) : "error",
      };
    }
  }
  return { outcome: "unmeasured", detail: "rate limited" };
}

interface Tally {
  captured: number;
  measured: number;
  unmeasured: number;
}

function emptyTally(): Tally {
  return { captured: 0, measured: 0, unmeasured: 0 };
}

function record(t: Tally, cell: Cell): void {
  if (cell.outcome === "unmeasured") {
    t.unmeasured += 1;
    return;
  }
  t.measured += 1;
  if (cell.outcome === "captured") t.captured += 1;
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);
  const groq = new GroqProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("groq", est, Date.now(), modelId);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
    onSuccess: (id, t) => {
      registry.reportSuccess(id, t);
    },
    onRateLimited: (id, ms) => {
      registry.reportRateLimited(id, ms);
    },
    onRejected: (id, r) => {
      registry.reportRejected(id, r);
    },
    onFailure: (id) => {
      registry.reportFailure(id);
    },
  });

  const model = groq.models.find((m) => m.id.includes("gpt-oss-120b"));
  if (model === undefined) throw new Error("gpt-oss-120b is not in the catalogue");

  console.log("\n" + "=".repeat(78));
  console.log("EXTRACTION STUDY — v1.1 vs v1.2 on held-out sentences");
  console.log("=".repeat(78));
  console.log(`\n  model pinned: ${model.id}   ·   scheduler bypassed`);
  console.log(
    `  ${String(STUDY_CASES.length)} sentences ` +
      `(${String(STUDY_CASES.filter((c) => c.durable).length)} durable, ` +
      `${String(STUDY_CASES.filter((c) => !c.durable).length)} negative), both arms interleaved\n`,
  );

  const cells = new Map<string, Cell>();
  for (const c of STUDY_CASES) {
    process.stdout.write(`  ${c.id} ${c.shape.padEnd(17)}`);
    for (const variant of VARIANTS) {
      const cell = await runOne(groq, model, variant, c);
      cells.set(`${c.id}:${variant}`, cell);
      const good = c.durable ? cell.outcome === "captured" : cell.outcome === "empty";
      process.stdout.write(
        cell.outcome === "unmeasured" ? " ?" : good ? " +" : " !",
      );
    }
    const a = cells.get(`${c.id}:v1`);
    const b = cells.get(`${c.id}:v1.2`);
    console.log(`   ${(b?.detail ?? a?.detail ?? "").slice(0, 46)}`);
  }

  // ── report ────────────────────────────────────────────────────────────────
  const byVariant = new Map<Variant, { positives: Tally; negatives: Tally }>();
  const byFamily = new Map<string, Map<Variant, Tally>>();

  for (const variant of VARIANTS) {
    byVariant.set(variant, { positives: emptyTally(), negatives: emptyTally() });
  }
  for (const c of STUDY_CASES) {
    for (const variant of VARIANTS) {
      const cell = cells.get(`${c.id}:${variant}`);
      if (cell === undefined) continue;
      const v = byVariant.get(variant)!;
      record(c.durable ? v.positives : v.negatives, cell);

      if (c.durable) {
        const fam = byFamily.get(c.family) ?? new Map<Variant, Tally>();
        const t = fam.get(variant) ?? emptyTally();
        record(t, cell);
        fam.set(variant, t);
        byFamily.set(c.family, fam);
      }
    }
  }

  console.log("\n" + "-".repeat(78));
  console.log("  CAPTURE, by family — over MEASURED calls only\n");
  console.log(`    ${"".padEnd(14)}${"v1.1".padStart(14)}${"v1.2".padStart(14)}`);
  for (const [family, perVariant] of [...byFamily.entries()].sort()) {
    const a = perVariant.get("v1") ?? emptyTally();
    const b = perVariant.get("v1.2") ?? emptyTally();
    console.log(
      `    ${family.padEnd(14)}` +
        (`${String(a.captured)}/${String(a.measured)} ` + pct(a.captured, a.measured)).padStart(14) +
        (`${String(b.captured)}/${String(b.measured)} ` + pct(b.captured, b.measured)).padStart(14),
    );
  }

  console.log("\n  PER SHAPE — v1.1 -> v1.2\n");
  for (const c of STUDY_CASES.filter((x) => x.durable)) {
    const a = cells.get(`${c.id}:v1`);
    const b = cells.get(`${c.id}:v1.2`);
    const mark = (cell: Cell | undefined): string =>
      cell === undefined || cell.outcome === "unmeasured" ? "?" : cell.outcome === "captured" ? "kept" : "MISS";
    const before = mark(a);
    const after = mark(b);
    const changed = before !== after ? "   <—" : "";
    console.log(`    ${c.id} ${c.shape.padEnd(17)} ${before.padEnd(5)} -> ${after.padEnd(5)}${changed}`);
  }

  console.log("\n" + "=".repeat(78));
  let refused = false;
  for (const variant of VARIANTS) {
    const v = byVariant.get(variant)!;
    const totalUnmeasured = v.positives.unmeasured + v.negatives.unmeasured;
    const totalCalls = STUDY_CASES.length;

    console.log(
      `  ${variant.padEnd(6)} capture ${String(v.positives.captured)}/${String(v.positives.measured)} ` +
        `${pct(v.positives.captured, v.positives.measured)}   ` +
        `false positives ${String(v.negatives.captured)}/${String(v.negatives.measured)}   ` +
        `unmeasured ${String(totalUnmeasured)}`,
    );

    /*
     * ADR-023: a benchmark that cannot produce a valid number must refuse to
     * produce one. A fifth of the run lost to capacity is not a result with a
     * caveat, it is a different experiment.
     */
    if (totalUnmeasured > totalCalls * 0.2) {
      refused = true;
      console.log(
        `         ^ ${String(totalUnmeasured)} of ${String(totalCalls)} calls did not ` +
          "complete. This is NOT a result. Wait for capacity and re-run.",
      );
    }
  }

  if (refused) {
    console.log("\n  REFUSED — too much of this run was lost to capacity (ADR-023).\n");
    process.exitCode = 1;
    return;
  }

  console.log(
    "\n  Read capture and false positives together. v1.2 deliberately loosens\n" +
      "  capture, so a rise in capture with a rise in false positives is not an\n" +
      "  improvement — it is a different failure.",
  );
  console.log("=".repeat(78) + "\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
