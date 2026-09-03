/**
 * Verifies EVERY credential in every pool.
 *
 * A pool is only as good as its worst member: one dead key becomes a failed
 * request and a retry on every rotation until it is disabled. Better to find
 * them here than in the latency graph.
 *
 * Prints credential IDs and outcomes. Never a key.
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

async function probe(
  label: string,
  fn: () => Promise<Response>,
): Promise<boolean> {
  try {
    const res = await fn();
    const ok = res.ok;
    let extra = "";
    if (!ok) extra = ` HTTP ${String(res.status)}`;
    console.log(`  ${ok ? "✓" : "✗"} ${label}${extra}`);
    return ok;
  } catch (e) {
    console.log(`  ✗ ${label} — ${(e as Error).message.slice(0, 60)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const t = AbortSignal.timeout.bind(AbortSignal);
  let total = 0;
  let ok = 0;

  console.log("\nCredential pool verification — every key in every pool\n");

  const groq = keys(env["GROQ_API_KEY"]);
  if (groq.length) {
    console.log(`groq (${String(groq.length)} credentials)`);
    for (let i = 0; i < groq.length; i++) {
      total++;
      if (await probe(`groq-${String(i + 1)}`, () =>
        fetch("https://api.groq.com/openai/v1/models", {
          headers: { authorization: `Bearer ${groq[i]!}` }, signal: t(20000),
        }))) ok++;
    }
  }

  const or = keys(env["OPENROUTER_API_KEY"]);
  if (or.length) {
    console.log(`\nopenrouter (${String(or.length)} credentials)`);
    for (let i = 0; i < or.length; i++) {
      total++;
      if (await probe(`openrouter-${String(i + 1)}`, () =>
        fetch("https://openrouter.ai/api/v1/key", {
          headers: { authorization: `Bearer ${or[i]!}` }, signal: t(20000),
        }))) ok++;
    }
  }

  const gem = keys(env["GEMINI_API_KEY"]);
  if (gem.length) {
    console.log(`\ngemini (${String(gem.length)} credentials) — DEV ONLY`);
    for (let i = 0; i < gem.length; i++) {
      total++;
      if (await probe(`gemini-${String(i + 1)}`, () =>
        fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${gem[i]!}`,
          { signal: t(20000) }))) ok++;
    }
  }

  const nv = keys(env["NVIDIA_NIM_API_KEY"]);
  if (nv.length) {
    console.log(`\nnvidia (${String(nv.length)} credentials) — DEV ONLY`);
    for (let i = 0; i < nv.length; i++) {
      total++;
      if (await probe(`nvidia-${String(i + 1)}`, () =>
        fetch("https://integrate.api.nvidia.com/v1/models", {
          headers: { authorization: `Bearer ${nv[i]!}` }, signal: t(20000),
        }))) ok++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${String(ok)}/${String(total)} credentials live\n`);
  if (ok < total) process.exitCode = 1;
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
