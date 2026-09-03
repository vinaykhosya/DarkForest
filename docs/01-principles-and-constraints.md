# 01 — Principles & Constraints

> **Status:** Authoritative. Every principle here is a *veto*: a design that violates one is rejected regardless of its other merits.
> Changing a principle requires an ADR with an explicit "what we are giving up" section.

---

## Part A — Engineering principles

### P1. The database is the source of truth. The model is a narrator.

Any value a user could argue about — gold, health, inventory, quest status, whether a character is alive, what day it is, relationship scores — lives in PostgreSQL and changes only through a validated write path.

The model may *propose* a state change via a tool call. The backend validates and applies it. If the model asserts a state change in prose without a tool call, that assertion is decorative and is not persisted.

> **Failure this prevents:** the model announcing "you now have 50,000 gold," the user believing it, and the next session contradicting it. This single failure mode destroys the illusion of a persistent world faster than anything else.

### P2. Every replaceable dependency sits behind an interface.

At minimum: `AIProvider`, `EmbeddingProvider`, `MemoryStore`, `MessageChannel`, `BillingProvider`, `StorageProvider`, `ModerationProvider`.

No module outside `ai/providers/` may import an SDK for a specific model vendor. No module outside `channels/telegram/` may know Telegram's payload shape.

> **Failure this prevents:** a free endpoint disappearing and taking the product down with it.

### P3. The product must survive the removal of any single model.

Concretely: deleting one provider's credentials from the environment must degrade quality, never cause an outage. This is tested — see [15](15-testing-and-evaluation.md) § Provider Chaos Test.

### P4. Do not use an LLM for anything a query can answer.

| Question | Correct mechanism |
|---|---|
| How much gold does the player have? | `SELECT` |
| Is the quest complete? | Backend predicate |
| Which memories are relevant? | Vector + keyword retrieval, then ranking |
| Who is in this scene? | Join |
| Did the user say something disallowed? | Classifier, then LLM only on ambiguity |
| How would Elena react to being betrayed? | **LLM** |

Inference is the most expensive operation in the system and the only one with a variable, uncapped cost. Reserve it for language, judgment and characterization.

### P5. Modular monolith. One deployable. Internally strict boundaries.

Modules communicate through exported service functions with typed contracts, never by reaching into each other's tables. A module owns its tables; other modules read through its service layer.

Forbidden until proven necessary by measured pain: Kubernetes, microservices, Kafka, Neo4j, Redis clusters, service meshes, event-sourcing frameworks.

> **Rationale:** a solo founder's scarcest resource is attention, and distributed systems consume it at a fixed rate regardless of traffic.

### P6. Every AI call is metered before it is made.

No code path may reach a provider without first passing an admission check that (a) resolves the user's entitlements, (b) reserves compute units, and (c) records the attempt. Post-hoc accounting is not acceptable; a runaway loop must be stopped by the pre-flight check, not discovered on a bill.

### P7. Untrusted text never becomes instructions.

World rules, character descriptions, lorebooks, persona text and marketplace content are authored by users. When any of it enters a prompt it is fenced, labelled as data, and stripped of instruction-shaped content. Tool permissions for a turn are computed by the backend before the prompt is built and cannot be widened by anything inside it.

See [09](09-context-builder-and-prompts.md) § Injection Defense and [12](12-security.md) § T-07.

### P8. Failure is a designed state, not an exception.

Every external dependency has a defined behaviour for: unavailable, slow, rate-limited, and returning garbage. The degradation ladder in [16](16-observability-and-ops.md) § Degradation Ladder is the canonical list. "Throw a 500" is a valid choice only where it is written down as the choice.

### P9. Privacy is a design input, not a policy page.

Users write intimate, personal fiction. Therefore: conversation content is not logged to observability systems, staff access is gated and audited, deletion is real deletion, and user content is never used for model training absent explicit, separately-obtained, revocable consent.

### P10. Tests before scale, evals before model changes.

A model swap without running the evaluation suite is forbidden. "It felt better" is not a merge justification. See [15](15-testing-and-evaluation.md).

---

## Part B — Business constraints

### B1. ₹0 personal capital during development.

Free tiers, free endpoints and local development only. The single permitted pre-revenue expense is one domain, purchased in Phase 13, immediately before public launch.

