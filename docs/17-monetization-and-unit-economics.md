# 17 — Monetization & Unit Economics

> The business question is not "can we get users?" It is "does a user cost less than they pay?"
> **Status:** Authoritative for method. Every number is a placeholder until Phase 12 supplies measurements.

---

## 1. The core equation

```
Gross Margin = Revenue
             − AI inference
             − infrastructure
             − payment processing
             − storage & bandwidth
             − variable support cost
```

For an AI product, **inference dominates**. Everything else is rounding error until significant scale. Therefore the entire economic strategy reduces to one sentence:

> Reduce the number and cost of inference calls per unit of user value.

## 2. The cost drivers, ranked

| Driver | Impact | Lever |
|---|---|---|
| **Responders per turn** | Linear multiplier on every turn | Orchestrator threshold ([07](07-multi-character-orchestration.md)). Target 1.6 avg. |
| **Tier distribution** | Deep is ~10× fast | Route by task class; deep is opt-in and quota'd |
| **Context size** | Linear in input tokens | Budget discipline ([09](09-context-builder-and-prompts.md)); avoid dumping |
| **Turns per user per day** | Linear | Plan limits |
| **Background jobs** | Extraction, consolidation, embedding | Selectivity, batching, deferral |
| **Retries and fallbacks** | Wasted spend | Pre-emptive rate-limit skipping; circuit breakers |
| **World size** | Retrieval and context cost | Character caps per tier |

The first two are worth more than the rest combined. A product averaging 1.6 responders at mostly-standard tier is a viable business; the same product averaging 3.2 responders at mostly-deep tier is not, at any plausible price.

## 3. Cost model template

Fill in from Phase 12 measurements. Recompute whenever the model chain changes.

```
PER TURN (1 responder, standard tier)
  input tokens          ~____        (target ≤ 9,000)
  output tokens         ~____        (target ≤ 400)
  extraction (amortized) ~____       (1 per ~3 turns)
  embedding (amortized)  ~____
  moderation             ~____
  ─────────────────────────────
  cost per turn          ₹____       (₹0 while on free endpoints)
  compute units          4

PER ACTIVE USER PER DAY
  turns/day             ~____        (measure — do not assume)
  cost/day              ₹____
  cost/month            ₹____

PER PLAN
  Free    limit 100 CU/day  → max ₹____/month/user
  Creator limit 1,000 CU/day → max ₹____   vs ₹299 revenue → margin ____%
  Pro     limit 5,000 CU/day → max ₹____   vs ₹699 revenue → margin ____%
```

### The two numbers that decide the business

1. **Cost per active free user per month.** Multiply by expected free users. That is the subsidy the business must carry.
2. **Worst-case cost per paying user per month** — a subscriber who uses their entire daily limit every day. If that exceeds the subscription price, the plan is mispriced. Design so that a max-usage subscriber still leaves ≥ 40% gross margin.

Most usage sits far below the cap, so realistic margin will be much better — but the plan must survive the worst case, because heavy users self-select into paid tiers.

## 4. Free-tier subsidy control

```
Free tier monthly cost ceiling: ₹______   ← set explicitly, monitor daily
```

While on free endpoints this is ₹0 and the binding constraint is **quota**, not money. That does not make it free — an exhausted quota is an outage. Track quota headroom with the same seriousness as rupees.

When paid inference enters the chain, approaching the ceiling triggers, in order:

1. Improve routing efficiency (cheaper wins first)
2. Reduce free-tier daily limits
3. Improve conversion so paid users cover more of the subsidy
4. Only then: reduce free-tier capability

**Never:** cover the overrun personally ([01](01-principles-and-constraints.md) § B6).

## 5. Pricing philosophy

**What is charged for:** volume, complexity, model tier, world size, responder count, media generation, priority, creator tooling.

**What is never charged for:** memory persistence, relationship tracking, world state, timeline, basic quests. These are the product's identity ([00](00-product-identity.md)).

**Anchoring:** the free tier must be genuinely usable — enough for a real, ongoing world at modest volume. A free tier that cannot demonstrate persistence teaches us nothing about retention, which is the only thing we are trying to learn before Phase 13.

**Conversion trigger:** users should upgrade because they hit a *volume or ambition* limit in a world they care about, never because a core capability was withheld. "I want more characters in this world" is a healthy upgrade. "I want my characters to remember" is a broken product.

## 6. Product metrics

North star: **Returning World Sessions** ([00](00-product-identity.md) § 11).

