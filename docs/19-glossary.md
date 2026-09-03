# 19 — Glossary

> Use these terms exactly, in code, in documents, in the UI and in conversation. Consistent vocabulary is the cheapest form of architectural discipline available.

---

## Domain

| Term | Definition | Not to be confused with |
|---|---|---|
| **World** | A persistent setting with rules, state, characters, history and memory. The top-level unit of ownership. | Conversation |
| **World state** | Authoritative, versioned facts about a world at a moment: day, location, flags, numerics. Owned by the database. | Narrative description |
| **World rule** | A structured, binding constraint on a world. `hard` rules are validated in code; `soft` rules are tone. | Setting description |
| **Scene** | The current spatial and social frame: location, time, present characters. Gates who can hear and speak. | Chapter |
| **Chapter** | A narrative division of a world, with a summary and open threads. | Scene, session |
| **Character** | An AI-voiced entity with personality, goals, secrets, knowledge and relationships. | Persona |
| **Persona** | Who the *user* is inside a world. A user may have several. | Character, profile, account |
| **Narrator** | A non-character responder describing environment and outcomes. Has world-scope visibility. | Character |
| **Turn** | One user message plus all resulting responses. The unit of billing and orchestration. | Message |
| **Message** | A single utterance by one speaker. Several messages make one turn. | Turn |
| **Conversation** | An ongoing message thread within a world, on one channel. | World |
| **Session** | A period of continuous play. Used for retention metrics. | Conversation |

## Memory

| Term | Definition |
|---|---|
| **Memory** | One atomic fact, stored as a row, retrievable by relevance. Never raw conversation text. |
| **Episodic memory** | Something that happened, at a time. |
| **Semantic memory** | Something that is true, timelessly. |
| **Relational memory** | Something about how two entities relate, and why. |
| **World memory** | A global event. Does not decay. |
| **Persona memory** | A fact about the player. |
| **Reflection** | A synthesised higher-order insight, produced by consolidation, never by extraction. |
| **Extraction** | The background process deciding what from a conversation becomes a memory. |
| **Retrieval** | Selecting which memories enter a specific prompt, for a specific character, right now. |
| **Consolidation** | Merging duplicates, resolving contradictions, generating reflections, pruning. |
| **Knowledge isolation** | Enforcing, *at query time*, that a character can only recall what they know. |
| **Pinned memory** | A memory the user marked as always-retrieved. Bypasses ranking. |
| **Memory notebook** | The user-facing view of memory, with edit and pin controls. Free on every plan. |
| **Retrieval trace** | The stored record of why particular memories surfaced for a turn. |

## Relationships

| Term | Definition |
|---|---|
| **Relationship** | A directional, multi-dimensional record of how one entity regards another. |
| **Dimension** | One axis: trust, affection, respect, fear, romance, loyalty, hostility, familiarity. |
| **Delta** | A change to a dimension. Always requires a reason. Capped per turn. |
| **Decay** | Drift toward baseline over world time. |
| **Status label** | The derived human-readable summary — "wary ally", "betrayed". |

## AI

| Term | Definition |
|---|---|
| **AI Router** | The single component selecting, calling, metering and falling back across models. |
| **Provider** | A service exposing models. Behind the `AIProvider` interface. |
| **Tier** | `fast`, `standard` or `deep`. Application code names tiers, never models. |
| **Task class** | What the call is for — `dialogue`, `extract`, `plan`. Maps to a tier. |
| **Chain** | The ordered fallback list of models for a tier. |
| **Circuit breaker** | Per-model state that skips a failing model for a cooldown period. |
| **Context package** | Everything sent to the model for one generation. The model's entire reality. |
| **Context budget** | The token allocation per prompt section. |
| **Tool call** | A model's *request* to mutate state. Validated and applied by the backend. |
| **Structured output** | A schema-constrained model response, always Zod-validated before use. |
| **Mock provider** | A first-class deterministic provider enabling free, offline development and testing. |

## Orchestration

| Term | Definition |
|---|---|
| **Orchestrator** | Decides who responds, in what order. |
| **Responder** | A character or the narrator generating a message in a turn. |
| **Response plan** | The ordered responder list with scores and reasons. |
| **Presence** | Whether a character is in the current scene. A hard gate on responding. |
| **Addressing** | Whether the user's message targets a specific character. |
| **Stake** | How much this turn concerns a character's goals, secrets or relationships. |
| **Speaker bleed** | A failure where one character narrates another's words or actions. |

## Business

| Term | Definition |
|---|---|
| **Compute unit (CU)** | The internal currency for variable cost. Users see human-readable limits. |
| **Entitlement** | A capability or limit resolved per user. Code asks "may they?", never "which plan?". |
| **Usage ledger** | The per-user, per-day, per-meter record of consumption. |
| **Admission control** | The pre-flight check reserving budget *before* any model call. |
| **Degradation ladder** | The defined levels of reduced service under adverse conditions. |
| **Kill switch** | One flag halting all non-essential inference. |
| **Returning World Sessions (RWS)** | The north-star metric: (user, world) pairs active in consecutive weeks. |

## Engineering

| Term | Definition |
|---|---|
| **Modular monolith** | One deployable, strict internal module boundaries enforced by lint. |
| **Module** | A bounded unit owning its tables, exposing `index.ts` only. |
| **Contract** | A Zod schema in `packages/contracts` — the shared truth between client and server. |
| **Job** | Deferred work in the `jobs` table, drained by cron, run inline via `waitUntil` where possible. |
| **Idempotency key** | A client- or system-supplied id making a repeated operation a no-op. |
| **Optimistic concurrency** | Version-checked writes that fail rather than silently overwrite. |
| **ADR** | Architecture Decision Record, in `workflow/DECISIONS.md`. Required for reversing anything authoritative. |
| **Gate** | A condition that must hold before a phase may be considered complete. |

## Terms we deliberately avoid

| Avoid | Use instead | Why |
|---|---|---|
| "Chatbot" | World, character, story | It is the wrong mental model and it undersells the product |
| "AI girlfriend" | Character, companion, relationship | Narrows the brand and closes commercial doors |
| "Unlimited" | The actual limit | It is never true and it destroys the economics |
| "Prompt" (user-facing) | Message, what you say | Users are playing, not prompting |
| "Token" (user-facing) | Message, daily limit | Nobody has an intuition for tokens |
| "Agent" | Character | Overloaded, and it sounds like infrastructure |
| "Context window" (user-facing) | — | Implementation detail; if it leaks into the UI, the design is wrong |
