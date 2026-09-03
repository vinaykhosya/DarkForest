# TASK BOARD

> The working document. Pick tasks from here; update status as you go.
> **Phase definitions:** [WORKFLOW.md](WORKFLOW.md) · **Session log:** [PROGRESS.md](PROGRESS.md)

**Status key:** `☐` not started · `◐` in progress · `☑` done · `⊘` blocked · `⊗` cut

**Rules**
1. Never start a task whose dependencies are not `☑`.
2. A task is `☑` only when its **acceptance criterion** is demonstrably met — not when the code exists.
3. Add tasks freely; only cut them with a note saying why.
4. Anything discovered mid-task that is not in scope becomes a new task, not a bigger current one.

---

## Phase 0 — Architecture & Specification

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P0-T01 | Product identity & principles | — | [00](../docs/00-product-identity.md), [01](../docs/01-principles-and-constraints.md) written | ☑ |
| P0-T02 | System architecture & request lifecycle | T01 | [02](../docs/02-system-architecture.md) written; lifecycle is unambiguous | ☑ |
| P0-T03 | Data model & RLS strategy | T02 | [03](../docs/03-data-model.md) written; every MVP entity covered | ☑ |
| P0-T04 | Memory engine specification | T03 | [04](../docs/04-memory-engine.md) written; algorithms are implementable as written | ☑ |
| P0-T05 | World, character, relationship, orchestration specs | T04 | [05](../docs/05-world-engine.md)–[07](../docs/07-multi-character-orchestration.md) written | ☑ |
| P0-T06 | AI router & prompt architecture | T02 | [08](../docs/08-ai-router.md), [09](../docs/09-context-builder-and-prompts.md) written | ☑ |
| P0-T07 | API contracts | T02 | [10](../docs/10-api-contracts.md) written; SSE protocol fully specified | ☑ |
| P0-T08 | Channels, security, moderation, billing specs | T07 | [11](../docs/11-channels.md)–[14](../docs/14-billing-and-entitlements.md) written | ☑ |
| P0-T09 | Testing, ops, economics, launch specs | T08 | [15](../docs/15-testing-and-evaluation.md)–[18](../docs/18-launch-checklist.md) written | ☑ |
| P0-T10 | Workflow, task board, decision log | all | This file, [WORKFLOW.md](WORKFLOW.md), [DECISIONS.md](DECISIONS.md), [PROGRESS.md](PROGRESS.md) | ☑ |
| P0-T11 | Resolve open decisions D-001…D-003 | T10 | Backend runtime, embedding provider, auth provider decided with ADRs | ☐ |
| P0-T12 | Verify every free-tier limit in [01](../docs/01-principles-and-constraints.md) § Part C | T10 | Every ☐ in that table ticked, with a date and a source | ☐ |
| P0-T13 | Read the whole spec set end to end and list contradictions | T10 | Contradictions found and resolved, or logged as ADRs | ☐ |

**Gate:** every feature-admission question answerable from these docs alone.

---

