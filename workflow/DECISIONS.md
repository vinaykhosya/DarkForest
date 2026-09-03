# DECISION LOG (ADRs)

> Every decision that would be expensive to reverse lives here.
> **Rule:** reversing anything marked *Authoritative* in `docs/` requires a new ADR that states explicitly what is being given up.

**Format**

```
## ADR-NNN — Title
Date · Status (Proposed | Accepted | Superseded by ADR-XXX | Rejected)
Context   — the situation that forced a choice
Decision  — what we chose
Rationale — why
Trade-off — what we gave up. NEVER leave this blank.
Revisit   — the condition that should make us reconsider
```

---

## Accepted

### ADR-001 — Modular monolith, not microservices
**2026-09-03 · Accepted**

**Context.** A solo founder building a system with several distinct engines (memory, world, relationships, orchestration, AI routing).

**Decision.** One deployable application with strictly enforced internal module boundaries. No service extraction until a measured trigger fires ([02](../docs/02-system-architecture.md) § 9).

**Rationale.** Distributed systems consume operational attention at a fixed rate regardless of traffic. Attention is the scarcest resource here. Boundaries enforced by lint rules give most of the architectural benefit at none of the operational cost.

**Trade-off.** No independent scaling of components. A memory-engine bug can take down chat. Extraction later costs more than designing for it now.

**Revisit.** A second engineer joins, or one module's resource profile diverges sharply from the rest.

---

### ADR-002 — Database-authoritative state, model as narrator
**2026-09-03 · Accepted**

**Context.** LLMs assert state changes fluently and incorrectly. Users notice contradictions immediately, and contradictions destroy the illusion of a persistent world faster than any other failure.

**Decision.** All contestable state lives in PostgreSQL and changes only through validated tool calls. Prose assertions of state change are not persisted.

**Rationale.** It is the only approach that survives context limits, model swaps and month-long worlds.

**Trade-off.** More engineering. Sometimes the model narrates something that did not happen and the world quietly disagrees. Every new state variable needs a declared schema and a tool.

**Revisit.** Never, for contestable state. Purely narrative colour is deliberately outside this rule.

---

### ADR-003 — No ORM
**2026-09-03 · Accepted**

**Context.** Retrieval mixes vector distance, full-text rank, RRF fusion and business filters in single queries.

**Decision.** Hand-written SQL in `repo.ts` files, one per module.

**Rationale.** The queries that matter most in this system are exactly the ones ORMs express worst. Query shape is a performance and correctness concern we need to see.

**Trade-off.** More boilerplate for simple CRUD. No automatic migration generation. Type safety at the SQL boundary must be maintained by hand.

**Revisit.** If CRUD boilerplate measurably dominates development time.

---

### ADR-004 — Memory is never paywalled
**2026-09-03 · Accepted**

**Context.** Memory is the most expensive subsystem to build and the most obvious thing to charge for.

**Decision.** Persistent memory, relationships, world state and the memory notebook are available on every plan including free. Monetization is on volume, complexity, tier and world size.

**Rationale.** Persistence *is* the product ([00](../docs/00-product-identity.md)). Paywalling it makes the free tier a demo of a different, worse product — and destroys the retention signal Phase 11 exists to measure.

**Trade-off.** A meaningful conversion lever is deliberately unavailable. Free users cost more than they would otherwise.

**Revisit.** Only if free-tier economics become unsustainable *and* every other lever (limits, routing, conversion) is exhausted. Even then, reduce free volume rather than remove memory.

---

### ADR-005 — Jobs table + cron, not a managed queue
**2026-09-03 · Accepted**

**Context.** Cloudflare Queues is a paid feature; the ₹0 constraint forbids it.

**Decision.** A `jobs` table drained by a single cron-triggered dispatcher, with `ctx.waitUntil()` for best-effort immediate execution.

**Rationale.** Near-real-time in the common case, guaranteed within a minute in the failure case, at zero cost. Postgres `SKIP LOCKED` is a genuinely good queue for our volume.

**Trade-off.** More database load. Up to a minute of latency on retried jobs. We maintain queue semantics ourselves (claiming, backoff, dead-lettering).

