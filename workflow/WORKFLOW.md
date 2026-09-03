# WORKFLOW — Phases, Gates & Sequence

> **This is the build order. It is not a suggestion.**
> The sequence exists because each phase produces the information the next one needs. Building out of order means building on guesses.
>
> **Current phase:** 0 — Architecture & Specification
> **Live status:** [PROGRESS.md](PROGRESS.md) · **Task board:** [TASKS.md](TASKS.md)

---

## How to read this document

Each phase has:

- **Goal** — the one sentence that says why this phase exists
- **Entry criteria** — what must be true before starting
- **Deliverables** — what exists at the end
- **Exit gate** — the test that decides whether the phase is done
- **Do not build** — the things you will be tempted to build and must not

A phase is complete when its **exit gate passes**, not when the deliverables look finished. Gates are checked honestly; a gate marked passed while failing corrupts every downstream decision.

---

## Phase map

```
FOUNDATION                    PROVING THE CORE
├─ P0  Architecture           ├─ P4  Memory engine      ← the moat
├─ P1  AI lab + eval harness  ├─ P5  Single-character chat
├─ P2  Database               ├─ P6  World engine
└─ P3  AI provider layer      ├─ P7  Relationship engine
                              └─ P8  Multi-character orchestration
                                          │
SURFACING                     ┌───────────┘
├─ P9  Web application        │
├─ P10 Telegram               ▼
└─ P11 Private beta       ← THE DECISION POINT
            │
            ▼
COMMERCIAL                    EXPANSION
├─ P12 Economics & limits     ├─ P16 WhatsApp
├─ P13 Domain + public launch ├─ P17 Images & voice
├─ P14 Subscriptions          ├─ P18 Self-hosted inference
└─ P15 Creator system         ├─ P19 Android
                              └─ P20 Marketplace
```

The vertical bar at Phase 11 is the point where the plan stops being a plan. Everything before it is a hypothesis; everything after depends on what fifty strangers actually do.

---

# FOUNDATION

## Phase 0 — Architecture & Specification

**Goal:** Make implementation mechanical rather than improvised.

**Entry:** none — this is the start.

**Deliverables**
- [x] Product identity, principles and constraints ([00](../docs/00-product-identity.md), [01](../docs/01-principles-and-constraints.md))
- [x] System architecture, request lifecycle, module boundaries ([02](../docs/02-system-architecture.md))
- [x] Complete data model with RLS strategy ([03](../docs/03-data-model.md))
- [x] Engine specifications ([04](../docs/04-memory-engine.md)–[07](../docs/07-multi-character-orchestration.md))
- [x] AI router and prompt architecture ([08](../docs/08-ai-router.md), [09](../docs/09-context-builder-and-prompts.md))
- [x] API contracts ([10](../docs/10-api-contracts.md))
- [x] Security, moderation, billing, testing, ops specs ([12](../docs/12-security.md)–[16](../docs/16-observability-and-ops.md))
- [x] This workflow and the task board
- [ ] Open decisions D-001…D-006 raised in [DECISIONS.md](DECISIONS.md)

**Exit gate:** Every question in the feature-admission questionnaire ([01](../docs/01-principles-and-constraints.md) § Part D) is answerable for every MVP feature, from these documents alone.

**Do not build:** anything. No code. The temptation to "just start the repo" is the temptation to decide architecture by accident.

---

## Phase 1 — AI Lab & Evaluation Harness

**Goal:** Answer the only question that matters before building a product around it — *can this system remember?*

**Entry:** Phase 0 gate passed.

**Deliverables**
- Monorepo skeleton, TypeScript strict, lint rules including the module-boundary rule
- `packages/contracts` with the core Zod schemas
- `AIProvider` interface + one real provider + the **mock provider**
- Model registry verified against live provider catalogues (**P1-T02**)
- A crude, script-driven memory loop: input → retrieve → prompt → generate → extract → store
- `packages/evals` harness with suites 1 and 3 runnable
- The four canonical test worlds seeded
- Model benchmark table populated with real measurements
- `MOCK_AI=true` producing a fully working loop

