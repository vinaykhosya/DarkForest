/**
 * P1-T02 — empirical provider verification.
 *
 * Documentation matrices are routinely ahead of reality, so every capability we
 * route on is confirmed by an actual call rather than by reading a table:
 * does the key work, does the model exist, does tool calling work, does JSON
 * mode work, and what does it actually cost in tokens.
 *
 * Results feed docs/benchmarks/. A model with no verified row is not routable
 * (docs/08 § 4).
 *
 * Prints capability outcomes only — never a key, never a response body.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Check {
  provider: string;
  target: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

function loadEnv(): Record<string, string> {
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const value = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
    if (value.length > 0) out[m[1]] = value;
  }
  return out;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const result = await fn();
  return [result, Date.now() - t0];
}

const TIMEOUT_MS = 30_000;

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ── Groq ─────────────────────────────────────────────────────────────────────

const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];

async function checkGroq(key: string): Promise<Check[]> {
  const checks: Check[] = [];
  const auth = { authorization: `Bearer ${key}` };

  // 1. Which models does this key actually see?
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((v): v is string => typeof v === "string");
    checks.push({
      provider: "groq",
      target: "auth + model list",
      ok: res.ok,
      detail: res.ok ? `${String(ids.length)} models visible` : `HTTP ${String(res.status)}`,
    });
    for (const wanted of GROQ_MODELS) {
      checks.push({
        provider: "groq",
        target: `catalogue: ${wanted}`,
        ok: ids.includes(wanted),
        detail: ids.includes(wanted) ? "present" : "NOT in catalogue",
      });
    }
  } catch (e) {
    checks.push({
      provider: "groq",
      target: "auth + model list",
      ok: false,
      detail: (e as Error).message,
    });
    return checks;
  }

  const model = GROQ_MODELS[0]!;

  // 2. Plain completion + real token accounting.
  try {
    const [r, ms] = await timed(() =>
      post("https://api.groq.com/openai/v1/chat/completions", auth, {
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 10,
        temperature: 0,
      }),
    );
    const usage = (r.json?.["usage"] ?? {}) as Record<string, number>;
    checks.push({
      provider: "groq",
      target: "chat completion",
      ok: r.status === 200,
      detail:
        r.status === 200
          ? `in=${String(usage["prompt_tokens"] ?? 0)} out=${String(usage["completion_tokens"] ?? 0)}`
          : `HTTP ${String(r.status)}`,
      latencyMs: ms,
    });
  } catch (e) {
    checks.push({
      provider: "groq",
      target: "chat completion",
      ok: false,
      detail: (e as Error).message,
    });
  }

  // 3. Tool calling — the extraction path depends on it when JSON mode is absent.
  try {
    const r = await post("https://api.groq.com/openai/v1/chat/completions", auth, {
      model,
      messages: [{ role: "user", content: "Record an event titled 'the gate opened'." }],
      tools: [
        {
          type: "function",
          function: {
            name: "record_event",
            description: "Record a world event",
            parameters: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 120,
    });
    const choices = (r.json?.["choices"] ?? []) as Array<{
      message?: { tool_calls?: unknown[] };
    }>;
    const calls = choices[0]?.message?.tool_calls ?? [];
    checks.push({
      provider: "groq",
      target: "tool calling",
      ok: r.status === 200 && calls.length > 0,
      detail: r.status === 200 ? `${String(calls.length)} tool_call(s)` : `HTTP ${String(r.status)}`,
    });
  } catch (e) {
    checks.push({
      provider: "groq",
      target: "tool calling",
      ok: false,
      detail: (e as Error).message,
    });
  }

  // 4. JSON mode — preferred over tool calling for extraction when available.
  try {
    const r = await post("https://api.groq.com/openai/v1/chat/completions", auth, {
      model,
      messages: [
        { role: "user", content: 'Return JSON: {"memories":[]} and nothing else.' },
      ],
      response_format: { type: "json_object" },
      max_tokens: 60,
    });
    const choices = (r.json?.["choices"] ?? []) as Array<{ message?: { content?: string } }>;
    let parses = false;
    try {
      JSON.parse(choices[0]?.message?.content ?? "");
      parses = true;
    } catch {
      parses = false;
    }
    checks.push({
      provider: "groq",
      target: "json mode (response_format)",
      ok: r.status === 200 && parses,
      detail: r.status === 200 ? (parses ? "valid JSON returned" : "returned unparseable") : `HTTP ${String(r.status)}`,
    });
  } catch (e) {
    checks.push({
      provider: "groq",
      target: "json mode (response_format)",
      ok: false,
      detail: (e as Error).message,
    });
  }

  return checks;
}

// ── Cloudflare Workers AI (embeddings) ───────────────────────────────────────

async function checkCloudflare(accountId: string, token: string): Promise<Check[]> {
  const checks: Check[] = [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-base-en-v1.5`;
  try {
    const [r, ms] = await timed(() =>
      post(url, { authorization: `Bearer ${token}` }, { text: ["hello world", "second string"] }),
    );
    const result = (r.json?.["result"] ?? {}) as { data?: number[][]; shape?: number[] };
    const dims = result.data?.[0]?.length ?? 0;
    const count = result.data?.length ?? 0;
    checks.push({
      provider: "cloudflare",
      target: "bge-base-en-v1.5 embeddings",
      ok: r.status === 200 && dims === 768,
      detail:
        r.status === 200
          ? `${String(count)} vectors, ${String(dims)} dims${dims === 768 ? " ✓ matches schema" : " ✗ SCHEMA MISMATCH"}`
          : `HTTP ${String(r.status)} — ${r.text.slice(0, 160)}`,
      latencyMs: ms,
    });
  } catch (e) {
    checks.push({
      provider: "cloudflare",
      target: "bge-base-en-v1.5 embeddings",
      ok: false,
      detail: (e as Error).message,
    });
  }
  return checks;
}

// ── OpenRouter ───────────────────────────────────────────────────────────────

const OR_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

async function checkOpenRouter(key: string): Promise<Check[]> {
  const checks: Check[] = [];
  const auth = { authorization: `Bearer ${key}` };

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    checks.push({
      provider: "openrouter",
      target: "auth + quota",
      ok: res.ok,
      detail: res.ok
        ? `limit=${String(d["limit"] ?? "n/a")} used=${String(d["usage"] ?? 0)} rpd_free=${String(d["rate_limit"] ?? "n/a")}`
        : `HTTP ${String(res.status)}`,
    });
  } catch (e) {
    checks.push({
      provider: "openrouter",
      target: "auth + quota",
      ok: false,
      detail: (e as Error).message,
    });
  }

  // Only probe the first model — free tier is 50 req/day and this script must
  // not eat a meaningful share of it.
  const model = OR_MODELS[0]!;
  try {
    const [r, ms] = await timed(() =>
      post("https://openrouter.ai/api/v1/chat/completions", auth, {
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 10,
      }),
    );
    checks.push({
      provider: "openrouter",
      target: model,
      ok: r.status === 200,
      detail: r.status === 200 ? "reachable" : `HTTP ${String(r.status)} — ${r.text.slice(0, 120)}`,
      latencyMs: ms,
    });
  } catch (e) {
    checks.push({ provider: "openrouter", target: model, ok: false, detail: (e as Error).message });
  }

  return checks;
}

// ── Dev-only providers: reachability only ────────────────────────────────────

async function checkGemini(key: string): Promise<Check[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const body = (await res.json()) as { models?: unknown[] };
    return [
      {
        provider: "gemini (DEV ONLY)",
        target: "auth + model list",
        ok: res.ok,
        detail: res.ok ? `${String(body.models?.length ?? 0)} models` : `HTTP ${String(res.status)}`,
      },
    ];
  } catch (e) {
    return [
      {
        provider: "gemini (DEV ONLY)",
        target: "auth + model list",
        ok: false,
        detail: (e as Error).message,
      },
    ];
  }
}

async function checkNvidia(key: string): Promise<Check[]> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { data?: unknown[] };
    return [
      {
        provider: "nvidia (DEV ONLY)",
        target: "auth + model list",
        ok: res.ok,
        detail: res.ok ? `${String(body.data?.length ?? 0)} models` : `HTTP ${String(res.status)}`,
      },
    ];
  } catch (e) {
    return [
      {
        provider: "nvidia (DEV ONLY)",
        target: "auth + model list",
        ok: false,
        detail: (e as Error).message,
      },
    ];
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const all: Check[] = [];

  const run = async (name: string, fn: () => Promise<Check[]>): Promise<void> => {
    process.stdout.write(`  probing ${name}...\n`);
    all.push(...(await fn()));
  };

  console.log("\nP1-T02 — empirical provider verification\n");

  if (env["GROQ_API_KEY"]) await run("groq", () => checkGroq(env["GROQ_API_KEY"]!));
  if (env["CF_ACCOUNT_ID"] && env["CF_API_TOKEN"]) {
    await run("cloudflare", () => checkCloudflare(env["CF_ACCOUNT_ID"]!, env["CF_API_TOKEN"]!));
  }
  if (env["OPENROUTER_API_KEY"]) {
    await run("openrouter", () => checkOpenRouter(env["OPENROUTER_API_KEY"]!));
  }
  if (env["GEMINI_API_KEY"]) await run("gemini", () => checkGemini(env["GEMINI_API_KEY"]!));
  if (env["NVIDIA_NIM_API_KEY"]) {
    await run("nvidia", () => checkNvidia(env["NVIDIA_NIM_API_KEY"]!));
  }

  console.log("\n" + "─".repeat(78));
  let lastProvider = "";
  for (const c of all) {
    if (c.provider !== lastProvider) {
      console.log(`\n${c.provider}`);
      lastProvider = c.provider;
    }
    const mark = c.ok ? "✓" : "✗";
    const lat = c.latencyMs === undefined ? "" : `  ${String(c.latencyMs)}ms`;
    console.log(`  ${mark} ${c.target.padEnd(34)} ${c.detail}${lat}`);
  }

  const failed = all.filter((c) => !c.ok);
  console.log("\n" + "─".repeat(78));
  console.log(`${String(all.length - failed.length)}/${String(all.length)} checks passed\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
