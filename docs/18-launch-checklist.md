# 18 — Launch Checklist

> Everything that must be true before the public URL is live.
> **Status:** Authoritative. This is a **gate**, not a guideline. An unticked box blocks launch.

---

## Gate A — Private beta entry (Phase 11)

Smaller gate, but real. Fifty strangers can still be harmed by a broken product.

**Product**
- [ ] Full journey works: signup → world → characters → chat → memory → return next day
- [ ] Multi-character responses correct and distinguishable
- [ ] Memory recall demonstrably works over ≥ 5 sessions
- [ ] Relationships move sensibly and are visible in the UI
- [ ] Mobile web is usable (not merely non-broken)
- [ ] Errors produce human messages, never stack traces

**Technical**
- [ ] All test suites pass
- [ ] Eval suites 1, 3, 4, 5, 6 above threshold; **suite 4 leak rate = 0**
- [ ] Provider chaos suite (7) passes
- [ ] Rate limits and compute admission enforced
- [ ] Backups verified — **a restore has actually been performed**, not just configured
- [ ] Rollback tested end to end
- [ ] Kill switch tested

**Safety**
- [ ] Moderation pipeline live on all screened surfaces
- [ ] § 2 prohibited-category blocks verified with adversarial attempts
- [ ] Self-harm resource flow implemented and reviewed
- [ ] Reporting works and reaches a queue that is actually read

**Legal & privacy**
- [ ] Terms of Service published
- [ ] Privacy Policy published, accurate about providers and retention
- [ ] Account deletion works and is verified in the database
- [ ] Data export works
- [ ] No message content in any log sink (verified by inspection)

**Operational**
- [ ] P1/P2 alerts configured and delivering to a device you carry
- [ ] Admin dashboard usable
- [ ] Runbooks R-01 … R-08 written
- [ ] Support channel exists and is monitored
- [ ] Cost monitoring live with anomaly alerts

---

## Gate B — Public launch (Phase 13)

### 1. Security ([12](12-security.md) § 9)

Every box in that checklist. No exceptions, no "we'll do it next week." Copy the results here with dates.

- [ ] Full security checklist complete, dated, signed off

### 1b. Credential pooling decision (ADR-019) — **blocking**

Development runs on pooled free credentials across multiple accounts per provider. That was an explicit, recorded decision for *development* traffic, which every provider's terms permit. Serving **real users** from pooled free accounts is a separate question and was deliberately deferred to this point.

- [ ] Decide: pooled free credentials in production, or one credential per provider plus paid capacity
- [ ] Re-read each provider's terms specifically on multiple-account use
- [ ] Privacy policy rewritten and accurate about which providers see user content
- [ ] If pooling stays: accept in writing that correlated enforcement can remove the entire pool at once, and have a tested fallback for losing Groq specifically
- [ ] Verify `checkPoolEligibility()` still blocks Gemini and NVIDIA in the production environment

### 2. Ownership migration ([12](12-security.md) § 11)

- [ ] Domain registered to the company, privacy on, auto-renew, transfer lock
- [ ] Cloudflare, Supabase, GitHub, provider and payment accounts company-owned
- [ ] 2FA on every account; recovery codes stored offline in two locations
- [ ] Bot tokens under company control with a documented recovery path
- [ ] Role email addresses live: `support@`, `security@`, `legal@`, `dmca@`
- [ ] Recovery does not depend on one person's phone number

### 3. Brand and domain ([00](00-product-identity.md) § 9)

- [ ] Name decided and recorded in an ADR
- [ ] Trademark conflict search completed in the relevant classes
- [ ] Prior-use collisions assessed (see the "Dark Forest" note in § 9 of doc 00)
- [ ] Domain purchased — **renewal price checked**, not just first-year
- [ ] DNS configured; email deliverability tested (SPF, DKIM, DMARC)
- [ ] Social handles secured
- [ ] Logo and favicon in place

### 4. Legal

- [ ] Terms of Service reviewed by a lawyer
- [ ] Privacy Policy reviewed by a lawyer
- [ ] Content Policy published with concrete examples
- [ ] Age policy implemented and decided (D-005)
- [ ] DMCA-equivalent notice-and-takedown process with a published address
- [ ] Refund and cancellation policy published
- [ ] Business entity registered (required before taking payments)
- [ ] GST registration and invoicing if applicable
- [ ] Provider terms reviewed and reflected accurately in our own policies

### 5. Product readiness

- [ ] Landing page communicates persistence in under 10 seconds
- [ ] The day-1 / day-30 / day-60 demo video exists and is convincing
- [ ] Onboarding gets a new user to their first character reply in under 3 minutes
- [ ] Empty states are helpful, not blank
- [ ] Every error message tells the user what to do next
- [ ] Loading states everywhere; no dead-looking screens during a 6-second turn
- [ ] Mobile web tested on real devices, not just a browser emulator
- [ ] Accessibility: keyboard navigation, contrast, screen-reader labels on interactive elements

### 6. Scale readiness

- [ ] Load tested at 10× expected launch traffic
- [ ] Free-tier platform limits verified **again** ([01](01-principles-and-constraints.md) § Part C — they change)
- [ ] Storage projection for 10× users fits within limits, with the mitigation ladder ready
- [ ] Provider quota headroom sufficient, with fallback chains verified
- [ ] Platform-wide daily CU ceiling set and enforced
- [ ] Degradation ladder tested at every level
- [ ] Database connection limits understood and respected under concurrency

### 7. Business readiness

- [ ] Payment integration tested end to end, including a real refund
- [ ] Webhook signature verification and replay protection tested
- [ ] Plan limits enforced and verified by attempting to exceed each one
- [ ] Subscription lifecycle tested: signup, renewal, failure, cancel, expiry, resubscribe
- [ ] **A lapsed subscriber's worlds remain intact** — verified
- [ ] Invoicing works and contains required fields
- [ ] Cost per user measured, and margin per plan calculated

### 8. Support

- [ ] Support email monitored, with a stated response-time expectation
- [ ] FAQ covering the ten questions beta users actually asked
- [ ] Bug reporting path from inside the product
- [ ] Appeal process for moderation actions, answered by a human
- [ ] Status page or equivalent

### 9. Launch-day operations

- [ ] Deploy freeze except for hotfixes
- [ ] Monitoring watched actively for the first 48 hours
- [ ] Rollback rehearsed within the last week
- [ ] Kill switch verified working today
- [ ] Incident template pre-written
- [ ] Someone (you) is available and not travelling

---

## Post-launch: the first week

| Day | Focus |
|---|---|
| 1 | Watch errors and cost hourly. Fix only what is broken. Resist feature work. |
| 2 | Read every piece of user feedback. Categorize, do not react individually. |
| 3 | Check D1 retention. Compare against beta. |
| 4 | Review moderation queue and false-positive rate |
| 5 | Verify cost per user against projections |
| 7 | **Check D7 same-world return.** This is the number that matters most. |

### The first-week discipline

- **Do not ship features.** Fix bugs, watch numbers, talk to users.
- **Do not react to individual loud feedback.** Categorize; act on patterns.
- **Do not compare yourself to funded competitors.** Different constraints, different game.
- **Do write down everything that surprised you.** Surprises are where the real product lives.

---

## What "launched" does not mean

It does not mean the product is finished, that growth is guaranteed, or that the plan was correct. It means real strangers can now use it and tell you what is actually true — which is the only thing that ever settles the questions the specification could not.

The measure of a good launch is not signups on day one. It is whether the people who arrived in week one are still playing the same world in week five.