**Exit gate**
```
Plant 20 facts across 100 scripted turns.
Probe them at turns 30, 60, 100 and in a fresh session.
  recall@k          ≥ 0.85
  false recall      ≤ 0.05
At least one model in each tier is benchmarked and viable.
The provider chaos test passes with one provider disabled.
```

**Do not build:** UI, auth, HTTP API, world state, quests, multiple characters. This phase is a command-line experiment.

> If the exit gate fails, **stop and fix the memory engine**. Do not proceed to build a product around a memory system that does not remember. This is the single most important gate in the entire plan.

---

## Phase 2 — Database

**Goal:** Turn the schema specification into a real, migrated, secured database.

**Entry:** Phase 1 gate passed.

**Deliverables**
- Migrations 0001–0014 applied to local and staging ([03](../docs/03-data-model.md) § 12)
- RLS policies on every table, with negative tests
- Seed data for the four canonical worlds
- Migration runner script; `db/schema.sql` generated
- Storage projection measured against real seeded data
- CI check: no public table without RLS

**Exit gate**
```
Migrations run cleanly from empty on a fresh database.
RLS negative tests pass: user B cannot read, write or delete user A's data.
Seeds load; the Phase 1 memory loop now runs against the real schema.
Storage math for 10,000 memories measured and within projections.
```

**Do not build:** creator, marketplace or billing tables beyond `plans` and `subscriptions`.

---

## Phase 3 — AI Provider Layer

**Goal:** Make model choice a runtime decision that survives any provider disappearing.

**Entry:** Phase 2 gate passed.

**Deliverables**
- Full router: tier mapping, chains, capability filtering, circuit breaker, rate-limit tracking
- Structured-output strategy ladder with the repair path
- `model_requests` logging on every attempt including failures
- Compute-unit estimation and the admission-control skeleton
- Provider chaos suite (7) implemented and passing

**Exit gate**
```
Disable the primary provider → the product still works, degraded.
Inject 100% 429 on a tier → the chain advances without a same-model retry.
Inject malformed structured output → the repair path runs; nothing invalid is stored.
Disable all providers → clean degradation; no crash; user input preserved.
Every attempt appears in model_requests.
No model name appears anywhere outside config.
```

**Do not build:** a model-selection UI, per-user model preferences, streaming to a browser (no browser yet).

---

# PROVING THE CORE

## Phase 4 — Memory Engine

**Goal:** Turn the Phase 1 experiment into the real, production-shaped engine.

**Entry:** Phase 3 gate passed.

**Deliverables**
- Hybrid retrieval: vector + keyword + structural, fused with RRF
- The full composite ranking formula with named, versioned weights
- Knowledge isolation enforced in SQL
- Extraction as a background job, idempotent, with anti-duplication
- Consolidation: merge, contradiction resolution, reflections, pruning
- Embedding provider abstraction + background embedding job
- Retrieval trace recording
- Eval suites 1, 2 and 4 passing

**Exit gate**
```
Suite 1 (recall):        recall@k ≥ 0.90, precision ≥ 0.60, false recall ≤ 0.03
Suite 2 (long horizon):  day-1 facts recalled at day 100 ≥ 0.75
                         post-consolidation fact survival ≥ 0.95
Suite 4 (isolation):     leak rate = 0.00        ← hard gate
Retrieval p95 ≤ 400 ms
```

**Do not build:** the memory notebook UI (Phase 9), graph databases, memory sharing between worlds.

---

## Phase 5 — Single-Character Chat

**Goal:** A complete, working conversation with one character — the first thing that feels like a product.

**Entry:** Phase 4 gate passed.

**Deliverables**
- `POST /v1/conversations/:id/turns` with the full lifecycle ([02](../docs/02-system-architecture.md) § 3)
- Auth, sessions, personas
- Context builder with budgeting and injection defense
- Character profiles, goals, secrets, voice anchors
- Conversation summarization for older turns
- Input and output moderation stages 0–3
- Conversation locking, idempotency, optimistic concurrency
- Eval suite 3 passing