### B2. No infrastructure purchase can precede the data that justifies it.

No GPU. No paid inference commitment. No reserved capacity. Each is unlocked by a specific measured trigger recorded in [17](17-monetization-and-unit-economics.md) § Self-Hosting Trigger.

### B3. Only legitimate provider access.

**Amended 2026-09-03 by ADR-019.** The original text read *"No multi-account rotation… One account per provider."* Multi-credential pools are now permitted; the rest of the clause stands unchanged.

Still prohibited, without exception:

- Rate-limit evasion — no retry-storming a 429, no clock manipulation, no header spoofing
- Quota circumvention beyond holding legitimate, independently-registered accounts
- Scraping provider endpoints, or using undocumented APIs
- Any use a provider's terms forbid — enforced in code by `checkPoolEligibility()`, which is untouched by ADR-019

**The risk we accepted, stated plainly:** accounts registered by one person tend to share a phone, an email domain and an IP. Enforcement is therefore correlated — a provider acting against one account likely takes the whole pool at once. That is a single point of failure wearing the costume of redundancy, and it is most acute on our only production-eligible privacy-clean provider.

The original rationale also still stands and is *not* resolved by the amendment: an architecture that depends on pooled free accounts is harder to hand to a partner, an investor or an acquirer. **Whether pooled credentials serve real users is deliberately deferred to Phase 11** and is a blocking item on Gate B of the [launch checklist](18-launch-checklist.md). Development traffic — synthetic, local, and permitted by every provider's terms including NVIDIA's — is not in question.

### B4. Memory is never paywalled.

Persistence *is* the product. Charging for it would make the free tier a demo of a different, worse product, and would destroy the retention signal we need in order to learn anything.

What is monetized: **volume, complexity, model tier, world size, and optional media** — i.e. compute, not identity.

### B5. No unlimited promises, ever.

All plans carry explicit limits, expressed to the user in human units (messages/day, world size) and tracked internally in compute units.

### B6. The business finances itself.

Revenue order of application: infrastructure reliability → product → marketing → inference capacity → founder compensation. Personal funds never subsidize free-tier inference.

### B7. Ownership migrates to the company before commercial launch.

Personal accounts are acceptable for a prototype. Before taking a single payment: domain, cloud accounts, database, repositories, provider accounts, bot tokens and billing move to company-controlled identities with recovery paths that do not depend on one person's phone. Gate condition in [18](18-launch-checklist.md).

---

## Part C — Platform limits we are designing against

These are the hard numbers the architecture must respect. **Every one carries an expiry: re-verify monthly (task X-06) and before Phase 13.** Free-tier terms change without notice.

**Verified 2026-09-03** against provider documentation directly. Full detail and sources: [provider landscape](benchmarks/2026-09-03-provider-landscape.md).

