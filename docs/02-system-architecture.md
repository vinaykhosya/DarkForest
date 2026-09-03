# 02 — System Architecture

> **Status:** Authoritative for structure. Implementation detail may evolve; the module boundaries and the request lifecycle may not, without an ADR.

---

## 1. Runtime topology

```
                        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                        │  Web (PWA)   │  │  Telegram    │  │  WhatsApp    │
                        │  Next.js     │  │  Bot API     │  │  Cloud API   │
                        └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                               │  HTTPS/SSE      │  webhook        │  webhook
                               └─────────────────┼─────────────────┘
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │        CHANNEL ADAPTERS              │
                              │  normalize → InboundMessage          │
                              │  verify signature · dedupe · ack fast │
                              └──────────────────┬───────────────────┘
                                                 ▼
     ┌───────────────────────────────────────────────────────────────────────────┐
     │                    BACKEND (single Worker deployment)                     │
     │                                                                           │
     │   auth ─ users ─ worlds ─ characters ─ conversations ─ memory             │
     │   relationships ─ quests ─ ai ─ channels ─ billing ─ moderation ─ jobs    │
     │                                                                           │
     │   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐            │
     │   │ WORLD ENGINE │  │ MEMORY ENGINE│  │ RELATIONSHIP ENGINE  │            │
     │   │ truth·rules  │  │ recall·write │  │ trust·respect·…      │            │
     │   └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘            │
     │          └─────────────────┼─────────────────────┘                        │
     │                            ▼                                              │
     │                   ┌─────────────────┐                                     │
     │                   │  ORCHESTRATOR   │  who speaks, in what order          │
     │                   └────────┬────────┘                                     │
     │                            ▼                                              │
     │                   ┌─────────────────┐                                     │
     │                   │ CONTEXT BUILDER │  budgeted, fenced, per-character    │
     │                   └────────┬────────┘                                     │
     │                            ▼                                              │
     │                   ┌─────────────────┐                                     │
     │                   │   AI ROUTER     │  select · call · fallback · meter   │
     │                   └────────┬────────┘                                     │
     └────────────────────────────┼──────────────────────────────────────────────┘
                                  ▼
                ┌─────────────┬────────────┬──────────────┬─────────────┐
                │  Provider A │ Provider B │  Provider C  │  Mock/Local │
                └─────────────┴────────────┴──────────────┴─────────────┘
                                  │
                                  ▼
     ┌───────────────────────────────────────────────────────────────────────────┐
     │  PERSISTENCE — Supabase                                                   │
     │  PostgreSQL (relational truth) · pgvector (recall) · Storage (assets)     │
     └───────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ drained by Cron Trigger
                        ┌─────────┴──────────┐
                        │  JOB RUNNER        │
                        │ extraction·consolidation·embedding·decay│
                        └────────────────────┘
```

### Why this shape

- **One deployable.** A solo founder cannot operate a distributed system and also build a product. Boundaries are enforced by module contracts and lint rules, not by network hops.
- **Channels are thin.** They translate and nothing else. A bug in the Telegram adapter cannot corrupt world state.
- **The router is a chokepoint by design.** Every token spent passes through one place that can meter, cache, fall back and refuse.
- **The job runner exists because the request path must stay short.** Memory extraction, embedding and consolidation are not the user's problem and must not be in the user's latency budget.

---

## 2. Repository layout

```
darkforest/
├── apps/
│   ├── web/                        # Next.js — UI only, zero business logic
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/api-client/         # generated from contracts
│   │   └── ...
│   └── api/                        # Cloudflare Worker — the backend
│       ├── src/
│       │   ├── index.ts            # router mount, middleware chain
│       │   ├── middleware/         # auth, rate-limit, request-id, error
│       │   ├── modules/            # ← all business logic lives here
│       │   ├── platform/           # env, db client, kv, secrets, clock
│       │   └── scheduled.ts        # cron entrypoint → job dispatcher
│       └── wrangler.toml
│
├── packages/
│   ├── contracts/                  # zod schemas + inferred TS types. THE shared truth.
│   ├── core/                       # pure domain logic, zero I/O, 100% unit-testable
│   │   ├── memory/                 # scoring, ranking, consolidation algorithms
│   │   ├── relationships/          # delta rules, decay curves
│   │   ├── orchestration/          # responder selection scoring
│   │   ├── context/                # token budgeting, packing
│   │   └── world/                  # rule evaluation, state transitions
│   ├── prompts/                    # versioned prompt templates + snapshots
│   ├── evals/                      # the AI evaluation harness
│   └── config/                     # eslint, tsconfig, prettier
│
├── db/
│   ├── migrations/                 # numbered, forward-only SQL
│   ├── policies/                   # RLS policies, versioned separately for review
│   ├── seeds/                      # the four canonical test worlds
│   └── schema.sql                  # generated snapshot, never hand-edited
│
├── docs/                           # this specification set
├── workflow/                       # phases, tasks, progress, decisions
└── scripts/                        # dev tooling, migration runner, eval runner
```