**Exit gate**
```
A 200-turn conversation with one character holds voice and remembers.
Suite 3: voice consistency ≥ 7.5, personality adherence ≥ 8.0, forbidden violations = 0
Two simultaneous turns in one conversation → one succeeds, one gets CONVERSATION_BUSY
A duplicate request with the same idempotency key is a no-op
Moderation blocks a prohibited input without mutating world state or charging CUs
```

**Do not build:** multiple characters, world state, quests, UI.

---

## Phase 6 — World Engine

**Goal:** Make state authoritative, so the world stops being a conversation and starts being a place.

**Entry:** Phase 5 gate passed.

**Deliverables**
- `world_state` with versioning and optimistic concurrency
- Declared flags and numerics with validation
- World rules with contextual keyword injection
- Full tool-calling layer: read tools, write tools, validation, caps, idempotency
- Events and timeline
- Quests with the state machine and machine-checkable predicates
- Inventory and items
- Time: world day, time of day, time passage with its job
- Chapters with summarization
- Guided world creation
- Eval suite 5 passing

**Exit gate**
```
Suite 5: authoritative-state accuracy = 1.00
         hallucinated state assertions ≤ 0.02
         hard rule violations = 0
         quest state-machine violations = 0
A model asserting a state change in prose does not change the database.
Undeclared flag writes are rejected with a clear reason.
Concurrent mutations produce STATE_CONFLICT, never a lost update.
```

**Do not build:** economy simulation, autonomous NPC background simulation, procedural world generation beyond the guided creator.

---

## Phase 7 — Relationship Engine

**Goal:** Make characters' feelings change, visibly and defensibly.

**Entry:** Phase 6 gate passed.

**Deliverables**
- Eight directional dimensions with caps, damping and asymmetry
- Deterministic delta rules + model-proposed deltas requiring reasons
- Decay on time passage
- `relationship_events` audit trail and timeline query
- Derived status labels
- Romance gating enforced in code
- Emotional state (conversation-scoped)

**Exit gate**
```
100 scripted interactions produce relationship movement a human reviewer agrees with.
No delta exceeds ±15 in a turn. No delta lands without a reason.
Values do not saturate at ±100 over 500 turns.
Decay is observable and gentle after a 14-day gap.
Romance gates block escalation without sustained trust and affection.
```

**Do not build:** relationship graph UI (Phase 12), character-to-character autonomous relationship evolution.

---

## Phase 8 — Multi-Character Orchestration

**Goal:** The differentiator. Several characters, each with their own knowledge, reacting to each other.

**Entry:** Phase 7 gate passed.

**Deliverables**
- Deterministic responder scoring and selection
- Ordering with recency suppression
- Sequential generation with a shared turn transcript
- Per-character context divergence
- The narrator
- Tier caps on responders and characters
- Per-responder timeouts and graceful drops
- Eval suite 6 passing

**Exit gate**
```
Suite 6: correct speaker selection ≥ 0.80
         absent character responded = 0        ← hard gate
         speaker bleed ≤ 0.02
         avg responders/turn ≈ 1.6             ← economics
         reactivity ≥ 0.60
Suite 4 still passes with 4+ characters present (isolation holds under crowding).
A 3-responder turn completes within 14 s p95.
```

**Do not build:** group play with multiple humans, character-to-character scenes without a user present.

> **This is the halfway point, and the technically hardest phase.** After it, the engine is complete and the remaining work is surfacing it.

---

# SURFACING

## Phase 9 — Web Application

**Goal:** Make the engine usable by someone who is not you.

**Entry:** Phase 8 gate passed.

**Deliverables**
- Next.js app consuming the generated SDK — **no business logic in the UI**
- Landing, auth, dashboard, world creator, character editor
- **Chat with SSE streaming and the responder indicator on `turn.started`**
- Memory notebook: view, pin, edit, delete, add
- Settings: account, personas, data export, deletion
- Responsive; PWA manifest; mobile tested on real devices
- E2E tests for the eight critical journeys

