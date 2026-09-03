# Dark Forest

**An AI platform where users create persistent interactive worlds populated by characters that remember, form relationships, and evolve over time.**

The chatbot is the interface. The memory system is the intelligence layer. The world engine is the simulation layer. The AI router is the compute layer. The creator ecosystem is the growth layer. The subscription and marketplace system is the business layer.

---

## Status

| | |
|---|---|
| **Stage** | Phase 0 — Architecture & Specification |
| **Code written** | None yet (by design — see [Workflow](workflow/WORKFLOW.md)) |
| **Personal capital committed** | ₹0 |
| **Current focus** | Locking specifications before writing the first line of product code |
| **Live progress log** | [workflow/PROGRESS.md](workflow/PROGRESS.md) |

---

## How to navigate this repository

This repository is currently a **specification repository**. Code arrives in Phase 1. Everything here exists so that implementation is mechanical rather than improvised.

### Start here, in this order

1. **[docs/00-product-identity.md](docs/00-product-identity.md)** — What Dark Forest is, who it is for, what it refuses to be.
2. **[docs/01-principles-and-constraints.md](docs/01-principles-and-constraints.md)** — The non-negotiable rules every decision must satisfy.
3. **[workflow/WORKFLOW.md](workflow/WORKFLOW.md)** — The 20 phases, their gates, and what "done" means for each.
4. **[workflow/TASKS.md](workflow/TASKS.md)** — The living task board. This is where work actually gets picked up.
5. **[workflow/PROGRESS.md](workflow/PROGRESS.md)** — Where we are right now, updated at the end of every work session.

### Reference specifications

| Document | Covers |
|---|---|
| [02-system-architecture.md](docs/02-system-architecture.md) | Runtime topology, repo layout, request lifecycle, platform limits |
| [03-data-model.md](docs/03-data-model.md) | Full PostgreSQL schema, RLS policy model, migration strategy |
| [04-memory-engine.md](docs/04-memory-engine.md) | Extraction, retrieval, ranking, consolidation, knowledge isolation |
| [05-world-engine.md](docs/05-world-engine.md) | Authoritative state, rules, events, quests, inventory, time |
| [06-character-and-relationship-engine.md](docs/06-character-and-relationship-engine.md) | Character state, knowledge, relationship dimensions and dynamics |
| [07-multi-character-orchestration.md](docs/07-multi-character-orchestration.md) | Response planning, turn ordering, knowledge leakage prevention |
| [08-ai-router.md](docs/08-ai-router.md) | Provider abstraction, model selection, health, fallback, budgets |
| [09-context-builder-and-prompts.md](docs/09-context-builder-and-prompts.md) | Prompt architecture, token budgeting, injection defense |
| [10-api-contracts.md](docs/10-api-contracts.md) | HTTP surface, internal message protocol, error taxonomy |
| [11-channels.md](docs/11-channels.md) | Web, Telegram, WhatsApp adapters and identity linking |
| [12-security.md](docs/12-security.md) | Threat model, secrets, authz, abuse controls, checklists |
| [13-moderation-and-policy.md](docs/13-moderation-and-policy.md) | Content policy, moderation pipeline, age strategy, takedowns |
| [14-billing-and-entitlements.md](docs/14-billing-and-entitlements.md) | Plans, entitlement resolution, compute units, usage ledger |
| [15-testing-and-evaluation.md](docs/15-testing-and-evaluation.md) | Test pyramid, AI evaluation harness, quality gates |
| [16-observability-and-ops.md](docs/16-observability-and-ops.md) | Logging, metrics, alerts, runbooks, degradation ladder |
| [17-monetization-and-unit-economics.md](docs/17-monetization-and-unit-economics.md) | Pricing model, cost model, margin math, financial milestones |
| [18-launch-checklist.md](docs/18-launch-checklist.md) | Everything that must be true before the public URL goes live |
| [19-glossary.md](docs/19-glossary.md) | Shared vocabulary — use these terms exactly, in code and in docs |
| [workflow/DECISIONS.md](workflow/DECISIONS.md) | Architecture decision record. Every reversal gets logged here. |

### Operating rules

**[CLAUDE.md](CLAUDE.md)** defines how any AI agent (or human) is expected to work inside this repository: which document is authoritative, when to stop and ask, what must never be changed without an ADR.

---

## The one-sentence test

Before any feature is built, it must survive this question:

> Does this make it more likely that one person cares deeply about one persistent world?

If the answer is no, it does not belong in the current phase.

---

## License & ownership

Private and unlicensed. All infrastructure currently runs on personal free-tier accounts; migration to company-owned accounts is a hard gate before public launch (see [12-security.md](docs/12-security.md) § Account Ownership Migration).