### Module layout (inside `apps/api/src/modules/`)

Every module has the same five files. This uniformity is deliberate — it makes an unfamiliar module navigable in thirty seconds.

```
modules/<name>/
├── index.ts        # public surface. The ONLY file other modules may import.
├── service.ts      # business logic, orchestrates repo + other modules' index.ts
├── repo.ts         # SQL. The ONLY file that touches this module's tables.
├── routes.ts       # HTTP handlers. Thin: parse → authorize → call service → serialize.
└── types.ts        # module-internal types (shared types live in packages/contracts)
```

**Enforced by lint rule:** `modules/a/**` may import `modules/b` but never `modules/b/repo` or `modules/b/service`. Violation fails CI.

### The module list

| Module | Owns | Depends on |
|---|---|---|
| `auth` | sessions, tokens, channel identity linking | — |
| `users` | accounts, profiles, personas, preferences | auth |
| `worlds` | worlds, rules, state, membership, settings | users |
| `characters` | profiles, personality, goals, secrets, knowledge | worlds |
| `relationships` | relationship rows, deltas, decay | characters |
| `conversations` | conversations, messages, turns | worlds |
| `memory` | memories, embeddings, links, retrieval | worlds, characters |
| `quests` | quests, steps, inventory, items | worlds |
| `orchestration` | responder selection, turn execution | all engines |
| `ai` | providers, router, tools, usage | billing |
| `channels` | web/telegram/whatsapp adapters | orchestration, auth |
| `billing` | plans, subscriptions, entitlements, ledger | users |
| `moderation` | input/output screening, reports, actions | — |
| `jobs` | job queue table, dispatcher, handlers | all |

---

## 3. The request lifecycle

This is the single most important sequence in the system. It is written here once; implementations must match it exactly.

```
 1. INGRESS
    Channel adapter receives payload
    → verify signature / session (12 § Auth)
    → dedupe by provider message id (idempotency)
    → normalize to InboundMessage
    → for webhook channels: ACK IMMEDIATELY, continue via waitUntil

 2. ADMISSION
    → resolve user + entitlements (billing.getEntitlements)
    → rate limit check (per user, per channel, per world)
    → compute-unit pre-flight reservation (14 § Admission)
    → conversation lock acquisition (§ 5 below)
    ✗ any failure here → structured refusal, no model call, no charge

 3. INPUT MODERATION
    → cheap classifier first
    → LLM screen only on ambiguity
    ✗ block → policy response, logged, no world mutation

 4. PERSIST USER TURN
    → insert message row (status: accepted)
    → advance conversation cursor
    This happens BEFORE generation so a crash mid-generation never loses user input.

 5. WORLD READ
    → load world state, active scene, present characters, active rules
    → single batched read; no N+1 (Workers subrequest budget, 01 § Part C)

 6. PLAN
    → orchestrator scores candidate responders (07 § Selection)
    → produces ordered responder list, capped by tier
    → deterministic where possible; model-assisted only when ambiguous

 7. RETRIEVE
    → memory engine runs hybrid retrieval per responder (04 § Retrieval)
    → knowledge isolation applied AT QUERY TIME, never in the prompt

 8. GENERATE — per responder, sequentially
    a. context builder assembles budgeted, fenced package (09)
    b. router selects model by task class + tier + health (08)
    c. call with timeout; on failure walk the fallback chain
    d. parse tool calls → validate → apply → feed results back
    e. append this character's output to the shared turn transcript
       so later speakers can react to earlier ones

 9. OUTPUT MODERATION
    → screen each generated message
    → violation → regenerate once with constraint, then substitute safe fallback

10. COMMIT
    → single transaction: messages, state deltas, relationship deltas,
      events, quest updates, inventory changes
    → optimistic concurrency on world_state.version
    → conflict → retry once with fresh read, then fail cleanly

11. RESPOND
    → stream to web; send via channel adapter for bot surfaces
    → release conversation lock

12. DEFERRED (waitUntil / job queue — never blocks the response)
    → memory extraction
    → embedding generation
    → relationship reconciliation
    → usage ledger finalization (actual tokens vs reservation)
    → consolidation trigger check
```