**Exit gate**
```
A person who has never seen the product creates a world with 3 characters,
has a conversation and returns the next day — with no help from you.
Time from signup to first character reply < 3 minutes.
Mobile web is genuinely usable.
Every error state shows a human message.
All eight E2E journeys pass.
```

**Do not build:** relationship graph, timeline UI, quest panel, turn trace (all Phase 12). Marketplace, publishing, images, voice.

---

## Phase 10 — Telegram

**Goal:** The second surface, and the cheapest viral channel.

**Entry:** Phase 9 gate passed.

**Deliverables**
- Bot, webhook with secret-token verification and a random path segment
- ACK-first processing via `waitUntil`
- Dedupe on `update_id`
- Commands + natural language as the primary interface
- One message per speaking character with pacing and typing indicators
- Outbound send queue with per-chat and global rate limiting
- Identity linking (`/link` + web-issued codes) with transactional account merge
- Lightweight account creation for unlinked users

**Exit gate**
```
Start a world on Telegram, continue it on the web, and back — same memories.
Duplicate webhook delivery does not double-process.
A 3-character response respects Telegram's rate limits without dropping messages.
Account merge on link is transactional and verified.
Blocking the bot does not produce errors or data loss.
```

**Group play (10.5) ships only after single-chat is stable and Phase 12 instrumentation exists.**

---

## Phase 11 — Private Beta ⭐ THE DECISION POINT

**Goal:** Find out whether persistence actually matters to anyone but you.

**Entry:** Gate A of the [launch checklist](../docs/18-launch-checklist.md) fully passed.

**Sequence:** 10 users → 25 → 50 → 100, expanding only when the previous cohort's numbers hold.

**Instrument before inviting anyone**
- D1 / D7 / D30 retention
- **D7 same-world return** ← the number
- Sessions per world, turns per session, median world age
- Memory recall accuracy in the wild
- Cost per user per day
- Model failure and fallback rates
- Free→paid *interest* (a fake upgrade button measuring intent)
- Post-session question: *"Did anything feel wrong?"*

**Exit gate**
```
D7 same-world return  > 25%
D30 retention         > 15%
Median world age at 30 days > 14 days
≥ 3 users say, unprompted, some version of "it remembered"
Cost per active user is understood and sustainable
```

### If the gate fails

**Do not proceed to Phase 12.** Diagnose honestly:

| Symptom | Likely meaning | Action |
|---|---|---|
| Good D1, poor D7 same-world | Persistence is not the draw | The thesis is wrong. Reconsider the product before spending on a domain. |
| Poor D1 | Onboarding or first-session quality | Fix Phase 9, re-run the beta |
| Good retention, low engagement depth | Worlds are shallow | Improve the world engine and creation flow |
| Users like it but do not return | Nothing pulls them back | Build re-engagement: time passage, consequences waiting |
| High cost per user | Economics broken | Return to Phase 8 orchestration tuning |

A failed gate here is the **cheapest possible failure**. It costs weeks. Failing at Phase 17 costs a year.

---

# COMMERCIAL

## Phase 12 — Economics, Limits & Admin

**Goal:** Know what a user costs, and be able to stop the bleeding.

**Deliverables:** full compute-unit accounting and reconciliation · entitlement service with plan seeding · rate limits calibrated from real beta data · admin dashboard ([16](../docs/16-observability-and-ops.md) § 7) · cost anomaly detection · **kill switch tested end to end** · degradation ladder implemented at every level · relationship graph, timeline, quest panel and turn trace UI.

**Exit gate:** cost per turn, per user and per plan measured and documented · a max-usage subscriber on every plan leaves ≥ 40% margin at the planned price · quota exceeded degrades before refusing · kill switch verified in staging · admin dashboard answers "who is expensive and why" in under a minute.

---

## Phase 13 — Domain & Public Launch

**Goal:** Open the doors.

**Entry:** Phase 12 gate passed **and** every box in [Gate B](../docs/18-launch-checklist.md) ticked.

**Deliverables:** brand decision recorded in an ADR · trademark and prior-use search · domain purchased with renewal price checked · DNS, email deliverability, social handles · legal documents reviewed · landing page with the day-1/day-30/day-60 demo · load tested at 10× · full security checklist complete · ownership migration complete.

