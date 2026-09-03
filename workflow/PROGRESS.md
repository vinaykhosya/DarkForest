# PROGRESS

> Updated at the end of **every** work session. Not weekly — every session.
> Newest entry at the top.

---

## Current state

| | |
|---|---|
| **Phase** | 0 — Architecture & Specification |
| **Phase status** | Deliverables complete; gate not yet assessed |
| **Next task** | **P0-T11** — resolve open decisions D-001, D-002, D-003 |
| **Blocked on** | Nothing |
| **Code written** | None (correct for this phase) |
| **Money spent** | ₹0 |
| **Days to Phase 1** | Gated on P0-T11, T12, T13 |

### The next three things

1. **P0-T12** — verify every free-tier limit in [01](../docs/01-principles-and-constraints.md) § Part C. Several were taken from external research and are unverified. The architecture assumes them.
2. **P0-T11** — decide D-001 (backend runtime), D-002 (embedding provider), D-003 (auth). D-001 depends on T12's findings.
3. **P0-T13** — read the full spec set end to end looking for contradictions. Twenty documents written in one pass will contain some.

---

## Session log

### 2026-09-03 — Phase 0 specification set written

**Done**
- Complete specification set: 20 documents in `docs/`, covering identity, principles, architecture, data model, all four engines, orchestration, prompts, API contracts, channels, security, moderation, billing, testing, ops, economics, launch and glossary.
- Workflow system: 20-phase build order with entry criteria, deliverables and exit gates; task board with ~150 tasks across Phases 0–11; decision log with 8 accepted ADRs, 6 open decisions and 4 rejected options.
- `CLAUDE.md` operating rules for anyone (human or AI) working in this repository.

**Decisions made** — ADR-001 through ADR-008 (see [DECISIONS.md](DECISIONS.md)).

**Decisions deferred** — D-001 backend runtime · D-002 embedding provider · D-003 auth provider · D-004 mature content · D-005 minimum age · D-006 brand name.

**Open risks identified**

| Risk | Why it matters | Mitigation |
|---|---|---|
| Free-tier limits in [01](../docs/01-principles-and-constraints.md) § Part C are **unverified** | The architecture is designed against them | P0-T12 before any code |
| Specific model endpoints named in the source blueprint are **unverified** and post-date available knowledge | Tier assignment depends on their real capabilities | P1-T02 verifies empirically; the router makes this survivable either way |
| Workers' subrequest cap may constrain multi-character turns | Directly limits the core differentiator | P0-T12 measures it; responder caps are the lever |
| Storage math puts the free tier at its limit around 100k memories | Constrains beta size | Mitigation ladder specified; P2-T13 measures reality |
| "Dark Forest" has notable prior associations | Rebranding after launch is expensive | D-006 before any domain purchase |

**Next session** — start with P0-T12. It is the cheapest task and it unblocks D-001.

---

## How to use this file

**At the end of every session, append an entry:**

```markdown
### YYYY-MM-DD — one-line summary

**Done** — tasks completed, with IDs
**In progress** — what is half-finished, and where you left it
**Blocked** — what is stuck and on what
**Learned** — anything that contradicts the specification
**Decided** — new ADRs
**Next** — the single next action
```

Then update the **Current state** table at the top.

### Why this file exists

Three reasons, in order of importance:

1. **Resuming.** After a gap of days or weeks, "where was I" is answered in ten seconds instead of an hour of re-reading code.
2. **Velocity.** After a month of real entries, you can forecast from measured throughput instead of guessing — which is why [WORKFLOW.md](WORKFLOW.md) deliberately contains no date estimates.
3. **Honesty.** Writing down what did not work, weekly, is the main defence against the slow drift where a plan stops describing the actual product and nobody notices.

**The "Learned" line matters most.** A specification written before any code will be wrong in places. The value is in recording *where* it was wrong, so the next decision is better informed rather than made against a document that quietly stopped being true.