## Phase 1 — AI Lab & Evaluation Harness

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P1-T01 | Monorepo skeleton: pnpm workspaces, TS strict, eslint, prettier, vitest | P0 gate | `pnpm test` runs; strict mode with no `any` escape hatches | ☐ |
| P1-T02 | **Verify model availability & benchmark candidates** | T01 | Every candidate model's free status, context, tool support and structured-output support verified empirically. Results in `docs/benchmarks/`. ADR recorded. | ☐ |
| P1-T03 | Module-boundary lint rule | T01 | Importing `modules/x/repo` from `modules/y` fails CI | ☐ |
| P1-T04 | `packages/contracts` — core Zod schemas | T01 | Memory, character, world, message, AI request/response schemas | ☐ |
| P1-T05 | `AIProvider` interface + first real provider | T04 | A real generation completes; tokens and latency recorded | ☐ |
| P1-T06 | **Mock provider** (deterministic, failure injection) | T05 | `MOCK_AI=true` produces schema-valid dialogue, extraction, planning; can inject 429/timeout/malformed | ☐ |
| P1-T07 | `EmbeddingProvider` interface + first provider | T04 | 768-dim embeddings; batching; content-hash cache | ☐ |
| P1-T08 | Crude memory loop (in-memory store) | T05, T07 | retrieve → prompt → generate → extract → store runs from a script | ☐ |
| P1-T09 | Ranking formula in `packages/core/memory` | T08 | Pure functions; unit tested; weights in a named, versioned module | ☐ |
| P1-T10 | Extraction prompt v1 + Zod validation + repair path | T06 | Malformed output triggers one repair, then a clean drop; nothing invalid stored | ☐ |
| P1-T11 | Dialogue prompt v1 | T05 | Follows the [09](../docs/09-context-builder-and-prompts.md) skeleton; version recorded per request | ☐ |
| P1-T12 | Four canonical test worlds as seed fixtures | T04 | Ravenhold, Kapoor House, Mars Colony, Ashford — deterministic, committed | ☐ |
| P1-T13 | Eval harness runner | T12 | `pnpm eval <suite>` runs, scores, writes dated JSON to `docs/benchmarks/` | ☐ |
| P1-T14 | Eval suite 1 — memory recall | T13 | 20 facts, 100 turns, probes at 30/60/100 + fresh session | ☐ |
| P1-T15 | Eval suite 3 — character consistency | T13 | LLM judge with a fixed rubric, 3 samples, median | ☐ |
| P1-T16 | Populate the model benchmark table | T02, T14, T15 | ≥ 2 viable models per tier, with recorded quality scores | ☐ |
| P1-T17 | Start the 30-day continuously-played world | T08 | A world exists and is played a few turns most days from here on | ☐ |

**Gate:** recall@k ≥ 0.85, false recall ≤ 0.05, one viable model per tier, chaos test passes with a provider disabled.

---

## Phase 2 — Database

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P2-T01 | Supabase projects: local/dev + staging | P1 gate | Both reachable; credentials in the correct secret stores | ☐ |
| P2-T02 | Migration runner + `db/schema.sql` generation | T01 | `pnpm db:migrate` and `pnpm db:snapshot` work | ☐ |
| P2-T03 | Migrations 0001–0004 (extensions, profiles, worlds, characters) | T02 | Clean run from empty | ☐ |
| P2-T04 | Migrations 0005–0008 (conversations, memory, relationships, events/quests) | T03 | Clean run; FK ordering correct | ☐ |
| P2-T05 | Migrations 0009–0012 (AI usage, jobs, moderation, channels) | T04 | Clean run | ☐ |
| P2-T06 | Migration 0013 — all RLS policies | T05 | Every public table has RLS enabled | ☐ |
| P2-T07 | Migration 0014 — seed plans | T06 | free/creator/pro rows with entitlement JSON | ☐ |
| P2-T08 | CI check: no public table without RLS | T06 | The check query returns zero rows; build fails if not | ☐ |
| P2-T09 | RLS negative tests | T06 | User B cannot read/write/delete user A's world, characters, memories, messages | ☐ |
| P2-T10 | Repo layer for worlds, characters, memories | T05 | Hand-written SQL; typed; no ORM | ☐ |
| P2-T11 | pgvector HNSW index + retrieval query | T04 | Vector search returns in < 100 ms on 10k memories | ☐ |
| P2-T12 | Load the canonical worlds into the real schema | T10 | Phase 1 loop now runs against Postgres | ☐ |
| P2-T13 | Storage measurement at 10k memories | T12 | Actual MB recorded; compared to the projection in [01](../docs/01-principles-and-constraints.md) | ☐ |
| P2-T14 | Backup verification — **perform a real restore** | T12 | A restore into a scratch project succeeds and the data is correct | ☐ |

**Gate:** migrations clean from empty · RLS negative tests pass · seeds load · storage within projection.

---

