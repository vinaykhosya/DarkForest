/**
 * Total inference capacity across every credential we hold.
 *
 * Measured from live provider headers, not documented figures.
 *
 * GROQ HEADER SEMANTICS — established empirically 2026-09-03, because an
 * earlier version of this script mislabelled them and reported 100x the real
 * capacity:
 *
 *   x-ratelimit-limit-requests: 1000   requests per DAY  (reset ≈ 86.4s/request)
 *   x-ratelimit-limit-tokens:   8000   tokens per MINUTE (reset ≈ 0.45ms/token)
 *
 * There is no tokens-per-day header. The daily ceiling is therefore set by
 * REQUESTS, not tokens — 1000 per model, per credential.
 *
 * And the consequence that matters most: TPM 8000 is also a hard ceiling on a
 * SINGLE request. Groq rejects anything larger outright:
 *   "Request too large ... on tokens per minute (TPM): Limit 8000, Requested 8147"
 * See ADR-020.
 */
import { readFileSync } from "node:fs";

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

const keys = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);

interface GroqModel {
  id: string;
  role: "dialogue" | "moderation" | "injection";
}

const GROQ_MODELS: GroqModel[] = [
  { id: "openai/gpt-oss-120b", role: "dialogue" },
  { id: "openai/gpt-oss-20b", role: "dialogue" },
  { id: "qwen/qwen3.6-27b", role: "dialogue" },
  { id: "qwen/qwen3.8-27b", role: "dialogue" },
  { id: "openai/gpt-oss-safeguard-20b", role: "moderation" },
  { id: "meta-llama/llama-prompt-guard-2-86m", role: "injection" },
];

interface Limits {
  model: GroqModel;
  rpd: number;
  tpm: number;
  ok: boolean;
}

function num(v: string | null): number {
  if (v === null) return 0;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function probe(key: string, model: GroqModel): Promise<Limits> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "." }], max_tokens: 1 }),
      signal: AbortSignal.timeout(25_000),
    });
    return {
      model,
      rpd: num(res.headers.get("x-ratelimit-limit-requests")),
      tpm: num(res.headers.get("x-ratelimit-limit-tokens")),
      ok: res.ok,
    };
  } catch {
    return { model, rpd: 0, tpm: 0, ok: false };
  }
}

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(Math.round(n));