**Steps 2, 4, 10 and 12 are the ones that get skipped under deadline pressure and cause the worst bugs.** They are non-negotiable.

---

## 4. Background work without a queue service

Cloudflare Queues is a paid feature; we cannot depend on it. The MVP pattern:

```
┌──────────────┐   enqueue (same txn as commit)   ┌───────────────┐
│ Request path │─────────────────────────────────▶│  jobs table   │
└──────┬───────┘                                   └───────┬───────┘
       │ ctx.waitUntil(runInline(job))                     │
       │ best-effort immediate execution                   │ Cron Trigger (*/1 min)
       ▼                                                   ▼
  fast path for                                    ┌──────────────────┐
  memory extraction                                │  job dispatcher  │
  (usually completes)                              │  claim → run     │
                                                   └──────────────────┘
```

`ctx.waitUntil()` gives us near-real-time processing in the common case. The cron-drained table is the guarantee: a job that failed to run inline, or failed entirely, is picked up within a minute.

**Job table requirements** (schema in [03](03-data-model.md)):

- `claim` uses `SELECT … FOR UPDATE SKIP LOCKED` so multiple runners never double-process.
- `attempts` + exponential backoff + `max_attempts`, then dead-letter status.
- `idempotency_key` unique — enqueueing the same logical job twice is a no-op.
- Handlers must be **idempotent**. Assume every job runs at least twice.

**One cron, one dispatcher.** Free-tier cron trigger counts are limited; a single `*/1 * * * *` trigger fans out by job type and priority rather than one trigger per job class.

---

## 5. Concurrency and consistency

Three concurrency hazards exist, and all three will occur in production.

### Hazard 1 — Two simultaneous turns in one conversation

A user sends from the web app and Telegram within the same second, or double-taps send.

**Mitigation:** conversation-level advisory lock, acquired at admission (step 2), released at step 11 or by TTL.

```sql
-- Postgres advisory lock keyed on conversation uuid
SELECT pg_try_advisory_xact_lock(hashtext($1));
```

For cross-request duration (the whole turn, not one transaction), use a `conversation_locks` row with `holder`, `acquired_at`, `expires_at` and conditional acquisition:

```sql
INSERT INTO conversation_locks (conversation_id, holder, expires_at)
VALUES ($1, $2, now() + interval '90 seconds')
ON CONFLICT (conversation_id) DO UPDATE
  SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
  WHERE conversation_locks.expires_at < now()
RETURNING holder;
```

If the returned holder is not us, reject with `CONVERSATION_BUSY`. The client shows "still thinking…" rather than queuing a second generation.

> Optional upgrade (verify free-tier availability): a Durable Object per conversation gives serialized execution natively. Do not depend on it for MVP.

### Hazard 2 — Lost update on world state

Two turns, or a turn and a background job, both mutate world state.

**Mitigation:** `world_state.version` integer, incremented on every write, with the write conditioned on the version read at step 5. Conflict → one retry with fresh read → then `STATE_CONFLICT` error. Never blind-overwrite.

### Hazard 3 — Duplicate webhook delivery

Telegram and WhatsApp both retry on non-2xx, and both can deliver twice.

**Mitigation:** `channel_message_ids` table with a unique constraint on `(channel, provider_message_id)`. Insert first; a conflict means we have already handled this and we return 200 without processing. This is why webhooks ACK before doing work.

---

## 6. Data flow for a multi-character turn

Worked example — user says *"I tell everyone I'm leaving tomorrow."* in a world with Mother, Son, Daughter and Neighbour.