## Phase 3 — AI Provider Layer

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P3-T01 | Model registry loaded from config | P2 gate | Adding a model requires no code change | ☐ |
| P3-T02 | Tier mapping + task-class routing | T01 | Task class → tier → chain resolves correctly | ☐ |
| P3-T03 | Capability filtering | T02 | A tools-requiring request never routes to a non-tool model | ☐ |
| P3-T04 | Fallback chain with the retry policy | T03 | 429 → next model, no same-model retry; 5xx → one retry then next | ☐ |
| P3-T05 | Circuit breaker in KV | T04 | Opens after 5 failures/50%; half-open probe; exponential cooldown | ☐ |
| P3-T06 | Pre-emptive rate-limit tracking | T05 | An exhausted model is skipped without a network round trip | ☐ |
| P3-T07 | `model_requests` logging on every attempt | T04 | Failures are logged too; `request_id` threaded | ☐ |
| P3-T08 | Structured-output ladder + repair | T04 | Native → tools → prompted JSON; always Zod-validated | ☐ |
| P3-T09 | Compute-unit estimation | T07 | Estimates within 20% of actuals on a 100-call sample | ☐ |
| P3-T10 | Admission control skeleton | T09 | Atomic reservation before any provider call | ☐ |
| P3-T11 | Eval suite 7 — provider chaos | T05 | All six chaos scenarios pass | ☐ |
| P3-T12 | Streaming interface | T04 | `AsyncGenerator` streaming works and falls back to non-streaming | ☐ |
| P3-T13 | Lint rule: no model name outside config | T01 | A hard-coded model id fails CI | ☐ |

**Gate:** every chaos scenario passes · no model name in code · every attempt logged.

---

## Phase 4 — Memory Engine

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P4-T01 | Vector retrieval against pgvector | P3 gate | Top-40 candidates, p95 < 150 ms | ☐ |
| P4-T02 | Keyword retrieval (tsvector + trigram) | T01 | Names and exact terms found reliably | ☐ |
| P4-T03 | Structural retrieval (pinned, recent, subject-matched) | T02 | Pinned memories always present | ☐ |
| P4-T04 | RRF fusion | T03 | Deterministic; unit tested | ☐ |
| P4-T05 | **Knowledge isolation query** | T04 | The § 5 SQL; enforced at query level, never in application code | ☐ |
| P4-T06 | Composite ranking with versioned weights | T05 | Pure function; every term unit tested | ☐ |
| P4-T07 | MMR diversification | T06 | Near-duplicates do not both survive | ☐ |
| P4-T08 | Token-budget packing | T07 | Never exceeds budget; drops whole memories, never partial | ☐ |
| P4-T09 | Query construction with entity extraction | T02 | Per-world alias table; regex, no LLM call | ☐ |
| P4-T10 | Extraction job (rolling window, idempotent) | T08 | ≤ 3 memories per 10 turns at default aggressiveness | ☐ |
| P4-T11 | Anti-duplication at write time | T10 | Cosine > 0.92 merges instead of inserting | ☐ |
| P4-T12 | Importance scoring (model + deterministic adjustment) | T10 | Irreversibility term implemented | ☐ |
| P4-T13 | Embedding job with batching and re-embed support | T10 | Provider change triggers a background re-embed, not an outage | ☐ |
| P4-T14 | Consolidation: merge duplicates | T13 | The Ravenblade case collapses to one memory | ☐ |
| P4-T15 | Consolidation: contradiction resolution | T14 | Precedence ladder applied; loser marked `superseded_by`, not deleted | ☐ |
| P4-T16 | Consolidation: reflections | T15 | Higher-order insights generated every ~100 memories | ☐ |
| P4-T17 | Consolidation: pruning | T16 | Never prunes pinned or user-edited memories | ☐ |
| P4-T18 | Retrieval trace recording | T08 | Per-turn trace with per-term score contributions | ☐ |
| P4-T19 | Job queue: table, claim with SKIP LOCKED, cron dispatcher | T10 | Idempotent handlers; dead-letter after max attempts | ☐ |
| P4-T20 | Eval suite 2 — long horizon | T17 | Days 1/2/7/30/100 simulated | ☐ |
| P4-T21 | Eval suite 4 — knowledge isolation | T05 | 20 adversarial probes; leak rate measured | ☐ |
| P4-T22 | Tune ranking weights against suites 1 and 2 | T20 | Every weight change justified by a measured improvement | ☐ |