**Revisit.** Job volume outgrows what Postgres comfortably handles, or a managed queue becomes free/affordable.

---

### ADR-006 — No field-level encryption of message content at MVP
**2026-09-03 · Accepted**

**Context.** Users write intimate, personal fiction. Encrypting content at rest at the field level would be the strongest privacy posture.

**Decision.** Rely on provider-level encryption at rest. Do not implement field-level encryption at MVP.

**Rationale.** Field-level encryption breaks vector retrieval, full-text search and moderation — i.e. it breaks the product. The privacy commitment is met instead through strict logging rules, audited staff access, real deletion and no training on user content ([12](../docs/12-security.md) § 7).

**Trade-off.** A database compromise exposes content. This is a real, accepted risk, stated plainly rather than hidden.

**Revisit.** If we ever handle a content category where the threat model changes materially, or if searchable encryption becomes practical at our scale.

---

### ADR-007 — 768-dimension `halfvec` embeddings
**2026-09-03 · Accepted**

**Context.** Supabase free tier is ~500 MB. Embeddings dominate storage ([01](../docs/01-principles-and-constraints.md) § Storage math).

**Decision.** `halfvec(768)` with an HNSW index, plus `embedding_model` and `embedding_version` columns on every row.

**Rationale.** 768 is the common output size for available free embedding models. Half precision halves storage at negligible recall cost at our scale. Versioning columns make a provider change a background job rather than a migration crisis.

**Trade-off.** Locked to 768 dimensions until a migration. Slight recall loss versus full precision.

**Revisit.** Storage ceases to be the binding constraint, or a materially better embedding model uses a different dimensionality.

---

### ADR-008 — Deterministic responder selection, not model-planned
**2026-09-03 · Accepted**

**Context.** Deciding who speaks could be delegated to a model on every turn.

**Decision.** Deterministic scoring ([07](../docs/07-multi-character-orchestration.md) § 4). A model-assisted planner runs only when the top scores are genuinely ambiguous — expected on under 10% of turns.

**Rationale.** Selection is the largest cost multiplier in the system. Spending an inference call to decide how to spend inference calls is backwards. Deterministic selection is also reproducible, which makes it testable.

**Trade-off.** Selection quality is bounded by the scoring function. Some subtle social dynamics will be missed.

**Revisit.** Suite 6 speaker-selection accuracy stays below 0.80 after tuning.

---

### ADR-009 — Groq is the primary provider; Gemini and NVIDIA are development-only
**2026-09-03 · Accepted · Supersedes the OpenRouter-first assumption in the source blueprint**

**Context.** Verified free-tier research ([provider landscape](../docs/benchmarks/2026-09-03-provider-landscape.md)) found that OpenRouter's `:free` endpoints allow only **50 requests/day** without credits — roughly 10 multi-character turns per day for the entire platform. Meanwhile Gemini's and NVIDIA's free tiers both explicitly warn against submitting personal data and use inputs to improve their models, which contradicts our privacy commitment ([12](../docs/12-security.md) § 7).

**Decision.**

| Role | Provider | Rationale |
|---|---|---|
| `fast` + `standard` dialogue | **Groq** | 1,000 req/day per model across 4 usable models, and contractually does not train on inputs or outputs — free tier included |
| Embeddings | **Cloudflare Workers AI** (`bge-base-en-v1.5`) | 768-dim as specced, ~1.65M tokens/day free, does not train, already in stack |
| Moderation stage 2 | **Groq** `gpt-oss-safeguard-20b` | Purpose-built, same free pool |
| Injection detection | **Groq** `llama-prompt-guard-2-86m` | 14,400 req/day — effectively unlimited at our scale |
| `deep` tier + long context | **OpenRouter** Nemotron Ultra / Lightning | 1M context, no token/day cap; 50 req/day until the $10 unlock |
| Bulk eval + benchmarking | **Gemini**, **NVIDIA NIM** | Generous, but **synthetic/founder data only** |

**Rationale.** Groq is the only high-volume free provider whose terms permit real user content without contradicting our own privacy policy. That single fact resolves what appeared to be a forced choice between the ₹0 constraint and the privacy promise.

