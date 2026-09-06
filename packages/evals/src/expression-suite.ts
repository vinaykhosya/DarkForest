/**
 * EXPRESSION SUITE v1 — is the memory USED, not whether it is repeated.
 *
 * Judged rather than matched. The gauntlet's substring matcher cannot tell
 * "Sunset's getting close, we shouldn't linger" — a perfect use of the memory —
 * from silence, and it scores a character who recites the fact higher than one
 * who acts on it. ADR-026 says the matcher is a proxy; this is the instrument
 * for the thing it proxies badly.
 *
 * THREE THINGS THAT MAKE THIS DIFFERENT FROM ANOTHER RECALL BENCHMARK:
 *
 *  1. Context is handed over directly. Retrieval and isolation are measured
 *     elsewhere and are known not to be starving generation, so removing them
 *     isolates expression.
 *  2. One category inverts. In `restraint`, raising the memory is the FAILURE.
 *     Without it every score points toward a character that recites its
 *     database, which is the specific way an AI stops feeling like a person.
 *  3. The judge is a different model from the speaker, and it never sees which
 *     answer we hoped for — only the rubric.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider, SchedulerRouter } from "@darkforest/ai";
import { EXPRESSION_CASES, type ExpressionCase } from "./worlds/expression.js";

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
const DELAY = 4500;

function speakerPrompt(c: ExpressionCase): string {
  return [
    `You are ${c.persona}`,
    ``,
    `WHAT YOU KNOW`,
    ...c.knows.map((k) => `  ${k}`),
    ``,
    `Reply in character, in one or two sentences. Say only what this person`,
    `would say. Do not narrate your reasoning and do not list what you know.`,
  ].join("\n");
}

/**
 * The judge sees the rubric and the reply, and never which way we hoped it
 * would go. Inverted cases carry their inversion inside the rubric text, so the
 * judge applies one rule and the harness does no arithmetic on the verdict.
 */
function judgePrompt(c: ExpressionCase, reply: string): { system: string; user: string } {
  return {
    system: [
      `You judge whether a character's reply uses what they know.`,
      ``,
      `Answer with JSON only: {"verdict":"yes"|"no","why":"<12 words>"}`,
      ``,
      `Judge the REPLY against the STANDARD. Do not reward a reply for quoting a`,
      `fact, and do not punish one for leaving a fact unsaid — a memory can shape`,
      `a decision or a tone without being named, and that counts. Judge only what`,
      `the standard asks.`,
    ].join("\n"),
    user: [
      `THE CHARACTER KNOWS`,
      ...c.knows.map((k) => `  ${k}`),
      ``,
      `THE PLAYER SAID`,
      `  ${c.says}`,
      ``,
      `THE REPLY`,
      `  ${reply}`,
      ``,
      `THE STANDARD`,
      `  ${c.rubric}`,
      ``,
      `Does the reply meet the standard?`,
    ].join("\n"),
  };
}

