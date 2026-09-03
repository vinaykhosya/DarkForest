# 00 — Product Identity

> **Status:** Authoritative. Changes require an ADR in [../workflow/DECISIONS.md](../workflow/DECISIONS.md).
> **Owner:** Founder
> **Last reviewed:** 2026-09-03

This document answers one question: *what is Dark Forest?* Every other document in this repository derives from it. If a specification and this document disagree, this document wins until an ADR says otherwise.

---

## 1. The definition

**Dark Forest is a platform for persistent AI worlds.**

A user enters a world containing multiple characters, lore, relationships, quests and history. They interact with it in natural language. The world changes as a result. The characters remember. When the user returns a week later, nothing has reset.

The full sentence, for external use:

> *An AI platform where users create persistent interactive worlds populated by characters that remember, form relationships, and evolve over time.*

## 2. What we are not building

Naming the anti-product is more useful than naming the product, because the anti-product is what we will drift toward under pressure.

| We are not | Because |
|---|---|
| A chatbot with a nicer UI | Stateless conversation is a commodity with zero switching cost |
| A character-card gallery | Card sites compete on catalogue size; we compete on continuity |
| A wrapper over one model | Model access is rented, not owned. Any model can vanish in a week |
| An NSFW brand | It caps our payment rails, app-store access, ad channels and acquirer pool |
| A celebrity/franchise impersonation service | It is a legal liability disguised as a growth channel |
| An "unlimited AI" product | Unlimited inference on a free tier is a solvency event, not a feature |

## 3. The core loop

```
Enter a world
      ↓
Act in natural language
      ↓
Characters respond — independently, in character, with only what they know
      ↓
The world state changes (relationships, events, quests, inventory, time)
      ↓
Memory is extracted and stored — selectively
      ↓
User leaves
      ↓
User returns days later
      ↓
The world remembers, and has consequences waiting
```

The product succeeds or fails on the last two steps. Everything else is table stakes.

## 4. The differentiator, stated precisely

Most AI roleplay products approximate memory by stuffing conversation history into a context window. That works until the window fills, then it degrades invisibly and the illusion breaks.

Dark Forest treats world state as **database-authoritative** and conversation as **model-generated**. The model narrates; it does not decide what is true.

Three consequences follow, and they are the moat:

1. **Facts survive context limits.** A promise made on day 1 is a row, not a token.
2. **Characters can be ignorant.** Knowledge is scoped per-character, so secrets are enforceable rather than requested.
3. **State cannot be hallucinated.** Gold, health, deaths and quest completion are mutated only through validated tool calls.

## 5. The four layers

| Layer | Responsibility | Spec |
|---|---|---|
| **Simulation** — World Engine | Owns truth: state, rules, events, quests, time | [05](05-world-engine.md) |
| **Intelligence** — Memory Engine | Decides what is remembered and what is recalled *now* | [04](04-memory-engine.md) |
| **Social** — Character & Relationship Engine | Owns personality, private knowledge, relationship dynamics | [06](06-character-and-relationship-engine.md) |
| **Compute** — AI Router | Chooses a model, survives its disappearance, meters its cost | [08](08-ai-router.md) |

Above them sits the **Orchestrator** ([07](07-multi-character-orchestration.md)), which decides who speaks and in what order. Around them sit **Channels** ([11](11-channels.md)) — web, Telegram, WhatsApp — which are interchangeable skins over one backend.

## 6. Who this is for

**Primary persona — The Returner.** Plays one or two worlds for months. Cares about continuity, consequence and character consistency far more than about response speed or model brand. This is the only persona that matters until Phase 11.

**Secondary persona — The Creator.** Builds worlds for others. Cares about authoring tools, lore management and eventually revenue. Activated from Phase 15.

**Tertiary persona — The Group.** Plays a shared campaign in a Telegram group with an AI game master. Cares about low friction and social moments. Activated from Phase 10; this is our cheapest viral surface.

**Explicitly not a target until validated:** the high-volume message-count user who treats the product as a text generator. They are expensive, they do not retain on continuity, and optimizing for them destroys the economics.

## 7. Positioning

- **Primary:** Create AI worlds that remember.
- **Secondary:** Build characters that evolve.
- **Tertiary:** Play stories that never reset.

The marketing proof is time-based, not feature-based: a 30-second video showing day 1, day 30 and day 60 of the same world, where day 60 references day 1 without being told to.

## 8. Content identity

Dark Forest launches as a **general-audience narrative platform**: fantasy, sci-fi, adventure, mystery, drama, horror, romance, interactive fiction, tabletop-style RPG.

Mature content is a **separate, later, gated decision** with its own policy, age assurance, payment rail and moderation posture. It is not part of MVP, and it is never part of brand identity. See [13-moderation-and-policy.md](13-moderation-and-policy.md) § Mature Content and open decision **D-004**.

## 9. Brand notes — open items

The working name is **Dark Forest**. Before any money is spent on a domain or trademark, the following must be checked and recorded in [DECISIONS.md](../workflow/DECISIONS.md):

- [ ] **Prior use collision.** "Dark Forest" is strongly associated with (a) the dark-forest hypothesis from Liu Cixin's *The Three-Body Problem*, and (b) at least one well-known existing game using the exact name. Verify current trademark registrations in the relevant classes (IC 009 / IC 041 / IC 042) before committing.
- [ ] **Domain availability** across `.com` and one credible alternative, with *renewal* price checked, not just first-year price.
- [ ] **Social handle availability** on the three channels we will actually use.
- [ ] **Pronounceability and spelling** for a non-English-first audience.
- [ ] **Search dilution** — measure how much existing content already ranks for the exact phrase.

The internal codename can remain `darkforest` regardless of the outcome; the public brand is a Phase 13 decision, not a Phase 0 one. **Do not buy a domain before Phase 13.**

## 10. Success definition for the MVP

The MVP is successful if and only if all of the following are observed in the private beta:

1. A user creates a world with more than one character without assistance.
2. Characters respond distinguishably from one another over ≥50 turns.
3. A fact established in session 1 is correctly recalled in session 4 or later, unprompted.
4. Relationship values move in a direction a human observer agrees with.
5. A measurable share of beta users return to **the same world** within 7 days.
6. At least three users say, unprompted, some version of *"it remembered."*

Message volume, world count and signup count are explicitly **not** MVP success criteria.

## 11. North-star metric

**Returning World Sessions (RWS)** — the number of distinct (user, world) pairs that record a session in week *N* and again in week *N+1*.

Chosen because it is the only metric that cannot be gamed by generating more text, and it fails immediately if persistence does not work.

Supporting metrics are listed in [17-monetization-and-unit-economics.md](17-monetization-and-unit-economics.md) § Product Metrics.