**Trade-off.** Groq's 200K tokens/day per-model cap binds before its request cap, limiting us to ~70 turns/day platform-wide at ₹0. Gemini and NVIDIA — the two most generous pools — are unusable for production, so their capacity does not count toward beta scale.

**Enforcement.** Gemini and NVIDIA providers are **disabled by config in the production environment**. This is a Gate A checklist item, not a convention.

**Revisit.** Monthly (task X-06). Free tiers change without notice; this ADR assumes nothing permanent.

---

### ADR-010 — Build on Hono; deploy to Workers, stay portable to Node
**2026-09-03 · Accepted · Resolves D-001**

**Context.** Cloudflare Workers Free imposes **10 ms CPU per invocation**, **50 subrequests per request**, 6 simultaneous outgoing connections and **5 cron triggers per account**. The CPU limit is a genuine risk for MMR and ranking math over 40 candidate vectors; the subrequest cap is a genuine risk for a multi-character turn that issues several model calls plus many database queries.

**Decision.** Write the backend against **Hono**, which runs unmodified on both Workers and Node. Deploy to Workers initially. Keep all platform access behind `apps/api/src/platform/` so the runtime is swappable.

**Rationale.** The Workers free tier is the best fit for our budget and the constraints are *probably* compatible with an I/O-bound workload — but "probably" is not a good basis for a one-way door. Hono removes the door entirely at near-zero cost.

**Trade-off.** Slightly more discipline: no Workers-specific API may be used outside `platform/`. Marginally less idiomatic than writing directly against the Workers runtime.

**Consequences that follow immediately:**
- Heavy vector math must not run in the request path. MMR and ranking operate on **compact score vectors, not raw 768-dim embeddings** — similarity comes back from Postgres, which is where the vectors already are.
- Database access must be **batched**. Every PostgREST call is a subrequest against the 50-per-request budget.
- **One cron trigger**, fanning out by job type ([02](../docs/02-system-architecture.md) § 4) — 5 per *account*, not per Worker, is tighter than assumed.

**Revisit.** If measured CPU or subrequest usage approaches the limits in normal operation, flip to Node deployment rather than contorting the design.

---

### ADR-011 — The $10 OpenRouter credit is a Phase 11 prerequisite, not a budget violation
**2026-09-03 · Accepted**

**Context.** ₹0 free-tier capacity totals roughly **70 turns/day platform-wide** — sufficient for development, insufficient for a 50–100 user beta. A one-time $10 OpenRouter credit purchase permanently raises `:free` limits from 50 to 1,000 requests/day, and those endpoints cap requests rather than tokens, at 1M context.

**Decision.** Development (Phases 1–10) runs at ₹0. The $10 purchase is made **before Phase 11 cohort 1**, and is recorded as a launch expense alongside the domain.

**Rationale.** ~₹900 once converts ~70 turns/day into ~600 turns/day — a ~9× capacity increase for a fraction of the domain cost. Refusing it would mean either a beta too small to produce a meaningful retention signal, or accepting a privacy compromise instead. Both are worse outcomes than a one-time unlock.

**Trade-off.** Technically a departure from "₹0 personal capital during development" ([01](../docs/01-principles-and-constraints.md) § B1). Framed correctly: it is a **launch expense**, incurred at the same stage as the domain, not a development subsidy. § B1's real intent — never subsidize uncontrolled inference from personal funds — is untouched.

**Revisit.** If Groq or another provider raises free limits enough to run the beta, skip the purchase.

---

### ADR-012 — Add a compact context profile
**2026-09-03 · Accepted**

**Context.** The dialogue context budget in [09](../docs/09-context-builder-and-prompts.md) § 2 is ~12,000 tokens per generation. Against Groq's 200K tokens/day per-model cap, that is ~16 generations per model per day. **Context size is now an economic lever, not only a quality one.**

**Decision.** The context builder supports two profiles:

| Profile | Budget | Used for |
|---|---|---|
| `full` | ~12,000 tok | Paid tiers, dramatic beats, first responder in a turn |
| `compact` | ~5,000 tok | Free tier, `dialogue_reaction`, second and later responders |

