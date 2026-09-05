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

### ADR-020 — Groq's 8,000-token per-request ceiling makes `compact` mandatory
**2026-09-03 · Accepted · Constrains [09](../docs/09-context-builder-and-prompts.md) § 2, promotes ADR-012 from optimisation to requirement**

**Context.** Header semantics were established empirically, because the first
capacity script mislabelled them and reported ~100× the real figure:

```
x-ratelimit-limit-requests: 1000   requests per DAY   (reset ≈ 86.4 s/request)
x-ratelimit-limit-tokens:   8000   tokens per MINUTE  (reset ≈ 0.45 ms/token)
```

Then the finding that matters. TPM is not only a rate — it is a hard ceiling on a
**single request**. Sending ~10K tokens returns:

> `Request too large for model openai/gpt-oss-120b … on tokens per minute (TPM): Limit 8000, Requested 8147, please reduce your message size`

Note it compares against the **limit**, not the remaining bucket. Waiting does
not help; the request is simply impossible on this tier.

**Decision.**

1. **`compact` (~5.6K in + 600 out) is the only profile that runs on Groq.**
   ADR-012 introduced it as an economic lever; it is now a hard requirement for
   our primary provider.
2. **`full` (~11.3K in) cannot use Groq at all.** It routes to OpenRouter, whose
   Nemotron endpoints carry 1M context with no per-request ceiling.
3. **The `deep` tier must route to OpenRouter**, not to a larger Groq model.
   There is no larger Groq model available to us — the ceiling is per-tier, not
   per-model, and every dialogue model reports the same 8000.
4. The context builder **validates against the selected model's ceiling before
   the call** and drops by priority to fit. A request rejected for size is a
   wasted round trip against a 1000/day budget.

**Rationale.** Discovering this at Phase 9 — when the UI assumes a rich context —
would have meant rebuilding the context builder. Discovering it now costs a
constant.

**Trade-off.** Free-tier quality is bounded by what fits in ~5.6K tokens: about
6 memories, 6 transcript messages, no conversation summary, no recent events.
That is a real quality ceiling on the free tier and it must be measured
separately in eval suite 3 rather than assumed equivalent to `full`.

**The upside worth noting.** The daily ceiling turns out to be REQUEST-bound
(1000/model/credential), not token-bound. Across 4 credentials × 4 dialogue
models that is **16,000 generations/day ≈ 8,200 turns/day** — far more than the
~70/day the earlier (wrong) 200K-tokens/day assumption implied.

**Revisit.** If Groq's free tier changes, or if a paid tier is adopted — Dev Tier
raises the ceiling and would make `full` viable on Groq.

---

### ADR-021 — Capacity-aware multi-provider scheduler
**2026-09-04 · Accepted · Refines ADR-017 and ADR-019**

**Context.** Routing thought in terms of `provider -> credential`, with Groq
primary and everything else fallback. Two problems, one measured and one
structural.

**Measured.** Groq meters rate limits PER MODEL. Four models called on the SAME
credential each returned `x-ratelimit-remaining-requests: 999/1000`; a shared
budget would have shown 996 by the fourth call and monotonically falling tokens.
Metering Groq as one bucket per credential therefore used **25% of its real
capacity** — 8 credentials x 4 models is 32 independent buckets, modelled as 8.

A fabricated limit compounded it: `tpd: 200_000` was declared for Groq, but Groq
exposes no tokens-per-day header. An imaginary ceiling throttling real capacity.

**Structural.** Fallback-only routing leaves other providers idle until the
primary is exhausted, then hands them a thundering herd. This was not
theoretical: Suite 1 run 3 scored **70% recall against 91% and 84%** for runs 1
and 2, with six rate-limit retries and Groq down to 2/8 credentials. Capacity
pressure was measurably degrading MEMORY RECALL — the benchmark was partly
measuring the rate limiter.

**Decision.** Capacity is keyed `provider -> model -> credential -> bucket`, and
independent requests are distributed across all eligible buckets rather than
funnelled through one provider.

Per-model bucketing is opt-in per provider and must be VERIFIED, never assumed:

  groq        perModelLimits  verified independent, 4 models
  gemini      perModelLimits  per model per project (dev-only)
  openrouter  account-wide    50/day shared across all :free endpoints
  nvidia      account-wide    no verified per-model limits published
  cloudflare  account-wide    neuron budget is account-scoped

Getting this backwards in either direction is a bug. Under-splitting wastes real
capacity (the Groq case). Over-splitting INVENTS capacity that does not exist,
which is worse — it produces confident 429s.

**Selection.** Eligibility (terms, pool, benchmarking) is settled first,
capability second, capacity third. A model we may not legally use never enters a
capacity comparison. Among survivors, score is dominated by fractional headroom;
quality is a tiebreak, because an idle lesser model beats a saturated better one
— a request that cannot run has no quality at all.