**Gate:** recall ≥ 0.90 · precision ≥ 0.60 · false recall ≤ 0.03 · day-100 recall ≥ 0.75 · post-consolidation survival ≥ 0.95 · **leak rate = 0** · retrieval p95 ≤ 400 ms.

---

## Phase 5 — Single-Character Chat

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P5-T01 | Worker skeleton: routing, middleware, error envelope | P4 gate | `X-Request-Id` threaded; errors match [10](../docs/10-api-contracts.md) § 2 | ☐ |
| P5-T02 | Auth middleware + session handling | T01 | JWT verified; refresh rotation with reuse detection | ☐ |
| P5-T03 | Users, profiles, personas endpoints | T02 | CRUD with authorization in the service layer, not only RLS | ☐ |
| P5-T04 | Worlds and characters endpoints (manual creation) | T03 | Full CRUD; ownership enforced | ☐ |
| P5-T05 | Conversations and messages endpoints | T04 | Cursor pagination; soft delete | ☐ |
| P5-T06 | Context builder with section budgeting | T05 | Priority drop order implemented; never crosses the never-drop line | ☐ |
| P5-T07 | Injection defense: write-time sanitization + fencing | T06 | Role markers and delimiter mimics neutralized on save | ☐ |
| P5-T08 | Turn endpoint — full lifecycle | T06 | All 12 steps of [02](../docs/02-system-architecture.md) § 3 in order | ☐ |
| P5-T09 | Conversation locking | T08 | Concurrent turns → one succeeds, one gets `CONVERSATION_BUSY` | ☐ |
| P5-T10 | Idempotency on turn POST | T08 | Duplicate key is a no-op returning the original result | ☐ |
| P5-T11 | Conversation summarization job | T08 | Older turns summarized; `summary_upto_seq` tracked | ☐ |
| P5-T12 | Moderation stages 0–2 | T08 | Cache, heuristics, classifier; § 2 categories hard-blocked | ☐ |
| P5-T13 | Moderation stage 3 (LLM screen) | T12 | Fiction vs instruction distinguished on the ambiguity set | ☐ |
| P5-T14 | Output moderation + regeneration path | T13 | One constrained retry, then a safe fallback line | ☐ |
| P5-T15 | Character voice anchors enforced at creation | T04 | < 2 example lines blocks character creation | ☐ |
| P5-T16 | SSE streaming for the turn endpoint | T08 | All event types from [10](../docs/10-api-contracts.md) § 4 emitted in order | ☐ |
| P5-T17 | Eval suite 3 against the real pipeline | T14 | Consistency ≥ 7.5, adherence ≥ 8.0, forbidden violations = 0 | ☐ |

**Gate:** 200-turn single-character conversation holds voice and memory · suite 3 passes · concurrency and idempotency verified · moderation blocks without mutating state or charging.

---