`compact` trims: memories 12 → 6, transcript 12 → 6 messages, no conversation summary, no recent events, character backstory truncated. It **never** trims character identity, voice anchors, hard rules, world state, prior speakers or the user message.

**Rationale.** Roughly doubles free-tier capacity. It also matches a real quality observation — later responders in a turn are writing a short reaction, not opening a scene, and do not need the full package.

**Trade-off.** Two profiles to maintain and to evaluate. Quality on `compact` must be measured separately in suite 3, not assumed equivalent.

**Revisit.** If suite 3 shows `compact` scoring more than 0.5 below `full`, the trim list is wrong.

---

### ADR-013 — NVIDIA NIM is development-only, on contractual grounds
**2026-09-03 · Accepted · Verified against the primary source, not summaries**

**Context.** We evaluated serving free-tier users from NVIDIA's free NIM API with a disclosure notice. The founder set a blocking condition: verify whether NVIDIA's terms permit production SaaS use *before* changing provider policy.

**Finding.** The [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf), read directly:

- **§1.2** — "NVIDIA will provide you access to the API Service for limited trial purposes only and **without use of the API Service or Generated Content in production**."
- **§1.4** — "You must purchase a separate service subscription … to use the API Service in production … Unless you purchase a Subscription …, you may only use the API Service for **internal testing and evaluation purposes, not in production**."
- NVIDIA defines production as "any non-testing activity **including activity serving real end-users**."
- **§2.6(a)** — "**you agree you will not** … include any confidential information, controlled or sensitive data, including … **personal data**."
- **§3.3** — NVIDIA collects "User Content and Generated Content **to improve NVIDIA products and services, including AI models**."
- **§2.6(d)** — content must not be "defamatory, obscene, pornographic, vulgar or **offensive**."
- **§1.3** — pre-release services are "not intended for use in production or business-critical systems."

**Decision.** NVIDIA NIM is a **development-only** provider. It may be used for benchmarking and evaluation against synthetic data, from the local environment only. It is never reachable by end-user traffic.

**Why a disclaimer cannot fix this — the load-bearing point.** §2.6(a) is an obligation **we** accept when we accept the ToS. Our users are not party to that agreement. If a user enters personal data and we forward it, **we** are the party in breach — a user cannot breach a contract they never signed, and cannot waive an obligation they do not hold. Consent flows in the wrong direction for the disclaimer to do any work here.

Separately, §1.2 and §1.4 are not a privacy matter at all: they are a scope-of-licence restriction. No amount of user consent grants us a licence NVIDIA has not granted.

**Trade-off.** We lose a large free capacity pool. This is genuinely costly for beta scale. Mitigated by ADR-011 and ADR-014.

**Note.** Even setting terms aside, NVIDIA's 40 RPM would not serve 100 concurrent users, so this does not forfeit a solution to the scaling problem — it removes an option that was not one.

**Revisit.** If NVIDIA introduces a free or low-cost tier that explicitly permits production use. The AI Enterprise path (~$4,500/GPU/year) is out of scope until well past the self-hosting trigger.

---

### ADR-014 — Inference pools, not tier-to-provider mapping
**2026-09-03 · Accepted · Refines ADR-009**

**Context.** ADR-009 was drifting toward statements of the form "free tier = provider X". That shape converts any provider's terms change into a product outage and a business-logic rewrite.

**Decision.** Plans select a **pool**; the router decides which provider currently serves it.

| Pool | Admission criteria | Serves |
|---|---|---|
| `private` | Terms permit production **and** provider does not train on input | Paid tiers; any world marked Private |
| `standard` | Terms permit production; may train on input (disclosed) | Free tier; Standard worlds |
| `development` | Everything, including terms-restricted providers | Benchmarks and evals, local + synthetic only |

Pool membership is **derived from policy, never hand-set** (`poolsFor()` in `@darkforest/contracts`). Making the two independently editable is precisely how a development-only model eventually ends up serving a paying customer.

**Enforcement is code, not documentation.** `checkPoolEligibility()` in `@darkforest/core` gates every routing decision, fails closed when the synthetic-content flag is omitted, and cites the governing clause in its rejection. 19 tests encode the three real provider cases.