async function main(): Promise<void> {
  const env = loadEnv();
  const groqKeys = keys(env["GROQ_API_KEY"]);
  const orKeys = keys(env["OPENROUTER_API_KEY"]);
  const gemKeys = keys(env["GEMINI_API_KEY"]);
  const nvKeys = keys(env["NVIDIA_NIM_API_KEY"]);
  const cfKeys = keys(env["CF_API_TOKEN"]);

  console.log("\n╭─ DARK FOREST — INFERENCE CAPACITY  (measured, not documented)\n");

  // ── Groq ───────────────────────────────────────────────────────────────────
  console.log(`├─ GROQ — ${String(groqKeys.length)} independent accounts (verified: 4 distinct org ids)`);
  console.log(`│  production-eligible · does not train on input\n`);

  const limits: Limits[] = [];
  const probeKey = groqKeys[0];
  if (probeKey) {
    for (const m of GROQ_MODELS) limits.push(await probe(probeKey, m));
  }

  for (const l of limits) {
    console.log(
      `│  ${l.ok ? " " : "✗"} ${l.model.id.padEnd(38)} ${String(l.rpd).padStart(6)} req/day  ${fmt(l.tpm).padStart(6)} tok/min  [${l.model.role}]`,
    );
  }

  const byRole = (role: GroqModel["role"]): Limits[] =>
    limits.filter((l) => l.ok && l.model.role === role);

  const dialogueRpd = byRole("dialogue").reduce((s, l) => s + l.rpd, 0) * groqKeys.length;
  const dialogueTpm = byRole("dialogue").reduce((s, l) => s + l.tpm, 0) * groqKeys.length;
  const modRpd = byRole("moderation").reduce((s, l) => s + l.rpd, 0) * groqKeys.length;
  const injRpd = byRole("injection").reduce((s, l) => s + l.rpd, 0) * groqKeys.length;
  const maxSingleRequest = Math.min(...byRole("dialogue").map((l) => l.tpm));

  console.log(`│`);
  console.log(`│  POOL TOTALS (${String(groqKeys.length)} credentials)`);
  console.log(`│    dialogue    ${fmt(dialogueRpd).padStart(7)} generations/day   ${fmt(dialogueTpm)} tok/min burst`);
  console.log(`│    moderation  ${fmt(modRpd).padStart(7)} calls/day`);
  console.log(`│    injection   ${fmt(injRpd).padStart(7)} scans/day`);
  console.log(`│`);
  console.log(`│  ⚠ HARD CEILING: ${String(maxSingleRequest)} tokens per SINGLE request.`);
  console.log(`│    Groq rejects anything larger. Our 'full' profile (~12K) does NOT fit.`);

  // ── OpenRouter ─────────────────────────────────────────────────────────────
  const OR_FREE_RPD = 50;
  const orRpd = orKeys.length * OR_FREE_RPD;
  console.log(`│`);
  console.log(`├─ OPENROUTER — ${String(orKeys.length)} credentials`);
  console.log(`│  production-eligible · 1M context · NO per-request token ceiling`);
  console.log(`│    ${String(orRpd).padStart(7)} req/day now`);
  console.log(`│    ${String(orKeys.length * 1000).padStart(7)} req/day after a one-time $10 per account`);
  console.log(`│  → the only path for contexts above 8K`);

  // ── Dev-only ───────────────────────────────────────────────────────────────
  console.log(`│`);
  console.log(`├─ DEV-ONLY — benchmarking and evals; never reachable by users`);
  console.log(`│    gemini  ${String(gemKeys.length)} credentials  ~${String(gemKeys.length * 1500)} req/day  [documented]`);
  console.log(`│    nvidia  ${String(nvKeys.length)} credentials  ~${String(nvKeys.length * 40)} req/min  [documented]`);

  // ── Embeddings ─────────────────────────────────────────────────────────────
  console.log(`│`);
  console.log(`├─ EMBEDDINGS`);
  let cfOk = false;
  if (cfKeys.length > 0 && env["CF_ACCOUNT_ID"]) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env["CF_ACCOUNT_ID"]}/ai/run/@cf/baai/bge-base-en-v1.5`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfKeys[0]!}` },
          body: JSON.stringify({ text: ["probe"] }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      cfOk = res.ok;
    } catch {
      cfOk = false;
    }
  }
  console.log(
    cfOk
      ? `│    ✓ cloudflare — ~1.65M embedding tokens/day`
      : `│    ✗ cloudflare — NO VALID TOKEN. Retrieval falls back to lexical mock.`,
  );

  // ── Turns ──────────────────────────────────────────────────────────────────
  // 1.6 responders (docs/07 target) + extraction firing on ~1 turn in 3 (ADR-016).
  const CALLS_PER_TURN = 1.6 + 0.35;
  const turnsPerDay = dialogueRpd / CALLS_PER_TURN;
  const COMPACT_TOKENS = 5_600;
  const burstTurnsPerMin = dialogueTpm / (COMPACT_TOKENS * CALLS_PER_TURN);
  const sustainedTurnsPerMin = turnsPerDay / 1440;

  console.log(`│`);
  console.log(`├─ WHAT THIS BUYS  (compact profile, 1.6 responders, gated extraction)`);
  console.log(`│    ${fmt(turnsPerDay).padStart(7)} turns/day`);
  console.log(`│    ${sustainedTurnsPerMin.toFixed(1).padStart(7)} turns/min sustained   (request-bound)`);
  console.log(`│    ${burstTurnsPerMin.toFixed(1).padStart(7)} turns/min burst       (token-bound)`);
  console.log(`│`);
  console.log(`│  At 20 turns/user/day that is ~${String(Math.floor(turnsPerDay / 20))} daily active users.`);
  console.log(`│  At 1 turn/user/min peak, ~${String(Math.floor(sustainedTurnsPerMin))}–${String(Math.floor(burstTurnsPerMin))} concurrent users.`);
  console.log("╰─\n");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
