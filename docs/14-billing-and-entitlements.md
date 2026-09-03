# 14 — Billing & Entitlements

> Monetize compute, never memory.
> **Status:** Authoritative for architecture. All prices and limits are placeholders until Phase 12 measures real usage.

---

## 1. The entitlement principle

Application code never asks *"is this user on Pro?"* It asks *"may this user do this?"*

```ts
// ❌ Wrong — scatters plan knowledge across the codebase.
if (user.plan === 'pro') { allowDeepTier(); }

// ✅ Right — one place knows what plans mean.
if (await entitlements.can(userId, 'ai.tier.deep')) { allowDeepTier(); }
if (await entitlements.limit(userId, 'world.max_characters') > count) { /* … */ }
```

Why this matters more than it looks: plans will change several times. Adding a tier, running an experiment, granting a beta user extra capacity, or compensating someone for an outage should each be a data change, not a deploy.

## 2. Entitlement schema

Stored as `plans.entitlements` jsonb, resolved and cached per request.

```jsonc
{
  "ai.tier.fast":            true,
  "ai.tier.standard":        true,
  "ai.tier.deep":            false,
  "ai.deep_per_day":         3,

  "compute.units_per_day":   100,
  "compute.burst_multiplier": 1.5,

  "world.max_worlds":        3,
  "world.max_characters":    8,
  "world.max_responders":    3,
  "world.max_memories":      2000,

  "memory.persistent":       true,     // TRUE ON EVERY PLAN, ALWAYS
  "memory.notebook":         true,
  "memory.pin_limit":        20,
  "memory.consolidation":    true,

  "channel.web":             true,
  "channel.telegram":        true,
  "channel.whatsapp":        false,
  "channel.group_play":      false,

  "feature.story_export":    false,
  "feature.image_gen":       false,
  "feature.voice":           false,
  "feature.publish":         false,
  "feature.priority_queue":  false,
  "feature.turn_trace":      true,

  "support.tier":            "community"
}
```

`memory.persistent: true` on every plan is a **structural commitment** ([01](01-principles-and-constraints.md) § B4). It is not a config value to be reconsidered under revenue pressure.

### Resolution

```
effective = defaults
          ⊕ plan.entitlements
          ⊕ user_overrides        (beta grants, compensation, staff)
          ⊕ temporary_grants      (promo, trial, with expiry)
```

Cached in KV for 60 s, invalidated on subscription change. A stale entitlement for one minute is acceptable; a database round-trip on every turn is not.

## 3. Compute units

One internal currency covering every variable cost. Users see human-readable limits; the ledger counts CUs.

| Operation | CU | Notes |
|---|---|---|
| Fast-tier generation | 1 | classify, extract, plan, reaction |
| Standard-tier generation | 3 | the default dialogue path |
| Deep-tier generation | 10 | |
| Each additional responder | +1× that tier | a 3-responder standard turn = 9 CU |
| Memory extraction | 1 | deferred, still charged |
| Consolidation run | 5 | amortized; charged to the world owner |
| World generation | 12 | |
| Character generation | 8 | |
| Embedding batch (≤32) | 0.2 | |
| Image generation | 25 | separate meter |
| Voice synthesis (per 30 s) | 5 | separate meter |

### Why an abstraction rather than tokens

1. **Provider independence.** Costs change; the internal currency does not.
2. **Free endpoints have no price but a real scarcity cost** — quota. CUs price scarcity, not just money.
3. **Users understand budgets better than tokens.** Nobody has an intuition for what 40,000 tokens is.
4. **Repricing is a config change.** If deep-tier inference becomes cheap, its CU cost drops without touching plans.

### Admission control

```
1. estimate_cu(taskClass, tier, responderCount)
2. atomic reserve:
     UPDATE usage_ledger SET amount = amount + $cu
     WHERE user_id=$u AND usage_date=$d AND meter='compute_units'
       AND amount + $cu <= $limit
     RETURNING amount
3. no row returned → over budget:
     a. downgrade tier and re-estimate
     b. reduce responder count to 1 and re-estimate
     c. still over → QUOTA_EXCEEDED, zero tokens spent
4. proceed
5. deferred reconciliation: adjust for actual tokens
```

Steps 3a and 3b matter more than they look. **Degrade before refusing.** A user who gets a shorter, single-character reply at the end of their day still had a session; a user who gets a wall stops coming back.

## 4. Plans

> Every number below is a **placeholder** pending Phase 12 measurement. They are stored in the `plans` table, not in code.

### EXPLORER — Free

```
✓ Persistent memory, relationships, world state, timeline    ← never removed
✓ Memory notebook: view, pin, edit, delete
✓ 3 worlds · 8 characters/world · up to 3 responders/turn
✓ Web + Telegram
✓ ~30–40 turns/day (100 CU)
✓ 3 deep-tier generations/day
✗ WhatsApp · publishing · export · images · voice · group play
```

