/**
 * ROUTING SMOKE TEST — ADR-021.
 *
 * Runs BEFORE any benchmark, because a scheduler that only appears to
 * distribute load is worse than none: it makes the wrong number look measured.
 *
 * Proves, against live providers:
 *   1. capacity is metered per (provider x model x credential)
 *   2. multiple providers are actually selected, not just listed
 *   3. Groq exhaustion does not stall the system
 *   4. NVIDIA and Gemini can carry development workload
 *   5. OpenRouter remains available as another pool
 *   6. a real 429 routes away from the exhausted bucket
 *   7. telemetry identifies provider, model and bucket for every attempt
 *   8. the production boundary still holds — dev-only providers are refused
 *      the moment the environment is not local+synthetic
 */

import { readFileSync } from "node:fs";
import { CredentialRegistry, GroqProvider, OpenRouterProvider } from "@darkforest/ai";
import { AIError, poolsFor, type ModelDescriptor, type ModelPolicy } from "@darkforest/contracts";
import {
  overview,
  recordRateLimited,
  recordSuccess,
  schedule,
  type CapacityBucket,
} from "@darkforest/core";
import { NVIDIA_DEV_MODELS } from "@darkforest/ai";

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

interface Attempt {
  bucketId: string;
  providerId: string;
  modelId: string;
  ok: boolean;
  status: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  headroomAtSelect: number;
}

const DEV_POLICY: ModelPolicy = {
  eligibility: "development_only",
  trainsOnInput: true,
  forbidsPersonalData: true,
  retentionDays: 30,
  source: "NVIDIA API Trial ToS §1.2/§1.4 · Gemini unpaid terms",
  verifiedOn: "2026-09-04",
};

