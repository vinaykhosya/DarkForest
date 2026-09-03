# 13 — Moderation & Content Policy

> Moderation exists before the first stranger uses the product, not after the first incident.
> **Status:** Authoritative for engineering. The published policy text requires legal review before launch (task P13-T04).

---

## 1. Position

Dark Forest hosts fiction. Fiction includes conflict, violence, moral failure and darkness — that is what stories are made of. A platform that flinches at a villain is useless for storytelling.

The line is not "dark content." The line is content that **causes real-world harm**, that is **illegal**, or that **targets real people**.

## 2. Absolutely prohibited

No setting, plan, age gate or creative justification permits these. Detection triggers immediate block, account action and — where legally required — reporting.

| Category | Scope |
|---|---|
| **Child sexual content** | Any sexual or romantic depiction of minors, real or fictional, in any style, including characters described as adults but framed as children. **Zero tolerance, no exceptions, permanent ban.** |
| **Real-person sexual content** | Sexual content involving identifiable real people |
| **Actionable harm instructions** | Synthesis routes, weapon manufacture, functional malware, exploitation guides |
| **Credible threats** | Threats or targeted harassment against real, identifiable individuals |
| **Terrorism/extremism** | Recruitment, glorification, operational material |
| **Human trafficking / CSAM facilitation** | In any form |
| **Non-consensual intimate imagery** | Including synthetic |

### The minor-safety implementation

This gets special engineering treatment because the cost of failure is unbounded:

1. **Creation-time block.** A character whose description, age field or framing indicates a minor cannot have `romance` enabled, cannot exist in a `mature` world, and triggers review.
2. **Age inference at creation.** Age-suggestive terms in a character description flag the character; combined with romantic or sexual framing, creation is refused.
3. **Runtime block.** Any turn combining a minor-flagged character with romantic or sexual content is blocked before generation.
4. **Never regenerate around it.** Other blocks retry with a constraint; this one does not. Blocked means blocked.
5. **Escalation.** Repeat attempts → immediate suspension, human review, preservation of evidence per legal obligation.

There is no "creative exception" branch in this code path. Do not add one.

## 3. The content-rating ladder

| Rating | Permits | Availability |
|---|---|---|
| `general` | Adventure, mystery, drama, mild peril, romance without explicit content | All users |
| `teen` | Violence with consequence, mature themes, non-graphic romance | Age-confirmed users |
| `mature` | Graphic violence, explicit themes, morally complex content | **Not enabled at MVP** — decision D-004 |

MVP launches with `general` and `teen`. `mature` exists in the schema so that enabling it later is a policy change, not a migration.

## 4. Mature content — the deferred decision (D-004)

Deferred because enabling it changes the entire company:

| Dimension | Consequence of enabling |
|---|---|
| Payments | Many processors restrict or refuse adult content; the acceptable set shrinks and rates rise |
| App stores | Effectively closes the Play Store path for the Android app |
| Advertising | Closes most acquisition channels |
| Moderation cost | Rises sharply; human review becomes necessary |
| Legal | Age-verification obligations vary by jurisdiction and are tightening |
| Brand | Becomes the identity whether or not you intend it ([00](00-product-identity.md) § 8) |
| Acquirers/partners | The pool narrows considerably |

**If it is ever enabled**, all of the following must ship together — none is optional:

- [ ] Real age assurance, not a checkbox
- [ ] Strict per-world opt-in, defaulting off, never surfaced to non-opted users
- [ ] A separate payment rail confirmed to permit it
- [ ] Jurisdictional geo-restriction where required
- [ ] Enhanced moderation with human review capacity
- [ ] The minor-safety controls in § 2 hardened further
- [ ] Legal review completed and documented

The decision is deferred to **after** the first revenue milestone, when there is data on whether it is actually needed. Many users want persistence far more than they want explicitness, and we do not yet know our own mix.

## 5. The moderation pipeline

Four stages, cheapest first. Most content never reaches stage 3.

```
                    ┌─────────────────────────┐
INPUT / OUTPUT ────▶│ 0. Cache                │ sha256 → prior verdict (7d)
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ 1. Heuristics           │ blocklists, regex, minor-safety
                    │    ~0 ms, free          │ patterns → immediate block
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ 2. Classifier           │ fast, cheap, category scores
                    │    ~100 ms              │ clear allow / clear block
                    └───────────┬─────────────┘
                                ▼ (ambiguous only)
                    ┌─────────────────────────┐
                    │ 3. LLM screen           │ fast tier, context-aware
                    │    ~1 s                 │ "is this fiction or instruction?"
                    └───────────┬─────────────┘
                                ▼ (edge cases, async)
                    ┌─────────────────────────┐
                    │ 4. Human review queue   │ founder, then a team
                    └─────────────────────────┘
```

**Stage 3 is where fiction is distinguished from instruction.** A character describing a poisoning in a murder mystery is fiction. A user asking a character for a working synthesis route is instruction wearing a costume. Only a context-aware model reliably separates them, which is why the cheap stages must not over-block — a false positive on stage 1 kills a legitimate story.

