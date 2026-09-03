# PROGRESS

> Updated at the end of **every** work session. Not weekly — every session.
> Newest entry at the top.

---

## Current state

| | |
|---|---|
| **Phase** | 1 — AI Lab & Evaluation Harness |
| **Phase status** | Foundation built; gate not yet assessable (needs a real provider) |
| **Next task** | **P1-T06** — mock provider (not blocked) |
| **Blocked on** | **API keys: `GROQ_API_KEY`, `CF_ACCOUNT_ID` + `CF_API_TOKEN`** → blocks P1-T02, T05, T07 |
| **Code** | 53 tests passing in 26 ms · typecheck green · lint green |
| **Money spent** | ₹0 |

### The next three things

1. **P1-T06** — mock provider. Unblocked, and it unblocks the whole memory loop without spending a single token.
2. **API keys** — Groq (primary, privacy-clean) and Cloudflare (embeddings). Everything touching a real model waits on these.
3. **P0-T13** — read the spec set end to end for contradictions. Deferred, not forgotten.

---

## Session log

### 2026-09-03 (2) — Provider research + Phase 1 foundation

**Done** — P0-T12 ☑ · P1-T01 ☑ · P1-T03 ☑ · P1-T04 ☑ · P1-T09 ☑ · P0-T11 ◐

**Learned — this is the section that matters.** Four findings, all of which changed the plan:

1. **OpenRouter free is 50 requests/day**, not the workhorse the blueprint assumed. That is ~10 multi-character turns per day for the entire platform. A one-time $10 credit raises it to 1,000/day permanently (ADR-011).

2. **Groq resolves the privacy/budget conflict.** Its Services Agreement forbids training on customer inputs or outputs, account-wide, free tier included — so unlike Gemini it can carry *real user content*. 1,000 req/day per model across 4 usable models. This was a better outcome than either option in the original question, and it became ADR-009.

3. **Gemini and NVIDIA NIM both explicitly warn against submitting personal data** and use content to improve their models. Both are development-only, disabled in production by config. **GitHub Models was retired 2026-07-30** — worth checking before designing around it. **Cerebras is 5 RPM and requires a payment method**, contradicting the widely-repeated "14,400 RPD, no card" claim; its own docs won.

4. **The binding constraint is tokens/day, not requests/day.** At ~12,000 tokens per generation against Groq's 200K/day per-model cap, the total ₹0 pool is ~70 turns/day. Enough for Phases 1–10, not for a 50–100 user beta. Produced ADR-012 (compact context profile).

**Two design flaws found by the tests, both mine, both real:**

- **RRF normalisation was broken.** Linear normalisation against the theoretical maximum put a rank-4 result at 0.95 — because with k=60, ranks 1 and 4 differ by under 5%. That value feeds the `similarity` term at weight 0.30, so it would have collapsed into a near-constant and the ranking formula would have silently lost its most heavily weighted input. Replaced with exponential rank decay. My own code comment had asserted the opposite; the test caught it.
- **The soft MMR penalty did not stop restatements.** Measured: two phrasings of the Ravenblade fact score Jaccard 0.667, giving a 0.20 penalty against a 0.22 relevance gap — the duplicate wins. Added a hard near-duplicate cutoff at 0.6, with a calibration test proving genuinely distinct memories (0.50) stay below it.

A third test failure was a bad fixture of mine — `"Distinct fact number ${i}"` shares 4 of 5 content words between iterations, so the cutoff correctly rejected it. Kept as a documented note: **the cutoff bites hard on templated text.**

**Decided** — ADR-009 (Groq primary), ADR-010 (Hono, so the Workers 10 ms CPU / 50 subrequest limits stop being a one-way door), ADR-011 ($10 OpenRouter as a Phase 11 prerequisite), ADR-012 (compact context profile).

**Blocked** — P1-T02, T05, T07 all need API keys.

**Next** — P1-T06 mock provider, which needs no keys and unblocks the memory loop.

---

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