**Trade-off.** More machinery than a lookup table, and every new provider needs its terms read and recorded before it can be used. That reading is the point.

**Revisit.** Never as a shape. Pool membership changes constantly; that is the design working.

---

### ADR-015 — Private World / Standard World as a user-facing choice
**2026-09-03 · Accepted · Phase 12+**

**Context.** With two production-eligible pools of differing privacy properties, the difference can be a product feature rather than a hidden implementation detail.

**Decision.** A world carries an inference-pool preference the user sets at creation and can change:

> **🟢 Private World** — routed only through providers contractually barred from training on your content.
>
> **🔵 Standard World** — routed through the most cost-efficient available providers. Your conversations may be used by those providers to improve their models. Don't enter real personal information.

**Rules:**
1. Consent attaches to the **pool property**, not to a named provider — provider sets change, and re-consenting every user on each change is unworkable. The user agrees to "may be used to improve their models," which stays true whoever serves.
2. Standard requires **explicit opt-in**, recorded with a timestamp and the disclosure version shown.
3. A Private world **never** falls back to a Standard provider. If the private pool is exhausted it queues or degrades ([16](../docs/16-observability-and-ops.md) § Degradation Ladder) — silently downgrading privacy is the worst possible failure mode.
4. Memory, world state and relationships are **DarkForest's data** throughout. Providers receive only the minimum context for one generation, never the corpus. This is a privacy property of the context builder, not only a cost optimisation.

**Trade-off.** A second routing path to test and a genuine possibility of user confusion. Mitigated by making Private the default for paid tiers and stating the difference in one sentence, not a policy page.

---

### ADR-016 — Gate LLM memory extraction behind a deterministic classifier
**2026-09-03 · Accepted · Amends [04](../docs/04-memory-engine.md) § 4**

**Context.** As specified, extraction ran an LLM call over a rolling window after every turn. Against Groq's 200K tokens/day cap that is a meaningful share of total capacity spent deciding that nothing happened.

**Decision.** A cheap deterministic pre-filter runs first and only escalates when it fires:

```
turn committed
      ↓
deterministic signals  (free, ~0 ms)
  · first mention of a named entity in this world
  · commissive verbs — promise, swear, vow, agree, refuse
  · irreversible events — death, betrayal, departure, gift, reveal
  · a validated tool call already fired this turn
  · relationship delta applied by a deterministic rule
  · explicit user preference statement
  · N turns since last extraction (floor, so slow scenes still get captured)
      ↓
  none fired → skip. No LLM call. No memory.
  any fired  → enqueue LLM extraction over the rolling window
```

**Rationale.** Most turns genuinely contain nothing worth remembering — [04](../docs/04-memory-engine.md) § 4 already targets ≤3 memories per 10 turns. Paying an LLM call to confirm that, on every turn, is the clearest instance of violating [01](../docs/01-principles-and-constraints.md) § P4 in the whole design.

**Trade-off.** The pre-filter will miss some subtle memories the LLM would have caught. Mitigated by the turn-count floor, and measured directly: eval suite 1 recall must not drop when the gate is enabled. **If recall falls more than 2 points, the gate is wrong and comes out.**

**Revisit.** After suite 1 runs with and without the gate. This decision is explicitly provisional pending that measurement.

---

### ADR-017 — Distribute load across the pool; do not drain providers sequentially
**2026-09-03 · Accepted · Extends [08](../docs/08-ai-router.md) § 6**

**Context.** The router as specified walks an *ordered* fallback chain: try model 1, on failure try model 2. That is correct for **failure** handling and wrong for **capacity** handling. With ordered draining, model 1's 200K tokens/day is exhausted by mid-afternoon while three equivalent models sit untouched, and every user in that window sees degraded routing for no reason.

Our binding constraint is tokens/day, not requests/day ([01](../docs/01-principles-and-constraints.md) § Part C), which makes this materially worse than it would be under an RPM-bound regime.

**Decision.** Two distinct mechanisms, deliberately not conflated:

| Mechanism | Trigger | Behaviour |
|---|---|---|
| **Distribution** | Normal operation | Among *healthy, eligible, equivalent-tier* candidates, pick the one with the **most remaining headroom** as a fraction of its own daily budget |
| **Fallback** | A call actually failed | Walk the ordered chain, skipping the failed model ([08](../docs/08-ai-router.md) § 6 unchanged) |

Headroom is fractional, not absolute, so a model with a 500K budget and one with 200K are compared fairly.

**Rationale.** Spreads consumption evenly, so the whole pool exhausts at roughly the same time rather than one model at a time. Also smooths quality: users are not sorted into "got the good model" and "got the fallback" by time of day.

**Trade-off.** Response quality becomes slightly less predictable turn to turn, since two equivalent-tier models are not identical in character. Mitigated by requiring a benchmarked quality score within a tolerance band before two models are treated as equivalent — a model 1.5 points below its tier-mate is not a peer and is not load-balanced against it.

**Revisit.** If quality variance inside a tier becomes a user-visible complaint, narrow the equivalence band.

---

### ADR-018 — Capacity priority is an entitlement, and it degrades rather than refuses
**2026-09-03 · Accepted**

**Context.** When the pool nears exhaustion, someone has to be served worse. Deciding that implicitly — i.e. whoever arrives first — means a free user's idle browsing can consume the capacity a paying subscriber needs an hour later.

**Decision.** A `capacity.priority` integer entitlement (free 10, creator 50, pro 100). On contention, in this order:

```
pool headroom < 25%   free tier drops to the compact context profile (ADR-012)
pool headroom < 15%   free tier capped at 1 responder per turn
pool headroom < 10%   free tier routed to `fast` tier only
pool headroom <  5%   free tier queued; paid tiers served normally
pool exhausted        everyone queued — degradation ladder Level 4
```

**Rationale.** Paying users should feel the squeeze last, but a free user is a future paying user and must never be shown a wall while capacity remains. Every step above degrades before refusing ([16](../docs/16-observability-and-ops.md) § Degradation Ladder).

**Trade-off.** Free-tier quality varies with total platform load, which is invisible to the user and therefore confusing when they compare sessions. Accepted: the alternative is either refusing free users earlier or letting them displace subscribers.

**Note.** This is *capacity* priority, distinct from the `feature.priority_queue` entitlement in [14](../docs/14-billing-and-entitlements.md) (queue ordering). Both exist; they are not the same lever.

**Revisit.** After Phase 12 measures how often headroom actually drops below 25%. If it never does, this is over-engineering and the thresholds should widen.

---

### ADR-019 — Multi-credential pools per provider
**2026-09-03 · Accepted · Supersedes R-001 · Amends [01](../docs/01-principles-and-constraints.md) § B3**

**Context.** Throughput per credential is the binding constraint on development
velocity: one Groq key yields ~800K tokens/day, and a multi-character turn plus
extraction consumes several thousand. The founder holds multiple pre-existing
credentials per provider from a retired project.

**Measured first.** A diagnostic fired one request per Groq key and read the
returned rate-limit headers. All four reported `remaining_requests=999` — had the
budget been shared, the fourth would have read 996. **The credentials are
independent and pooling them genuinely multiplies capacity.** This was worth
measuring rather than assuming: for many providers limits are account-scoped and
extra keys buy nothing at all.

**Decision.** Providers accept a comma-separated credential list. The router
selects by fractional headroom (the ADR-017 rule applied per credential), tracks
RPM/RPD/TPM/TPD per credential, cools rate-limited credentials, and permanently
disables rejected ones.

**What this reverses.** R-001 rejected multi-account rotation, and § B3 vetoed
it. The founder was presented with the risk analysis and reaffirmed. Recording it
here rather than letting the code quietly contradict the docs (CLAUDE.md § 2).

**Trade-off — accepted explicitly:**

- **Correlated enforcement.** Accounts created by one person likely share a
  phone, email domain and IP. If a provider acts, it takes the whole pool at
  once — a single point of failure wearing the costume of redundancy. This is
  most acute on Groq, our only production-eligible privacy-clean provider.