| Metric | Why | Target at beta |
|---|---|---|
| D1 retention | Did the first session land | > 40% |
| **D7 same-world return** | **Does persistence matter** | **> 25%** |
| D30 retention | Does it last | > 15% |
| Sessions per world | Depth of engagement | > 5 |
| Median world age at 30 days | Are worlds surviving | > 14 days |
| Turns per session | Session depth | 15–30 |
| Worlds per user | Breadth vs depth | 1.5–3 |
| Characters per world | Is multi-character used | > 3 |
| Memory recall accuracy | Does the core work | > 85% |
| Free → paid | Willingness to pay | > 3% |
| Avg responders/turn | **Margin health** | ≈ 1.6 |
| CU per active user/day | **Cost health** | trending down |

**D7 same-world return is the whole thesis.** If it is low while overall retention is fine, users like the chat but not the world — and the product should become something else. That is a finding worth knowing at 50 users rather than 50,000.

## 7. Financial milestones

Deliberately small and sequential. Each answers one question.

| Milestone | Question answered |
|---|---|
| **1 paying user** | Will anyone pay at all? |
| **10 paying users** | Is it repeatable, or was it a friend? |
| **₹10,000 MRR** | Does revenue exceed inference cost? → **positive variable economics** |
| **₹50,000 MRR** | Can the business fund its own growth? |
| **₹1,00,000 MRR** | Is full-time work on this defensible? |
| **₹3,00,000 MRR** | Can it support a second person? |

Do not skip. Each milestone teaches something the next depends on, and optimizing for ₹1L MRR before reaching ₹10k means optimizing on guesses.

### The first revenue rule

When the first subscription arrives, **do not spend it on features.** Use it to answer one question: does this user's revenue exceed their inference cost? If yes, variable economics are positive and scale is a growth problem. If no, no amount of growth fixes it — the model must change first.

## 8. Reinvestment order

```
Revenue
   ↓
1. Infrastructure reliability     (keeping what exists working)
   ↓
2. Product                        (what makes users stay)
   ↓
3. Marketing                      (only once retention is proven)
   ↓
4. Inference capacity             (better models for paying users)
   ↓
5. Founder compensation           (last, and only when sustainable)
```

Marketing before retention is proven is the most common and most expensive mistake available here. It buys users who churn, and it teaches you nothing except that acquisition is possible.

## 9. Self-hosting: when, and only when

**Do not buy a GPU. Do not rent one yet.** Independence is an emotional preference, not a financial argument.

### Trigger conditions — all must hold

```
[ ] Monthly paid inference spend > ₹40,000
[ ] Sustained utilization would exceed 40% of a rented GPU's capacity
[ ] Quality requirements are met by a self-hostable open model (measured on our eval suite)
[ ] Rented-GPU cost < 60% of current API cost at the same quality
[ ] Engineering time to operate it is available and costed honestly
[ ] Revenue is stable for 3+ consecutive months
```

### Progression

```
Free endpoints          →  now
Paid API (revenue-funded) →  as free tiers prove insufficient
Rented cloud GPU + vLLM   →  when the triggers above hold
Dedicated/owned GPUs      →  only at sustained high utilization
```

### The honest cost of self-hosting

API cost is not the comparison. The real comparison includes: GPU rental, storage, bandwidth, idle capacity (the big one — you pay for 24 hours and use 6), model updates, monitoring, on-call, and the engineering time not spent on the product.

A solo founder's time is the scarcest input. Self-hosting to save ₹20,000/month while consuming 30 hours/month is usually a bad trade.

## 10. Creator economy *(Phase 15/20)*

```
Creator publishes a world
        ↓
Users discover and play
        ↓
Popular worlds drive signups
        ↓
Creators are motivated to make more
        ↓
Catalogue depth becomes a moat
```

Marketplace commission: illustrative 20% platform / 80% creator. Set only after payout mechanics, tax handling and refund policy are worked out — a payout system built badly is worse than no marketplace, because it creates obligations to people outside the company.

**Sequencing:** free publishing (Phase 15) long before paid selling (Phase 20). Prove that creators want to publish and that players want to play published worlds before building a payments system for them.

## 11. The moat

Not the model, the UI, the domain, or being first.

```
Memory engine quality
  + world-state integrity
  + relationship dynamics
  + knowledge isolation
  + multi-character orchestration
  ─────────────────────────────────
  = an experience that is hard to copy quickly

  + accumulated worlds, characters, campaigns, creators, and
    months of a user's own history
  ─────────────────────────────────
  = switching cost that grows with time
```

A competitor can copy the interface in a week. They cannot copy a user's 200-day-old world, and the user cannot take it with them. **That is the moat, and it only exists if persistence genuinely works** — which is why the memory engine gets the disproportionate share of engineering attention in every phase.