### Screened surfaces

| Surface | When | Failure action |
|---|---|---|
| User message | Before generation | Block; no world mutation; no charge |
| Character output | Before display | Regenerate once with a constraint, then a safe fallback line |
| World name/description | On save | Block save with an explanation |
| Character profile | On save | Block save |
| Persona | On save | Block save |
| Published world (Phase 15) | Before listing | Hold for review |
| Report queue | On submission | Route by severity |

### Tuning target

**False positives are more damaging than false negatives** for everything except the § 2 categories, where the reverse is absolutely true.

A user whose ordinary fantasy battle is blocked concludes the product is broken and leaves. Tune stages 1 and 2 permissively, let stage 3 do the real work, and treat every user-reported false positive as a bug with a regression test.

For § 2 categories: no tuning. Block aggressively; accept the false positives.

## 6. Self-harm and crisis

Handled separately from other moderation because the right response is not a block.

**Detection:** classifier signal for self-harm intent, distinguishing between *a character in a story* and *the user themself*. The distinction is imperfect; err toward responding.

**Response when the user appears to be at risk:**

1. Do not block the message or end the conversation abruptly — abandonment is the wrong response to a person reaching out.
2. Surface a non-intrusive resource panel with region-appropriate crisis lines, above the conversation.
3. The character does not roleplay encouragement of self-harm. This is a hard constraint in every character prompt.
4. Do not log the content. Log only that a resource panel was shown, for measurement.
5. Never gamify or reward the disclosure.

Region-appropriate resource lists must be researched and reviewed before launch; a wrong or dead helpline number is worse than none.

## 7. Reporting and enforcement

```
POST /v1/reports  →  triage by severity
                     ├─ § 2 category    → immediate suspend + human review
                     ├─ policy breach   → review within 24 h
                     └─ quality/spam    → batch review
```

**Enforcement ladder:** warning → feature restriction (publishing, group play) → temporary suspension → permanent ban.

Every action is recorded in `enforcement_actions` with a reason. Users are told what happened and what rule applied. An appeal path exists and is answered by a human. Unexplained bans generate more damage than the violations they punish.

## 8. Copyright

**Policy:** original characters and user-created worlds. Users may create derivative content for private play; we do not build the business on it.

**Rules:**

- No promotion, recommendation or featuring of infringing content.
- Published worlds (Phase 15) are reviewed for obvious franchise reproduction before listing.
- No marketing that leans on specific franchises or real celebrities.
- A DMCA-equivalent notice-and-takedown process with a published contact address and a counter-notice path exists before publishing goes live.
- Repeat-infringer policy defined and enforced.

Impersonation of real people is prohibited outside clear parody or public-figure commentary, and never in a sexual or defamatory context.

## 9. Age policy

MVP: **13+ minimum, with `teen` content requiring self-declared 18+.** Confirm against the terms of every jurisdiction we serve and every provider in the chain before launch — several providers set their own minimums, and children's-privacy regimes (COPPA-style rules and their equivalents) impose obligations if under-13 users are foreseeable.

- Age is collected at signup and stored (`profiles.age_confirmed`).
- Under-13 accounts are refused.
- No marketing targeted at minors.
- If `mature` is ever enabled, real age assurance replaces self-declaration (§ 4).

**Open decision D-005:** whether to set the platform minimum at 18+ from the start. The argument for: it removes an entire class of compliance obligation and simplifies every downstream policy decision. The argument against: it shrinks the addressable market for what is fundamentally a storytelling product. Decide before Phase 13; record the reasoning.

## 10. Transparency

Published before launch, in plain language, at a stable URL:

- What is and is not allowed, with examples
- How moderation works, including that automation is involved
- What data we store and for how long
- That user content is not used for training
- Which third parties process content (the inference providers)
- How to report, appeal and delete

Publish moderation statistics once volume makes them meaningful. Founder-operated platforms earn trust through visible consistency, and it is much cheaper to establish that habit early than to retrofit it after an incident.

## 11. Failure modes

| Failure | Response |
|---|---|
| False positive on ordinary fiction | User-reported → regression test → tune stage 1/2. Track the rate as a quality metric. |
| False negative on a § 2 category | **S1 incident.** Immediate patch, review of similar content, audit of how it passed. |
| Moderation provider down | Fall back to heuristics + a stricter LLM screen. **Never fail open on § 2 categories.** |
| Moderation latency > 500 ms | Cache misses or stage-3 over-triggering. Tune stage-2 thresholds. |
| User circumvents via obfuscation | Normalize (unicode confusables, leetspeak, spacing) before stage 1 |
| Reports outpace review capacity | Triage by severity; § 2 always first; publish an honest response-time expectation |
| Moderation blocks a paying user mid-story | Explain precisely what was blocked and why; offer an appeal. This is a retention emergency, not a support ticket. |