- **The architecture is harder to hand over.** A dependency on pooled free
  accounts is not something that survives diligence by a partner or acquirer.
- **§ B3's remaining half still holds:** no rate-limit evasion, no quota
  circumvention beyond holding legitimate independent accounts, no scraping.

**What is NOT affected.** `checkPoolEligibility()` (ADR-013/014) is untouched and
still enforced. NVIDIA and Gemini remain barred from any traffic that is not
local-and-synthetic. Pooling changes *how many credentials* a provider has, never
*which providers may serve users*.

**Why this is currently uncontroversial.** All Phase 1 traffic is synthetic test
data in local development, which every provider's terms explicitly permit —
including NVIDIA's, whose restriction is on production specifically. The
contentious case is production traffic, which does not exist yet.

**Deferred to Phase 11 — must be revisited, not forgotten:**

- [ ] Whether pooled free accounts serve real users, or production moves to one
      credential per provider plus paid capacity
- [ ] Privacy policy rewrite; the founder has deferred this deliberately
- [ ] Re-verify each provider's terms on multiple accounts before public launch

Added to the [launch checklist](../docs/18-launch-checklist.md) Gate B as a
blocking item.

**Revisit.** Before Phase 11 cohort 1, unconditionally.

---

## Open — must be decided before their phase

### ~~D-001 — Backend runtime~~ → **Resolved by ADR-010** (Hono, deploy to Workers, stay portable)

### ~~D-002 — Embedding provider~~ → **Resolved by ADR-009** (Cloudflare Workers AI `bge-base-en-v1.5`, 768-dim)

### D-003 — Auth provider
**Blocks P5-T02**

Supabase Auth is the default (free, integrates with RLS). Alternative: our own sessions on top of the database. *Leaning:* Supabase Auth — but note that bot channels bypass it entirely ([12](../docs/12-security.md) § 3), so the service layer must authorize regardless. **Not blocking until Phase 5; decide then with real usage in view.**

### D-004 — Mature content
**Blocks nothing before Phase 13 · Do not decide early**

Full analysis in [13](../docs/13-moderation-and-policy.md) § 4. Enabling it changes payments, app stores, advertising, moderation cost, legal exposure and brand. Defer until after the first revenue milestone, when there is data on whether it is actually needed.

### D-005 — Platform minimum age: 13+ or 18+
**Blocks Phase 13**

18+ removes an entire class of compliance obligation and simplifies every downstream policy decision. 13+ keeps a larger addressable market for what is fundamentally a storytelling product. Interacts with D-004. Decide before launch; record the reasoning.

### D-006 — Brand name
**Blocks P13**

"Dark Forest" has notable prior associations, including a well-known existing game and the dark-forest hypothesis from *The Three-Body Problem*. Requires a trademark search in the relevant classes, a domain check (renewal price, not first-year), social handle availability and a search-dilution assessment ([00](../docs/00-product-identity.md) § 9).

The internal codename stays `darkforest` regardless of the outcome. **Do not buy a domain before this is decided.**

---

## Rejected

### R-001 — Multi-account rotation to expand free quotas
**Rejected 2026-09-03.** Violates provider terms, cannot be handed to a partner or acquirer, and collapses the moment terms are enforced. The correct response to quota limits is better routing and honest limits ([01](../docs/01-principles-and-constraints.md) § B3).

### R-002 — Neo4j for the relationship graph
**Rejected 2026-09-03.** Relationship queries are shallow (one or two hops) and fit relational tables comfortably. A second datastore doubles operational surface for no measured benefit. Revisit only if genuine multi-hop social reasoning becomes a product requirement.

### R-003 — Running inference inside Cloudflare Workers AI as the foundation
**Rejected 2026-09-03.** The free neuron allocation is small and some capable models require a paid plan. Viable as an *optional* provider in the chain — particularly for embeddings — but not as the foundation of the model strategy.

### R-004 — Buying a domain during development
**Rejected 2026-09-03.** The brand is a Phase 13 decision ([00](../docs/00-product-identity.md) § 9). A domain bought in month one is a domain renewed for a product that has since changed its name. Free deployment URLs are sufficient through the private beta.