The free tier must deliver the **whole experience at small scale**, not a crippled version. Its purpose is to answer the only question that matters: do people come back? A free tier that cannot demonstrate persistence teaches us nothing.

### CREATOR — ₹299/month

```
✓ Everything in Explorer
✓ 15 worlds · 25 characters/world · 4 responders/turn
✓ ~10× the daily budget (1,000 CU)
✓ Full deep-tier access
✓ Story export · publishing · image credits
✓ Priority generation queue
```

### PRO — ₹699/month

```
✓ Everything in Creator
✓ Unlimited worlds · 43+ characters/world · 6 responders/turn
✓ ~50× budget (5,000 CU)
✓ WhatsApp · group play · voice · advanced memory controls
✓ Early access to experimental features
```

### Pricing discipline

- **Never advertise "unlimited"** for anything with a marginal cost ([01](01-principles-and-constraints.md) § B5). "Unlimited worlds" is fine — a world row costs nothing. "Unlimited messages" is not.
- Limits are stated in human units in the UI ("about 40 messages a day"), CUs in the ledger.
- Show remaining budget **before** it runs out — a progress indicator at 80%, a warning at 95%.
- Overage: **never charge automatically.** Offer a top-up or a wait. Surprise charges destroy trust faster than any limit.
- Price changes never apply to existing subscribers mid-period, and are announced with a full period's notice.

## 5. Payments

Deferred to Phase 14. Requirements when built:

| Requirement | Detail |
|---|---|
| Provider | Must support Indian cards, UPI and international cards; must permit our content category |
| PCI scope | Zero. Hosted checkout only. Card data never touches our infrastructure. |
| Webhooks | Signature-verified, event-id idempotent, replay-safe |
| Subscription state | Provider is authoritative; our table is a cache reconciled by a daily job |
| Failed payment | Grace period, then downgrade to free — **never delete data.** A lapsed subscriber must find their worlds intact. |
| Refunds | Clear policy, honoured without argument for the first request |
| Taxes | GST handling; invoices with the required fields |
| Cancellation | Self-serve, one click, effective at period end, no retention dark patterns |

## 6. Usage ledger

`usage_ledger` is the append-and-increment record of every metered operation, by user, by day, by meter.

Purposes: enforcement, per-user cost analysis, plan-limit calibration, abuse detection, and the margin math in [17](17-monetization-and-unit-economics.md).

Retained for 13 months (financial records), then aggregated and the detail purged. `user_id` is nulled on account deletion, preserving aggregates without personal data.

## 7. The free-tier economics guard

The existential risk is free users generating uncapped inference cost. Five defences, layered:

```
1. Daily CU cap                     hard, per user
2. Platform-wide daily CU ceiling   hard, protects against a coordinated spike
3. Free tier routed to free models  by default; deep tier is quota'd separately
4. Degradation before refusal       downgrade tier, reduce responders
5. Kill switch                      one flag, tested, halts non-essential inference
```

And one accounting rule: **the free tier's total inference cost must never exceed a fixed monthly ceiling.** Set it explicitly (e.g. ₹0 while on free endpoints; a named number once paid inference enters the chain), monitor it daily, and treat approaching it as a product problem — tighten limits, improve routing, or convert more users — never as an acceptable overrun.

## 8. Interface

```ts
interface EntitlementService {
  can(userId: string, key: string): Promise<boolean>;
  limit(userId: string, key: string): Promise<number>;
  all(userId: string): Promise<Entitlements>;      // cached 60s
  grant(userId: string, key: string, value: unknown, expiresAt?: Date): Promise<void>;
}

interface UsageService {
  estimate(op: MeteredOperation): number;
  reserve(userId: string, cu: number): Promise<ReservationResult>;  // atomic
  reconcile(reservationId: string, actualCu: number): Promise<void>;
  today(userId: string): Promise<UsageSnapshot>;
  remaining(userId: string, meter: string): Promise<number>;
}
```

## 9. Failure modes

| Failure | Response |
|---|---|
| Entitlement service unavailable | **Fail closed to the free tier**, never open. A brief downgrade is recoverable; unmetered inference is not. |
| Reservation succeeds, generation fails | Deferred reconciliation refunds the reservation. Reconciliation must be idempotent. |
| Payment webhook missed | Daily reconciliation job compares provider state to ours and repairs drift |
| User at limit mid-conversation | Degrade (§ 3 step 3), then explain clearly with the reset time and an upgrade path |
| Subscription expires | Downgrade entitlements. Worlds and memories are **never** deleted. Over-limit worlds become read-only, not destroyed. |
| Double-charge | Refund immediately, no argument, then investigate |
| CU costs drift from reality | Monthly review of estimated vs actual cost per operation; adjust the table |
