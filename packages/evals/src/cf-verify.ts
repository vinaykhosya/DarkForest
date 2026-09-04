/**
 * CLOUDFLARE TOKEN VERIFIER.
 *
 * Exists because "is this token the right one?" has now been asked three times
 * and answered three different ways: wrong permission (Account API Tokens Write
 * instead of Workers AI Read), revoked, and wrong product (an R2 token, which
 * cannot call Workers AI at all).
 *
 * Each of those fails with the same opaque 401, so the useful output is not
 * pass/fail but WHICH capability is missing. Reads CF_API_TOKEN and
 * CF_ACCOUNT_ID from .env, or takes a token as argv[2] to test before saving it.
 *
 *   pnpm cf:verify                 # check what is in .env
 *   pnpm cf:verify cfat_xxxxx      # check a candidate first
 */

import { readFileSync } from "node:fs";
import { CLOUDFLARE_EMBEDDING_MODEL } from "@darkforest/ai";

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

interface Check {
  name: string;
  url: string;
  body?: unknown;
  /** What a failure here tells us. */
  meaning: string;
}

async function probe(token: string, check: Check): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(check.url, {
      method: check.body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(check.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(check.body === undefined ? {} : { body: JSON.stringify(check.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const token = process.argv[2] ?? env["CF_API_TOKEN"] ?? "";
  const account = env["CF_ACCOUNT_ID"] ?? "";

  if (!token) {
    console.error("No token: pass one as an argument or set CF_API_TOKEN in .env");
    process.exitCode = 1;
    return;
  }

  // Never print the token itself, only enough to tell two apart.
  console.log(`\ntoken   ${token.slice(0, 9)}…${token.slice(-4)}  (${String(token.length)} chars)`);
  console.log(`account ${account.slice(0, 8)}…\n`);

  const checks: Check[] = [
    {
      name: "token is active",
      url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
      meaning: "token does not exist — not created, not confirmed, or revoked",
    },
    {
      name: "account is readable",
      url: `https://api.cloudflare.com/client/v4/accounts/${account}`,
      meaning: "token is not scoped to this account, or CF_ACCOUNT_ID is wrong",
    },
    {
      name: "Workers AI inference",
      url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${CLOUDFLARE_EMBEDDING_MODEL}`,
      body: { text: ["preflight"] },
      meaning: "token lacks Workers AI, or is an R2/other product token",
    },
  ];

  let allOk = true;
  for (const check of checks) {
    const { status, body } = await probe(token, check);
    const ok = status === 200;
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✓" : "✗"} ${check.name.padEnd(22)} HTTP ${String(status)}`);
    if (!ok) console.log(`      → ${check.meaning}\n      ${body}`);
  }

  console.log(
    allOk
      ? "\nUSABLE — embeddings will work. Save it as CF_API_TOKEN in .env.\n"
      : "\nNOT USABLE. Create one at dash.cloudflare.com → My Profile → API Tokens\n" +
          "  → Create Token → Custom token, with permission:\n" +
          "      Account · Workers AI · Read\n" +
          "  and Account Resources set to the account above. Not the R2 token page —\n" +
          "  R2 tokens are S3 credentials and cannot call Workers AI.\n",
  );
  if (!allOk) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