## Phase 6 — World Engine

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P6-T01 | `world_state` with versioning + optimistic concurrency | P5 gate | Concurrent writes produce `STATE_CONFLICT`, never a lost update | ☐ |
| P6-T02 | Declared flags/numerics validation | T01 | Undeclared key, wrong type or out-of-range is rejected with a reason | ☐ |
| P6-T03 | World rules with contextual keyword injection | T02 | `always` capped at 8; contextual matched by keyword | ☐ |
| P6-T04 | Tool definition layer + backend-computed tool lists | T02 | The prompt cannot widen the tool list | ☐ |
| P6-T05 | Read tools | T04 | All six implemented and scoped to the world | ☐ |
| P6-T06 | Write tools with the 6-step validation pipeline | T05 | Every step enforced; rejections returned to the model as structured results | ☐ |
| P6-T07 | Per-turn mutation caps | T06 | Excess truncated and logged | ☐ |
| P6-T08 | Tool-call idempotency | T06 | A retried generation does not double-apply | ☐ |
| P6-T09 | Events + timeline endpoint | T06 | Append-only; day-ordered | ☐ |
| P6-T10 | Quests with the state machine | T09 | Invalid transitions rejected | ☐ |
| P6-T11 | Quest predicates evaluated after every turn | T10 | Machine-checkable steps auto-complete | ☐ |
| P6-T12 | Inventory and items | T06 | Cannot take what is not held; quantities never negative | ☐ |
| P6-T13 | Time model + `advance_time` + time-passage job | T06 | Decay, scheduled events and a "what changed" summary fire | ☐ |
| P6-T14 | Scenes and transitions | T13 | Presence recomputed; summary written; cache invalidated | ☐ |
| P6-T15 | Chapters + summarization | T14 | Open threads carried forward | ☐ |
| P6-T16 | Guided world creation (draft, not saved) | T03 | User reviews and edits before anything persists | ☐ |
| P6-T17 | Eval suite 5 — world state integrity | T13 | State accuracy 1.00; hard rule violations 0 | ☐ |
| P6-T18 | Prose-assertion detector | T17 | Measures how often the model asserts state without a tool call | ☐ |

**Gate:** suite 5 passes · prose assertions do not mutate state · undeclared writes rejected · concurrency safe.

---

## Phase 7 — Relationship Engine

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P7-T01 | Relationship rows with the 8 directional dimensions | P6 gate | Both directions independently valued | ☐ |
| P7-T02 | Deterministic delta rules | T01 | The § 5 table implemented, free and instant | ☐ |
| P7-T03 | `update_relationship` tool with a required reason | T02 | A delta with no reason is rejected | ☐ |
| P7-T04 | Caps, diminishing returns, asymmetry | T03 | ±15 cap; trust falls faster than it rises | ☐ |
| P7-T05 | Decay on time passage | T04 | Gentle drift; familiarity never decays | ☐ |
| P7-T06 | `relationship_events` audit + timeline query | T03 | Answers "why does she hate me" | ☐ |
| P7-T07 | Derived status labels | T04 | Cached, recomputed on write | ☐ |
| P7-T08 | Romance gating in code | T04 | Blocked without sustained trust + affection; hard block on minor-flagged characters | ☐ |
| P7-T09 | Emotional state (conversation-scoped) | T04 | One line in the prompt; decays over ~5 turns | ☐ |
| P7-T10 | Relationship state in the context builder | T09 | Zero-valued dimensions omitted | ☐ |
| P7-T11 | 500-turn saturation test | T04 | No dimension pegs at ±100 | ☐ |

**Gate:** human reviewer agrees with relationship movement over 100 interactions · caps and reasons enforced · no saturation.

---

## Phase 8 — Multi-Character Orchestration

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P8-T01 | Scene resolution and presence gating | P7 gate | Absent characters cannot be selected, at any score | ☐ |
| P8-T02 | Addressing detection | T01 | Named, group-addressed and unaddressed cases distinguished | ☐ |
| P8-T03 | Candidate scoring (deterministic) | T02 | Pure function; every term unit tested | ☐ |
| P8-T04 | Selection with threshold + tier cap + never-zero fallback | T03 | Never returns an empty responder list | ☐ |
| P8-T05 | Model-assisted planner for ambiguous cases only | T04 | Fires on < 10% of turns | ☐ |
| P8-T06 | Ordering with recency suppression | T04 | No character opens two consecutive turns unless addressed | ☐ |
| P8-T07 | Sequential generation with a shared turn transcript | T06 | Later speakers see and react to earlier ones | ☐ |
| P8-T08 | Per-character context divergence | T07 | Verified: the Son does not receive the Mother's secrets | ☐ |
| P8-T09 | Narrator responder | T07 | World-scope visibility; 1–3 sentences | ☐ |
| P8-T10 | Per-responder timeout and graceful drop | T07 | A timed-out second speaker is dropped, not a stalled turn | ☐ |
| P8-T11 | First-responder streaming | T07 | Text starts arriving while the second generates | ☐ |
| P8-T12 | Tier caps on responders and active characters | T04 | Enforced via entitlements, not hard-coded | ☐ |
| P8-T13 | Eval suite 6 — orchestration | T08 | All five metrics at target | ☐ |
| P8-T14 | Re-run suite 4 with 4+ characters present | T08 | Isolation holds under crowding; leak rate still 0 | ☐ |
| P8-T15 | Measure and tune avg responders/turn | T13 | Lands near 1.6 | ☐ |