```
INPUT: "I tell everyone I'm leaving tomorrow."
  │
  ├─▶ Scene read: present = [Mother, Son, Daughter]; Neighbour is not in scene
  │
  ├─▶ Orchestrator scoring:
  │      Mother   : presence 1.0 · addressed 1.0 · stake 0.9 · cooldown 1.0 → 0.94
  │      Son      : presence 1.0 · addressed 1.0 · stake 0.7 · cooldown 0.9 → 0.81
  │      Daughter : presence 1.0 · addressed 1.0 · stake 0.8 · cooldown 1.0 → 0.88
  │      Neighbour: presence 0.0 → excluded
  │      Cap for tier = 3 → all three speak. Order: Mother, Daughter, Son
  │      (order by stake, with a tie-break that avoids repeating last turn's opener)
  │
  ├─▶ Retrieval, per character — DIFFERENT RESULTS BY DESIGN:
  │      Mother  : [user has left before], [she knows about the hidden money]
  │      Daughter: [user missed her recital], [user decides without asking]
  │      Son     : [user promised a trip], [exam failure — she does NOT know he told Mother]
  │
  ├─▶ Generate Mother  → transcript += Mother's line
  ├─▶ Generate Daughter (sees Mother's line) → transcript += Daughter's line
  ├─▶ Generate Son (sees both) → transcript += Son's line
  │
  ├─▶ Proposed state changes (tool calls, validated):
  │      relationship(Daughter→User).trust −4, .hostility +6
  │      relationship(Mother→User).worry +5
  │      world_event: "User announced departure" (importance 0.78)
  │
  └─▶ COMMIT (one transaction) → RESPOND → enqueue extraction job
```

**Note what did not happen:** the Neighbour was not called, so we did not pay for a fourth generation. The Son did not know what the Mother privately knows. No character asserted a state change directly into prose.

---

## 7. Technology decisions

| Layer | Choice | Rationale | Reversal cost |
|---|---|---|---|
| Language | TypeScript, strict, everywhere | One language across edge, UI and shared domain logic. Zod contracts shared verbatim. | High |
| Frontend | Next.js (App Router) + Tailwind | Static export or edge-rendered; PWA path to mobile without a second codebase | Medium |
| Backend runtime | Cloudflare Workers | Free tier fits, global edge, tight integration with the frontend host | Medium — modular monolith is portable to Node/Fastify with an adapter |
| Database | Supabase PostgreSQL | Relational truth + pgvector + auth + storage in one free tier | High |
| Vector | pgvector (`halfvec`, HNSW) | No second datastore to operate | Medium |
| Auth | Supabase Auth | Free, handles email/OAuth, integrates with RLS | Medium |
| Validation | Zod | Runtime validation *and* static types from one declaration | Low |
| Testing | Vitest + Playwright | Fast unit loop; browser E2E only on critical paths | Low |
| Migrations | Plain numbered SQL + custom runner | No ORM lock-in; migrations are reviewable artifacts | Low |
| ORM | **None** | Hand-written SQL in `repo.ts`. Query shape matters too much here to hide it. | — |

### Deliberate non-choices

- **No ORM.** Retrieval queries mix vector distance, full-text rank and business filters. Every ORM makes that worse.
- **No GraphQL.** One client, one backend, no federation need.
- **No state-management library** until the UI proves it needs one.
- **No Redis.** Cloudflare KV covers rate-limit counters and hot caches; Postgres covers everything else.
- **No Python service** at MVP. Introduce only if data work becomes genuinely Python-shaped, and then as an isolated job worker, never in the request path.

---

## 8. Environments

| Env | Frontend | Backend | Database | AI |
|---|---|---|---|---|
| `local` | `next dev` | `wrangler dev` | Local Postgres (Docker) or a dedicated Supabase project | `MOCK_AI=true` by default |
| `staging` | Preview deployment | Worker on `*-staging` | Separate Supabase project | Real providers, tiny quotas |
| `production` | Production deployment | Worker on production route | Production Supabase project | Real providers, full router |

**Rules:**

- Migrations run against `local` → `staging` → `production`, in that order, never skipping.
- Production database credentials exist only in the production secret store. They are never in a `.env` file on the laptop.
- `MOCK_AI=true` must produce a fully working product with deterministic canned responses. This is what allows all UI work to happen at zero inference cost, and it is what makes the test suite fast and free. **It is a Phase 1 deliverable, not a nice-to-have.**

---

## 9. What triggers an architecture change

Do not restructure on intuition. These are the measured triggers, and only these:

| Observation | Response |
|---|---|
| Worker CPU limit exceeded on normal turns | Move the offending computation to a job, or to Postgres |
| Subrequest cap hit on multi-character turns | Reduce responder cap; batch DB reads; consider parallel generation for independent speakers |
| Supabase storage > 70% | Execute the storage-mitigation ladder ([01](01-principles-and-constraints.md) § Storage math) |
| p95 turn latency > 8 s at the current responder cap | Profile before optimizing; the answer is usually retrieval, not generation |
| One module's tables account for > 60% of change volume | Consider extracting it — *after* the modular boundary has held for a full phase |
| A second engineer joins | Re-evaluate monolith boundaries; not before |