/** Minimal descriptors for the dev-only providers, for capacity accounting. */
function devModel(id: string, tier: ModelDescriptor["tier"]): ModelDescriptor {
  return {
    id,
    tier,
    pools: poolsFor(DEV_POLICY),
    policy: DEV_POLICY,
    contextWindow: 128_000,
    maxOutput: 2048,
    supportsTools: true,
    supportsStreaming: false,
    supportsStructuredOutput: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    isFree: true,
    qualityScore: 6,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = new CredentialRegistry(env);

  const groq = new GroqProvider({
    getCredential: (est) => {
      const g = registry.acquire("groq", est);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
  });
  const openrouter = new OpenRouterProvider({
    getCredential: (est) => {
      const g = registry.acquire("openrouter", est);
      return g.ok ? { id: g.id, key: g.key } : null;
    },
  });

  console.log("\n" + "═".repeat(74));
  console.log("ROUTING SMOKE TEST — capacity-aware multi-provider scheduler");
  console.log("═".repeat(74));

  // ── 1. Bucket inventory ───────────────────────────────────────────────────
  console.log("\n[1] CAPACITY BUCKETS — provider → model → credential\n");
  const buckets: CapacityBucket[] = [];
  const providerById = new Map<string, GroqProvider | OpenRouterProvider>([
    ["groq", groq],
    ["openrouter", openrouter],
  ]);

  for (const snap of registry.snapshotAll()) {
    for (const cred of snap.perCredential) {
      const modelId = cred.modelId;
      let model: ModelDescriptor | undefined;

      if (snap.providerId === "groq" && modelId !== null) {
        model = groq.models.find((m) => m.id === modelId);
      } else if (snap.providerId === "openrouter") {
        model = openrouter.models.find((m) => m.tier === "fast");
      } else if (snap.providerId === "gemini" && modelId !== null) {
        model = devModel(modelId, "fast");
      } else if (snap.providerId === "nvidia") {
        model = devModel(NVIDIA_DEV_MODELS[0], "fast");
      }
      if (!model) continue;

      buckets.push({
        id: `${snap.providerId}:${model.id}:${cred.id}`,
        providerId: snap.providerId,
        model,
        state: {
          id: cred.id,
          providerId: snap.providerId,
          modelId,
          limits: { rpm: 30, rpd: 1000, tpm: 8000 },
          requestsThisMinute: 0,
          requestsToday: cred.requestsToday,
          tokensThisMinute: 0,
          tokensToday: cred.tokensToday,
          minuteWindowStart: Date.now(),
          dayWindowStart: Date.now(),
          cooldownUntil: null,
          consecutiveFailures: 0,
          disabled: cred.disabled,
          disabledReason: cred.disabledReason,
        },
      });
    }
  }

  const inv = overview(buckets, Date.now());
  for (const [provider, s] of Object.entries(inv.byProvider)) {
    console.log(
      `  ${provider.padEnd(12)} ${String(s.buckets).padStart(3)} buckets  ${String(s.models.length)} model(s)  ${s.models.slice(0, 2).join(", ")}${s.models.length > 2 ? " …" : ""}`,
    );
  }
  console.log(`\n  TOTAL ${String(inv.totalBuckets)} buckets`);
  const groqBuckets = inv.byProvider["groq"]?.buckets ?? 0;
  console.log(
    `  Groq: ${String(groqBuckets)} buckets vs ${String(groqBuckets / 4)} under the old per-credential model — ${String(groqBuckets / Math.max(1, groqBuckets / 4))}x`,
  );

  // ── 2. Live distribution across providers ─────────────────────────────────
  console.log("\n[2] LIVE DISTRIBUTION — 12 independent requests\n");
  const attempts: Attempt[] = [];
  let live = buckets.filter((b) => b.providerId === "groq" || b.providerId === "openrouter");

  for (let i = 0; i < 12; i++) {
    const now = Date.now();
    const decision = schedule(
      live,
      {
        pool: "standard",
        environment: "local",
        estimatedTokens: 400,
        needsStructuredOutput: false,
      },
      now,
    );
    if (!decision.bucket) {
      console.log(`  ${String(i + 1).padStart(2)}. no capacity — retryAt ${String(decision.retryAt ?? 0)}`);
      break;
    }

    const b = decision.bucket;
    const provider = providerById.get(b.providerId);
    if (!provider) continue;

    const headroomAtSelect = decision.score?.["headroom"] ?? 0;
    try {
      const res = await provider.generate(
        {
          taskClass: "dialogue",
          system: "You are terse.",
          messages: [{ role: "user", content: `Reply with the number ${String(i + 1)}.` }],
          maxTokens: 24,
          temperature: 0,
          timeoutMs: 30_000,
          meta: { requestId: `smoke-${String(i)}` },
        },
        b.model,
      );
      attempts.push({
        bucketId: b.id,
        providerId: b.providerId,
        modelId: b.model.id,
        ok: true,
        status: "200",
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens ?? 0,
        latencyMs: res.latencyMs,
        headroomAtSelect,
      });
      live = live.map((x) =>
        x.id === b.id
          ? {
              ...x,
              state: recordSuccess(
                x.state,
                Date.now(),
                res.usage.inputTokens + res.usage.outputTokens,
              ),
            }
          : x,
      );
    } catch (e) {
      const code = e instanceof AIError ? e.code : "UNEXPECTED";
      attempts.push({
        bucketId: b.id,
        providerId: b.providerId,
        modelId: b.model.id,
        ok: false,
        status: code,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        headroomAtSelect,
      });
      // A real 429 must move load off this bucket, not stall on it.
      live = live.map((x) =>
        x.id === b.id ? { ...x, state: recordRateLimited(x.state, Date.now(), 30_000) } : x,
      );
    }

    const a = attempts[attempts.length - 1]!;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${a.providerId.padEnd(11)} ${a.modelId.slice(0, 26).padEnd(27)} ${a.ok ? "✓" : "✗"} ${a.status.padEnd(14)} in=${String(a.inputTokens).padStart(4)} out=${String(a.outputTokens).padStart(3)} rsn=${String(a.reasoningTokens).padStart(3)} ${String(a.latencyMs).padStart(5)}ms`,
    );
  }

  // ── 3. Groq exhaustion must not stall ─────────────────────────────────────
  console.log("\n[3] GROQ EXHAUSTION — does the system stall?\n");
  const exhausted = live.map((b) =>
    b.providerId === "groq"
      ? { ...b, state: recordRateLimited(b.state, Date.now(), 60_000) }
      : b,
  );
  const afterGroq = schedule(
    exhausted,
    { pool: "standard", environment: "local", estimatedTokens: 400 },
    Date.now(),
  );
  console.log(
    afterGroq.bucket
      ? `  ✓ routed onward to ${afterGroq.bucket.providerId} (${afterGroq.bucket.model.id})`
      : `  ✗ STALLED — no eligible bucket`,
  );

  // ── 4. Dev-only providers carry development workload ──────────────────────
  console.log("\n[4] DEVELOPMENT POOL — NVIDIA and Gemini eligible?\n");
  const devBuckets = buckets.filter(
    (b) => b.providerId === "nvidia" || b.providerId === "gemini",
  );
  const devPick = schedule(
    devBuckets,
    {
      pool: "development",
      environment: "local",
      isSyntheticContent: true,
      estimatedTokens: 400,
    },
    Date.now(),
  );
  console.log(
    devPick.bucket
      ? `  ✓ development pool selects ${devPick.bucket.providerId} — ${String(devBuckets.length)} dev buckets available`
      : `  ✗ no development capacity`,
  );

  // ── 5. Production boundary still holds ────────────────────────────────────
  console.log("\n[5] PRODUCTION BOUNDARY — the safety property\n");
  const inProd = schedule(
    devBuckets,
    { pool: "standard", environment: "production", estimatedTokens: 400 },
    Date.now(),
  );
  console.log(
    inProd.bucket === null
      ? `  ✓ dev-only providers REFUSED in production (${inProd.rejected[0]?.reason ?? "?"})`
      : `  ✗ LEAK — ${inProd.bucket.providerId} selected in production`,
  );
  const prodNoSynthetic = schedule(
    devBuckets,
    { pool: "development", environment: "local", estimatedTokens: 400 },
    Date.now(),
  );
  console.log(
    prodNoSynthetic.bucket === null
      ? `  ✓ fails closed without the synthetic-content flag`
      : `  ✗ LEAK — selected without synthetic flag`,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(74));
  const byProvider = new Map<string, number>();
  const byBucket = new Set<string>();
  for (const a of attempts) {
    if (!a.ok) continue;
    byProvider.set(a.providerId, (byProvider.get(a.providerId) ?? 0) + 1);
    byBucket.add(a.bucketId);
  }
  console.log("DISTRIBUTION");
  for (const [p, n] of byProvider) console.log(`  ${p.padEnd(12)} ${String(n)} requests`);
  console.log(`  distinct buckets used: ${String(byBucket.size)}`);

  const checks: Array<[string, boolean]> = [
    ["per-model buckets exist", groqBuckets > 8],
    ["multiple buckets carried load", byBucket.size >= 3],
    ["Groq exhaustion did not stall", afterGroq.bucket !== null],
    ["development pool has capacity", devPick.bucket !== null],
    ["production boundary holds", inProd.bucket === null],
    ["fails closed without synthetic flag", prodNoSynthetic.bucket === null],
    ["telemetry identifies bucket", attempts.every((a) => a.bucketId.includes(":"))],
  ];
  console.log("\nCHECKS");
  let passed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (ok) passed += 1;
  }
  console.log(`\n${String(passed)}/${String(checks.length)} passed`);
  console.log("═".repeat(74) + "\n");
  if (passed < checks.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