**Gate:** suite 6 passes · absent-responder rate 0 · leak rate still 0 · avg responders ≈ 1.6 · 3-responder turn p95 ≤ 14 s.

---

## Phase 9 — Web Application

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P9-T01 | Next.js app + generated SDK client | P8 gate | No `fetch` to our API outside the SDK | ☐ |
| P9-T02 | Auth: signup, login, reset, session | T01 | Reset flow tested against takeover | ☐ |
| P9-T03 | Dashboard with world cards | T02 | Chapter, day, character count, last played | ☐ |
| P9-T04 | Guided world creator (5 questions → editable draft) | T03 | Nothing saves without review | ☐ |
| P9-T05 | Character editor with voice anchors | T04 | Blocks save with < 2 example lines | ☐ |
| P9-T06 | **Chat screen with SSE streaming** | T05 | Responder indicator on `turn.started`, before any text | ☐ |
| P9-T07 | Live world-state panel | T06 | `state.changed` animates relationship and numeric changes | ☐ |
| P9-T08 | Memory notebook: view, pin, edit, delete, add | T06 | Edits take effect on the next turn | ☐ |
| P9-T09 | Settings: account, personas, export, deletion | T02 | Deletion verified to actually delete | ☐ |
| P9-T10 | Error, empty and loading states everywhere | T06 | No dead-looking screen during a 6-second turn | ☐ |
| P9-T11 | Responsive + PWA manifest | T06 | Tested on real phones, not an emulator | ☐ |
| P9-T12 | Landing page | T01 | Communicates persistence in under 10 seconds | ☐ |
| P9-T13 | E2E tests for the eight critical journeys | T09 | All pass in CI | ☐ |
| P9-T14 | Accessibility pass | T10 | Keyboard navigation, contrast, labels on interactive elements | ☐ |
| P9-T15 | First-run onboarding | T04 | Signup → first character reply in < 3 minutes | ☐ |

**Gate:** an unfamiliar person completes the full journey unaided · mobile usable · all E2E pass.

---

## Phase 10 — Telegram

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P10-T01 | Bot creation + webhook with secret token + random path | P9 gate | Unsigned requests rejected with 401 | ☐ |
| P10-T02 | ACK-first processing via `waitUntil` | T01 | Handler returns 200 in < 200 ms | ☐ |
| P10-T03 | Dedupe on `update_id` | T02 | Duplicate delivery does not double-process | ☐ |
| P10-T04 | Inbound normalization to `InboundMessage` | T03 | No Telegram types leak past the adapter | ☐ |
| P10-T05 | Lightweight account creation for unlinked users | T04 | A first-time user can play immediately | ☐ |
| P10-T06 | Commands: start, worlds, new, who, memory, state, link, pause, help | T05 | All work; natural language works without any command | ☐ |
| P10-T07 | Multi-message output with pacing + typing indicators | T06 | One message per character, 300–800 ms apart | ☐ |
| P10-T08 | Outbound send queue with per-chat and global limits | T07 | A 3-character reply in a busy group drops nothing | ☐ |
| P10-T09 | Identity linking with transactional account merge | T05 | Worlds transfer; no half-merged state possible | ☐ |
| P10-T10 | Cross-channel continuity test | T09 | Start on Telegram, continue on web, return — same memories | ☐ |
| P10-T11 | Blocked-bot and error handling | T08 | 403 marks the account inactive; no data loss | ☐ |