**What this is NOT.** It does not fan one request out to several providers. That
would multiply cost for a single answer. It distributes INDEPENDENT requests
across INDEPENDENT capacity.

**Safety unchanged.** `checkPoolEligibility` is untouched. NVIDIA remains
development-only on contractual grounds (ADR-013), Gemini on privacy grounds
(ADR-009), and both fail closed without an explicit synthetic-content flag in a
local environment. Verified live: dev-only buckets are refused in production and
refused without the flag.

**Trade-off.** More moving parts, and a per-provider metering claim that must be
re-verified when terms change. The verification procedure is recorded next to
the flag so it can be repeated rather than trusted.

**Measured result.** 8 buckets -> 49. Groq 4x. Smoke test 7/7: distribution
across 12 distinct buckets, onward routing when Groq is exhausted, development
pool available, production boundary intact.

**Revisit.** Monthly with X-06, and whenever a provider changes its rate-limit
documentation.

---

### ADR-022 - Measured competence is a capability, checked before capacity
**2026-09-04 . Accepted . Refines ADR-021**

**Context.** Wiring Suite 1 through the ADR-021 scheduler removed the capacity
bottleneck exactly as intended - 36 buckets carried load, 3 reroutes, Groq
finished at 32/32 available with 90% headroom. Recall nevertheless FELL, from a
median of 84% to 67%, with 19 extraction batches dropped.

**What happened.** The scheduler spread extraction across all four Groq dialogue
models. All four DECLARE `supportsStructuredOutput`. Measured on the real
extraction prompt, 15 attempts each, the declaration held very unevenly:

  gpt-oss-20b   17 memories stored, 0 dropped
  gpt-oss-120b  15 memories stored, 0 dropped
  qwen3.8-27b   12 memories stored
  qwen3.6-27b   verbose enough to exhaust its own TPM mid-probe

34 of 62 extractions went to qwen3.8.

**The mechanism, which is the part worth remembering.** A model that emits almost
nothing also consumes almost no tokens. Consuming no tokens leaves it the most
headroom. Headroom dominates the score at 0.55. So the weakest model looked like
the one with the most capacity, and the scheduler kept selecting it.

**Failing cheaply is indistinguishable from having capacity**, and the feedback
loop runs the wrong way: the worse a model performs, the more attractive it
becomes. No adjustment of the weights fixes that. Lowering `qualityScore` for
qwen would only slow the loop down, because quality is a tiebreak and headroom
is not.

**Decision.** Competence is a CAPABILITY, not a score. `ModelDescriptor` gains
`verifiedTaskClasses` - the task classes a model has been MEASURED to handle.
The scheduler rejects a model that declares the field without the requested task
before any capacity comparison, reusing ADR-021 ordering: eligibility, then
capability, then capacity. Absent means unrestricted, because absence of a
measurement is not evidence of incompetence.

**The uncomfortable part.** This constraint was already known. `groq.ts` carried
the comment "qwen models ... failed JSON-mode validation in testing, so they are
not used for structured-output task classes." It was accurate, it was in the
right file, and it changed nothing, because the previous wiring happened to pin
one model and never exercised the case. **Prose does not route traffic.** A
constraint that lives only in a comment is not a constraint; it is a note about
one that ought to exist.

**Trade-off.** Extraction now draws on 16 buckets rather than 32, halving its
capacity ceiling - comfortably above the ~65 extraction calls a Suite 1 run
makes. Every new provider needs probing before its models can take structured
work, and the probe costs real calls. Worth it: an unverified model silently
dropping memories is the most expensive failure this system has.

**Revisit.** When a provider is added, or when a model structured-output
behaviour changes. `pnpm exec tsx packages/evals/src/extraction-probe.ts` is the
measurement.

---

### ADR-023 - A benchmark that cannot produce a valid number must refuse to produce one
**2026-09-04 . Accepted**

**Context.** Two full Suite 1 runs reported 67% recall. Both were measured with
NO embeddings: the Cloudflare token had been revoked, and all 12 embedding calls
in a subsequent isolated test returned 401. Retrieval degraded silently to
text-only search, the suite completed, and it printed a recall figure.

**Decision.** Suite 1 preflights the embedding provider and ABORTS if it cannot
embed. It does not warn, degrade, or annotate the result.

**Rationale.** A benchmark failure mode must not be a plausible number. The
number was in exactly the range where it would have been believed - low enough
to look like a real regression, high enough not to look broken - and it arrived
in the same session as a routing change, which is precisely when a false signal
does the most damage. Two hours were nearly spent tuning retrieval against a
dead credential.

This generalises past the embedder: any dependency whose absence changes what is
being measured, rather than whether it can be measured, belongs in the preflight.

**Trade-off.** The suite cannot run at all when embeddings are down, including
for work unrelated to retrieval. That is the intended cost.

**Revisit.** Never for the principle. The list of preflighted dependencies grows.

---

### ADR-024 - The vector query and the keyword query are not the same query
**2026-09-05 . Accepted**