| Platform | Verified limit | Design consequence | ✔ |
|---|---|---|---|
| Cloudflare Workers (Free) | **100,000 requests/day** | Adequate to ~1–2k DAU. Alert at 60%. | ☑ |
| Cloudflare Workers (Free) | **10 ms CPU per invocation** | I/O wait is not CPU, so orchestration fits — but **no heavy JS in the request path**. In particular: MMR and ranking operate on compact score vectors, never raw 768-dim embeddings. Similarity comes from Postgres. | ☑ |
| Cloudflare Workers (Free) | **50 subrequests per request** | Every PostgREST call counts. **Batch all database reads**; hard-cap responders per turn. A 3-responder turn budget: ~6 model calls + ~12 DB calls, leaving headroom. | ☑ |
| Cloudflare Workers (Free) | **6 simultaneous outgoing connections** | Sequential generation is unaffected. Parallel split-scene generation is capped at 6. | ☑ |
| Cloudflare Workers (Free) | **5 cron triggers per *account*** (not per Worker) | Tighter than assumed. **One** dispatcher cron, fanning out by job type. | ☑ |
| Cloudflare Workers (Free) | 3 MB compressed script; 15 min max cron duration | Not a constraint at our size. | ☑ |
| Cloudflare Queues | Paid-plan feature | `jobs` table + cron + `waitUntil` (ADR-005). Do not design around Queues. | ☑ |
| Cloudflare Workers AI (Free) | **10,000 neurons/day**, shared across all model types | ≈1.65M embedding tokens/day via `bge-base-en-v1.5` (~6 neurons/1K tok). **Embeddings only** — do not route dialogue here. | ☑ |
| Supabase (Free) | **500 MB database** | **Embeddings dominate.** See storage math below. | ☑ |
| Supabase (Free) | **1 GB file storage** | No user image uploads at MVP. Avatars generated or preset. | ☑ |
| Supabase (Free) | **50,000 MAU · 5 GB egress** | Not a constraint before Phase 13. Egress is worth watching once streaming is live. | ☑ |
| Supabase (Free) | **2 active projects per organisation**; paused after 1 week idle | Local dev uses **Docker**, not a project slot. That leaves staging + production. Idle pause matters for staging. | ☑ |
| Groq (Free) | **30 RPM · 1,000 req/day · 200K tokens/day, per model** | 4 usable models ⇒ ~800K tok/day. **Tokens bind before requests** — hence the compact context profile (ADR-012). | ☑ |
| OpenRouter `:free` | **20 RPM · 50 req/day** → **1,000/day** after a one-time $10 credit. No token/day cap. | Deep tier and long context. The $10 unlock is a Phase 11 prerequisite (ADR-011). | ☑ |
| OpenRouter Nemotron | 1M context, tool calling ✅, **`response_format` ✗** | Structured output **must** use the tool-calling fallback ([08](08-ai-router.md) § 9). Confirmed, not hypothetical. | ☑ |
| Gemini / NVIDIA NIM (Free) | Generous, but both **train on submitted content** and warn against personal data | **Development only.** Disabled by config in production — a Gate A checklist item. | ☑ |
| Telegram Bot API | Free; ~30 msg/s global, ~20 msg/min per group | Outbound send queue with per-chat pacing, from day one of Phase 10. | ☐ |

> **The binding constraint is tokens per day, not requests per day.** At ~12,000 tokens per generation, the total ₹0 pool is roughly **70 multi-character turns per day platform-wide**. Sufficient for Phases 1–10; not sufficient for a 50–100 user beta. See ADR-011 and ADR-012.

### Storage math — the real free-tier constraint

A 768-dimension `vector` in pgvector is 4 bytes/dim + overhead ≈ **3.1 KB per embedding**, before the HNSW index (which adds roughly another 40–60%).

| Memories | Raw vectors | With index | Verdict on 500 MB |
|---|---|---|---|
| 25,000 | ~78 MB | ~120 MB | Comfortable |
| 100,000 | ~310 MB | ~480 MB | **At the limit** |
| 250,000 | ~780 MB | — | Over |

Mitigations, applied in this order:

1. **Be selective at extraction.** Target ≤3 memories per 10 turns. Most conversation is not worth remembering.
2. **Use `halfvec(768)`** (16-bit) — halves vector storage for a negligible recall cost at our scale.
3. **Consolidate aggressively.** Five phrasings of one fact become one row.
4. **Tier by importance.** Only memories above an importance threshold get embedded; the rest are keyword-searchable only.
5. **Archive cold worlds.** A world untouched for 90 days drops its embeddings; they are regenerated on next access.

This is why `embedding_model` and `embedding_version` are columns on the embedding table — re-embedding must be a routine background operation, not a migration crisis.

---

## Part D — Scope discipline

### The MVP contains exactly this

Authentication · persona · world creation · character creation · chat · memory · relationships · world state · save/load.

### The MVP contains none of this

Marketplace · creator payouts · voice · image generation · native Android · 43+ character worlds · economy simulation · autonomous NPC background simulation · multi-model selection UI · export · group play · WhatsApp.

Each of these has a phase assigned in [WORKFLOW.md](../workflow/WORKFLOW.md). Building one early is not ambition, it is a deferral of the retention question that decides whether any of it is worth building.

### The feature-admission questionnaire

No feature enters a phase plan until these are answered in writing on its task card:

1. What problem does it solve, for which persona?
2. What data does it need, and which module owns that data?
3. What API does it expose?
4. What tables or migrations does it require?
5. What happens when it fails?
6. How is it tested — and can it be tested without a live model?
7. What does it cost per invocation, in compute units?
8. How does it change the free tier's cost profile?
9. How does it behave at 100× current load?
10. What does it prevent us from building later?

Question 10 is the one that is usually skipped and usually matters most.