**Exit gate:** Gate B fully passed, dated and signed off.

> **This is the first and only permitted pre-revenue expense.** Do not buy the domain earlier. A domain bought in month one is a domain renewed for a product that changed its name.

---

## Phase 14 — Subscriptions

**Goal:** Find out whether anyone will pay.

**Deliverables:** payment provider integration (hosted checkout, zero PCI scope) · signature-verified, replay-safe webhooks · subscription lifecycle with a daily reconciliation job · plan enforcement · invoicing and tax handling · self-serve cancellation with no dark patterns · refund process.

**Exit gate:** end-to-end signup, renewal, failure, cancel, expiry and resubscribe all tested · a real refund processed · **a lapsed subscriber's worlds verified intact** · the first paying user exists · that user's revenue compared to their inference cost ([17](../docs/17-monetization-and-unit-economics.md) § 7).

---

## Phase 15 — Creator System

**Goal:** Let the catalogue grow without you.

**Deliverables:** world and character publishing · discovery and browsing · forking a published world into your own · ratings and play counts · **publish-time content review** · **prompt-injection defenses hardened for third-party content** ([09](../docs/09-context-builder-and-prompts.md) § 4) · creator profiles · DMCA process live.

**Exit gate:** a stranger publishes a world, another stranger plays it, and the injection suite passes against deliberately hostile published content.

> **Free publishing only.** Paid selling is Phase 20. Prove the desire before building the payment rails.

---

# EXPANSION

Phases 16–20 are sequenced but not scheduled. Each begins only when the previous phases are stable and the data justifies it.

## Phase 16 — WhatsApp
Business verification (start early — it takes weeks) · Cloud API integration · signature verification against raw bytes · 24-hour window handling · one approved re-engagement template with explicit opt-in · **entitlement-gated, because it has real marginal cost**.

## Phase 17 — Images & Voice
Character avatars, scene illustrations; character voice. Both on **separate metered budgets** with their own quotas. Never core-path dependencies — the product must work fully with both disabled.

## Phase 18 — Self-Hosted Inference
Only when every trigger in [17](../docs/17-monetization-and-unit-economics.md) § 9 holds. Rented GPU + vLLM behind the existing `AIProvider` interface — which is the whole reason that interface exists. Owned hardware only at sustained high utilization.

## Phase 19 — Android
React Native or native, consuming the same SDK. **Zero duplicated business logic.** Only after the PWA has proven mobile demand and the Play Store policy implications of the content decision (D-004) are settled.

## Phase 20 — Marketplace
Paid worlds, campaigns, character packs. Requires creator payouts, tax handling, refunds and dispute resolution — a genuinely large amount of non-product work. Build it when creators are asking for it, not before.

---

## The rules of the sequence

1. **No phase starts before the previous gate passes.** Overlapping polish work is fine; skipping a gate is not.
2. **A failed gate means fix, not proceed.** Especially Phases 1, 4 and 11.
3. **Every phase ships behind `MOCK_AI=true` working.** If a phase's features cannot be demonstrated without a live model, it has a hidden dependency worth understanding.
4. **Update [PROGRESS.md](PROGRESS.md) at the end of every work session.** Not weekly. Every session.
5. **Every reversal of a specified decision gets an ADR** in [DECISIONS.md](DECISIONS.md), including what is being given up.
6. **When tempted to build ahead, re-read [01](../docs/01-principles-and-constraints.md) § Part D.** The feature you want to build early is almost always the one that makes Phase 11 arrive later.

---

## Honest note on timelines

This document deliberately contains **no dates and no duration estimates**.

A solo founder's schedule is dominated by unknowns that estimates cannot capture: how long the memory engine takes to get right, whether a free endpoint survives the month, how much of the week is actually available. An estimate here would be fiction, and fiction in a plan is worse than an admitted unknown.

What matters is the **order** and the **gates**. Track velocity from real completed tasks in [TASKS.md](TASKS.md) after a few weeks of actual work, and forecast from that. Measured velocity beats guessed velocity every time.