**Gate:** cross-channel continuity verified · dedupe verified · rate limits respected · merge transactional.

---

## Phase 11 — Private Beta

| ID | Task | Depends | Acceptance | Status |
|---|---|---|---|---|
| P11-T01 | Analytics instrumentation for every Phase 11 metric | P10 gate | Retention, RWS, cost/user, recall accuracy all measurable | ☐ |
| P11-T02 | Post-session feedback prompt | T01 | *"Did anything feel wrong?"*, free text, optional | ☐ |
| P11-T03 | Fake upgrade button measuring paid intent | T01 | Click-through recorded; no payment taken | ☐ |
| P11-T04 | Gate A checklist complete | T01 | Every box in [18](../docs/18-launch-checklist.md) Gate A ticked | ☐ |
| P11-T05 | Cohort 1 — 10 users | T04 | Two weeks of data | ☐ |
| P11-T06 | Cohort 2 — 25 users | T05 | Metrics hold or improve | ☐ |
| P11-T07 | Cohort 3 — 50 users | T06 | Metrics hold | ☐ |
| P11-T08 | Cohort 4 — 100 users | T07 | Metrics hold | ☐ |
| P11-T09 | **Decision point review** | T08 | Exit gate assessed honestly; result written into PROGRESS.md and an ADR | ☐ |

**Gate:** D7 same-world return > 25% · D30 > 15% · median world age > 14 days · ≥ 3 unprompted "it remembered" · cost per user understood.

---

## Phases 12–20 — outline

Detailed tasks are written when the phase is entered. Writing them now would be planning against unknown beta findings.

| Phase | Headline tasks |
|---|---|
| **12 — Economics** | CU accounting + reconciliation · entitlement service · calibrated rate limits · admin dashboard · cost anomaly detection · **kill switch tested** · degradation ladder · relationship graph, timeline, quest panel, turn-trace UI |
| **13 — Launch** | Brand decision + ADR · trademark search · domain purchase · DNS + email deliverability · legal review · load test at 10× · security checklist · ownership migration · demo video |
| **14 — Subscriptions** | Payment integration · webhook verification + replay protection · lifecycle + reconciliation job · invoicing + tax · cancellation · refunds · first-revenue economics review |
| **15 — Creator** | Publishing · discovery · forking · ratings · publish-time review · **injection hardening for third-party content** · DMCA process |
| **16 — WhatsApp** | Business verification (start early) · Cloud API · raw-body signature verification · 24-h window · one approved template · entitlement gating |
| **17 — Media** | Avatars · scene art · voice — all on separate metered budgets, never core-path |
| **18 — Self-hosting** | Only when every trigger in [17](../docs/17-monetization-and-unit-economics.md) § 9 holds. Rented GPU + vLLM behind `AIProvider`. |
| **19 — Android** | React Native or native on the same SDK; zero duplicated logic |
| **20 — Marketplace** | Paid items · creator payouts · tax · refunds · disputes |

---

## Cross-cutting, continuous

| ID | Task | Cadence |
|---|---|---|
| X-01 | Update [PROGRESS.md](PROGRESS.md) | **End of every session** |
| X-02 | Play the 30-day world | Most days, from P1-T17 |
| X-03 | The weekly hour of real play | Weekly |
| X-04 | Metrics review | Weekly |
| X-05 | Full eval run + benchmark refresh | Monthly |
| X-06 | Re-verify free-tier limits | Monthly |
| X-07 | Dependency audit | Monthly |
| X-08 | Rollback drill + secret rotation | Quarterly |
| X-09 | ADR review — are past decisions still right? | Quarterly |