**Context.** With capacity healthy, extraction competent and embeddings live,
Suite 1 still scored 47% median. The failures were not where anyone assumed.

Adding one diagnostic - does the expected fact exist in the STORE, as opposed to
in the RETRIEVED set - split 43 failed probes into 31 stored-but-not-retrieved
and 3 never stored. Extraction was fine. Retrieval was losing the memories.

The decisive measurement probed the SAME 38-memory store two ways:

  mid-session, recentLines populated    3/19 recalled
  fresh session, recentLines empty      4/5  recalled

And when a fact did surface it ranked first. So ranking was not subtly wrong;
the memory was absent from the candidate set entirely.

**Cause.** `buildQuery` widened the query with the last two lines of dialogue and
handed that single blob to BOTH search paths. For the keyword path that is
harmless and helpful. For the vector path it is fatal: an embedding is one
averaged point, so appending two lines of narrative prose to a short question
drags the point away from the question and towards whatever was recently said.
Retrieval returned what was topically recent instead of what was asked.

The widening itself was correct and necessary - a reply of "yes" retrieves
nothing on its own. The error was applying one query to two paths that fail in
opposite directions.

**Decision.** `buildQuery` returns `text` and `vectorText`. The keyword path
keeps the widened text. The vector path gets the user message alone whenever it
carries at least two content words, plus any extracted entity names, which are
high signal and cost one token each. Below that threshold the message cannot
retrieve on its own and the widened text is used.

Two content words, not three: "What did I promise Odell?" reduces to
{promise, odell}, and a threshold of three would have widened a perfectly
specific question. Reply-shaped turns score zero.

**Measured.** Same fixture, same store, one repetition:

  recall@k                 21% -> 84%
  stored-but-not-retrieved  31 -> 4
  memories stored           38 -> 53
  reroutes                  11 -> 0

**Trade-off.** Two queries means two things to keep consistent, and the
content-word threshold is a heuristic that will need revisiting for languages
with different function-word density. A stopword list in retrieval is a small
piece of English-specific logic in an otherwise language-neutral path.

**What this cost.** Three benchmark generations were read as memory-quality
results before this was found: 91/84/70 (capacity-starved), 67/67 (no
embeddings), 65/47/40 (this bug). The lesson is not about retrieval - it is that
`recalled: false` was ambiguous between two failures with opposite fixes, and
nobody could tell which until the store was inspected directly. Instrument the
FORK, not just the outcome.

**Revisit.** If a non-English world is supported, or if the vector path is ever
given a reranker that could tolerate a diluted query.

---

### ADR-026 - The evaluation contract is frozen and independently tested
**2026-09-05 . Accepted**

**Context.** Four consecutive measurement bugs, each living in the
instrumentation written to validate the previous change, each UNDER-reporting a
working system:

  1. recall@k conflated with answer accuracy   Ravenhold read 0%, was 100%
  2. validity divided by responses that PARSED 66 failures read 100%
  3. a correct empty extraction scored as fail 85% capture read 15%
  4. the matcher never read `quantity`         a perfect event read MISSED

The failure mode is not a benchmark that breaks. It is a benchmark that reports
a PLAUSIBLE wrong number, in the range where it gets believed and acted on. Bug
3 sent an entire investigation toward "extraction is broken" when extraction was
at 85%. Bug 1 nearly caused retrieval to be rewritten.

There is also a compounding risk: change architecture, benchmark says bad, fix
benchmark, benchmark says better, find benchmark bug, fix benchmark. At some
point the measurement system is what is being optimised.

**Decision.** Every definition a benchmark result depends on lives in one module,
`packages/evals/src/contract/evaluation-contract.ts`, which imports TYPES ONLY.
It cannot reference the extraction, retrieval or projection code it judges, so
the evaluator cannot drift toward the implementation it is meant to check.

Frozen definitions: planted fact, correct extraction, correct EMPTY extraction,
malformed extraction, the matching rule (including numbers in digit and word
form), extraction health, fact capture, recall@k.

Each of the four historical bugs has a regression test that fails against the
code that shipped it. 13 tests.

Two rules follow. Harnesses use the contract's matcher and no local one - every
local matcher so far grew a false negative. And changing anything in the contract
invalidates comparison with earlier runs, which is the point: a definition change
must be as visible as an architecture change.

**What the contract explicitly does NOT measure**, recorded so nobody infers
otherwise: semantic correctness (the matcher is a substring proxy and an
inverted fact can pass - there is a test asserting this); associative recall
(every Suite 1 fact is typed, so a structured store answers by lookup, which
makes Suite 1 a test of EXTRACTION once structured resolution is in play);
production concurrency.

**Trade-off.** Comparisons across a contract version boundary are invalid, and
the frozen matcher is cruder than a judge would be. Both are accepted: a crude
measure that cannot silently change beats a sophisticated one that can.

**Revisit.** Only with a version bump and a restated baseline.

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