function parseVerdict(text: string): { verdict: boolean; why: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { verdict?: string; why?: string };
    if (o.verdict !== "yes" && o.verdict !== "no") return null;
    return { verdict: o.verdict === "yes", why: o.why ?? "" };
  } catch {
    return null;
  }
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
  const openrouter = new OpenRouterProvider({
    getCredential: (est, modelId) => {
      const g = registry.acquire("openrouter", est, Date.now(), modelId);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
    onSuccess: (id, t) => {
      registry.reportSuccess(id, t);
    },
  });
  const router = new SchedulerRouter({
    registry,
    adapters: { groq, openrouter },
    providerIds: ["groq", "openrouter"],
    modelsByProvider: { openrouter: openrouter.models.filter((m) => m.tier === "fast") },
    sleep,
    // Benchmark fixtures, on a development machine. All three are false in the
    // product; see SchedulerRouterConfig.content.
    content: { pool: "development", environment: "local", isSyntheticContent: true },
  });

  /*
   * TWO judges must AGREE, and disagreement is recorded as UNMEASURED.
   *
   * v1 ran one judge and scored whatever came back. It gave E-D 1/3 on verdicts
   * that contradicted each other across near-identical replies, and E-F 0/3 on a
   * single verdict because the other two were unparseable. A coin flip printed
   * as a score is worse than an admitted gap: it looks like a finding, and the
   * next decision gets made on it.
   *
   * The two judges are different sizes rather than different families, because
   * gpt-oss is what is verified for `classify` here — qwen fails JSON. A large
   * and a small model agreeing is a weaker claim than two independent families
   * agreeing, and it is the strongest claim the verified set supports.
   *
   * Neither model ever sees which way we hoped the verdict would go.
   */
  const judges = groq.models.filter((m) => m.id.includes("gpt-oss"));
  if (judges.length < 2) throw new Error("expression suite needs two judges");
  const REPS = Number(process.env["EXPR_SUITE_REPS"] ?? "3");

  console.log("\n" + "=".repeat(78));
  console.log("EXPRESSION SUITE v1 — does the memory get USED?");
  console.log("=".repeat(78));
  console.log(
    `  ${String(EXPRESSION_CASES.length)} cases x ${String(REPS)} reps, judged by ` +
      `${judges.map((j) => j.id.split("/").pop() ?? "").join(" + ")}\n` +
      `  a case counts only where both judges agree\n` +
      `  context supplied directly, so this measures expression alone\n`,
  );

  interface Row {
    id: string;
    kind: string;
    passes: number;
    /** Reps where both judges returned a verdict AND agreed. The real denominator. */
    judged: number;
    /** Reps where they split, or one never answered. Reported, never scored. */
    unmeasured: number;
    reps: number;
    inverted: boolean;
    replies: string[];
    whys: string[];
  }
  const rows: Row[] = [];

  for (const c of EXPRESSION_CASES) {
    const row: Row = {
      id: c.id,
      kind: c.kind,
      passes: 0,
      judged: 0,
      unmeasured: 0,
      reps: REPS,
      inverted: c.inverted === true,
      replies: [],
      whys: [],
    };
    process.stdout.write(`  ${c.id.padEnd(18)} ${c.kind.padEnd(22)} `);
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(DELAY);
      try {
        const spoken = await router.generate(
          {
            taskClass: "dialogue",
            system: speakerPrompt(c),
            messages: [{ role: "user", content: c.says }],
            maxTokens: 160,
            temperature: 0.8,
            timeoutMs: 30_000,
            meta: { requestId: `expr-${c.id}-${String(rep)}` },
          },
          router.models[0]!,
        );
        const reply = spoken.text.trim();
        row.replies.push(reply);
        if (reply.length === 0) {
          // No reply is nothing to judge. It is not the character failing to use
          // a memory, so it does not belong in the denominator either.
          row.unmeasured += 1;
          process.stdout.write("_");
          row.whys.push("empty reply");
          continue;
        }

        const jp = judgePrompt(c, reply);
        const verdicts: Array<{ verdict: boolean; why: string }> = [];
        for (const j of judges) {
          // One retry per judge. An unparseable verdict is a lost measurement,
          // and v1 lost two of three that way on the case it then scored 0/3.
          for (let attempt = 0; attempt < 2; attempt++) {
            await sleep(DELAY);
            const out = await router.generate(
              {
                taskClass: "classify",
                system: jp.system,
                messages: [{ role: "user", content: jp.user }],
                maxTokens: 300,
                temperature: 0,
                timeoutMs: 30_000,
                meta: { requestId: `judge-${c.id}-${String(rep)}-${String(attempt)}` },
              },
              j,
            );
            const parsed = parseVerdict(out.text);
            if (parsed !== null) {
              verdicts.push(parsed);
              break;
            }
          }
        }

        const first = verdicts[0];
        if (verdicts.length < judges.length || first === undefined) {
          row.unmeasured += 1;
          process.stdout.write("?");
          row.whys.push("a judge returned nothing parseable twice");
          continue;
        }
        if (!verdicts.every((v) => v.verdict === first.verdict)) {
          // Not a pass and not a failure. Saying so is the entire point.
          row.unmeasured += 1;
          process.stdout.write("~");
          row.whys.push(`SPLIT: ${verdicts.map((v) => v.why).join(" / ")}`);
          continue;
        }
        row.judged += 1;
        if (first.verdict) row.passes += 1;
        row.whys.push(first.why);
        process.stdout.write(first.verdict ? "+" : "!");
      } catch {
        row.unmeasured += 1;
        process.stdout.write("x");
        row.whys.push("call failed");
      }
    }
    console.log(
      `  ${String(row.passes)}/${String(row.judged)}` +
        (row.unmeasured > 0 ? `  (${String(row.unmeasured)} unmeasured)` : ""),
    );
    rows.push(row);
  }

  console.log("\n" + "-".repeat(78));
  console.log("BY CASE");
  for (const r of rows) {
    // "?" is its own mark. A case nobody could judge must not read as a pass or
    // a failure at a glance, which is exactly how v1's E-F came to read as 0/3.
    const mark =
      r.judged === 0 ? "?" : r.passes === r.judged ? " " : r.passes === 0 ? "X" : "~";
    console.log(
      `  ${mark} ${r.id.padEnd(18)} ${r.kind.padEnd(22)} ` +
        `${String(r.passes)}/${String(r.judged)} judged` +
        (r.unmeasured > 0 ? `, ${String(r.unmeasured)} unmeasured` : "") +
        (r.inverted ? "   (pass = did NOT raise it)" : ""),
    );
    const sample = r.replies.find((x) => x.length > 0);
    if (sample !== undefined) console.log(`      reply: ${JSON.stringify(sample.slice(0, 90))}`);
    if (r.passes < r.judged || r.unmeasured > 0) {
      console.log(`      judge: ${r.whys.filter((w) => w).join(" | ").slice(0, 140)}`);
    }
  }

  const total = rows.reduce((a, r) => a + r.judged, 0);
  const passed = rows.reduce((a, r) => a + r.passes, 0);
  const unmeasured = rows.reduce((a, r) => a + r.unmeasured, 0);
  const restraint = rows.filter((r) => r.inverted);
  const restraintOk = restraint.reduce((a, r) => a + r.passes, 0);
  const restraintTotal = restraint.reduce((a, r) => a + r.judged, 0);

  console.log("\n" + "=".repeat(78));
  console.log(
    `  UTILISATION  ${String(passed)}/${String(total)}` +
      (total === 0 ? "" : ` (${((passed / total) * 100).toFixed(0)}%)`) +
      "   over reps both judges agreed on",
  );
  console.log(
    `  RESTRAINT    ${String(restraintOk)}/${String(restraintTotal)} — kept quiet when nobody asked`,
  );
  console.log(
    `  UNMEASURED   ${String(unmeasured)} of ${String(rows.length * REPS)} — split or no verdict. ` +
      "Neither a pass nor a failure.",
  );
  console.log(
    "\n  Read these together. Utilisation alone rewards a character that recites\n" +
      "  everything it knows, and restraint alone rewards one that says nothing.\n" +
      "  A case marked ? was not measured — do not read it as a failing category.",
  );
  console.log("=".repeat(78) + "\n");

  mkdirSync("docs/benchmarks/runs", { recursive: true });
  writeFileSync(
    `docs/benchmarks/runs/${new Date().toISOString().slice(0, 10)}-expression.json`,
    JSON.stringify(rows, null, 2),
    "utf8",
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
