import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import {
  CloudflareEmbeddingProvider,
  CredentialRegistry,
  GroqProvider,
  OpenRouterProvider,
  SchedulerRouter,
} from "@darkforest/ai";
import { createPool } from "@darkforest/db";
import { Authenticator } from "./auth.js";
import { createApp } from "./app.js";

/**
 * The Node entry point. `pnpm api` runs it.
 *
 * Hono is the framework precisely so this file is the only Node-specific part
 * (ADR-010): the app itself is a fetch handler and moves to Workers without
 * touching a route.
 */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m?.[1]) continue;
      const v = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
      if (v) out[m[1]] = v;
    }
  } catch {
    // No .env in deployment; real secrets come from the environment (L-SEC-05).
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

function required(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (v === undefined || v.length === 0) throw new Error(`${key} is required`);
  return v;
}

const env = loadEnv();
const isProduction = env["DF_ENV"]?.includes("production") === true;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
  /*
   * REAL PEOPLE'S WORDS. All three values differ from the eval harness, and
   * each one gates something.
   *
   * `isSyntheticContent: false` is the important one: it excludes every
   * provider whose terms permit training on what it is sent. Gemini and NVIDIA
   * NIM both warn against submitting personal data and are development-only on
   * contractual grounds (ADR-013); Groq's Services Agreement forbids training
   * on customer input, which is why it can carry a private roleplay at all
   * (ADR-009). A test account's messages are still a person's words, so this
   * stays false in every environment.
   */
  content: {
    pool: "standard",
    environment: isProduction ? "production" : "local",
    isSyntheticContent: false,
  },
});

const embedder = new CloudflareEmbeddingProvider({
  accountId: required(env, "CF_ACCOUNT_ID"),
  // Acquired per call from the registry, never held on the instance, so the
  // embedder is metered like every other provider rather than being an
  // unaccounted side channel.
  getToken: () => {
    const g = registry.acquire("cloudflare", 0, Date.now());
    return g.ok ? { id: g.id, key: g.key } : null;
  },
  onSuccess: (id, t) => {
    registry.reportSuccess(id, t);
  },
});

const pool = createPool({
  url:
    env["SUPABASE_SESSION_POOLER_URL"] ??
    env["SUPABASE_DB_URL"] ??
    required(env, "DATABASE_URL"),
});

/*
 * A router with no models is a configuration failure, not a runtime condition
 * to degrade around: every request would fail identically, and the useful
 * moment to say so is startup.
 */
const firstModel = router.models[0];
if (firstModel === undefined) throw new Error("no models are configured");

const app = createApp({
  pool,
  router,
  embedder,
  anyModel: firstModel,
  auth: new Authenticator({
    supabaseUrl: required(env, "SUPABASE_URL"),
    // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes
    // "absent" from "present and undefined", and the config means the first.
    ...(env["SUPABASE_JWT_SECRET"] === undefined
      ? {}
      : { jwtSecret: env["SUPABASE_JWT_SECRET"] }),
  }),
  isProduction,
});

const port = Number(env["PORT"] ?? "8787");
serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`  api listening on http://localhost:${String(info.port)}
`);
});
