# PROGRESS

> Updated at the end of **every** work session. Not weekly — every session.
> Newest entry at the top.

---

## Current state

| | |
|---|---|
| **Phase** | 1 — AI Lab & Evaluation Harness |
| **Phase status** | **Loop works end to end.** Gate not yet assessable — needs a real model. |
| **Next task** | **P1-T13** eval harness runner, then T14/T15 (suites 1 and 3) |
| **Blocked on** | **API keys: `GROQ_API_KEY`, `CF_ACCOUNT_ID` + `CF_API_TOKEN`** → blocks P1-T02, T05, T07 **and the Phase 1 gate** |
| **Code** | 130 tests · typecheck green · lint green · `pnpm lab` runs offline and free |
| **Money spent** | ₹0 |

### Lab results (mock provider, lexical embeddings)

| World | recall@k | answer accuracy | memories | model calls |
|---|---|---|---|---|
| Ravenhold | **3/3 (100%)** | 1/3 | 7 | 17 |
| The Kapoor House | 2/3 (67%) | 1/3 | 4 | 26 |
| Mars Colony 2147 | 2/3 (67%) | 1/3 | 4 | 18 |
| The Ashford Inquiry | 1/2 (50%) | 1/2 | 2 | 16 |

**These numbers do NOT constitute the Phase 1 gate.** The mock embedder is lexical
only — no synonymy, no paraphrase. They are a lower bound on *pipeline*
correctness, and the gate explicitly requires a real embedding provider.

The sub-100% worlds are worth reading before tuning anything: Ashford's script
plants facts in dialogue rather than in user statements, so the mock's
user-lines-only extractor never sees them. That is a fixture-and-mock artefact,
not a retrieval failure — and a good reminder that a real extractor will need to
read character lines too.

### The next three things

1. **P1-T13** — eval harness runner, so results are dated JSON rather than console output.
2. **API keys** — Groq and Cloudflare. The Phase 1 gate cannot be assessed without them.
3. **P0-T13** — the end-to-end spec contradiction read. Still deferred.

---

## Session log

### 2026-09-03 (3) — The memory loop runs

**Done** — P1-T08 ☑ · P1-T10 ☑ · P1-T11 ☑ · P1-T12 ☑ · P1-T18 ☑ (new)

Three new packages: `@darkforest/memory` (store boundary, in-memory impl,
retrieval pipeline, gated extraction), `@darkforest/prompts` (dialogue/v1,
extract/v1, injection sanitiser), `@darkforest/evals` (four canonical worlds,
lab CLI). `pnpm lab` runs the whole loop offline and free.

**Learned — four bugs, all found by running the thing rather than by reading it:**

1. **A mock that stores contentless memories tests nothing.** The first run
   showed recall 0% and my instinct was "retrieval is broken." It wasn't — the
   mock was emitting canned strings like *"The user made a promise."* with no
   content. There was nothing specific to retrieve. Worth remembering: when a
   metric reads zero, check that the thing being measured exists.

2. **The gate read the whole rolling window**, so a "promise" three turns back
   kept re-firing and the signal list grew monotonically until effectively
   nothing was gated. The window and the gate need *different spans*: gate on
   what is new, extract over the window.

3. **The mock extracted from its own prompt scaffolding** — it stored Elena's
   dialogue as fact, stored the literal word "TRANSCRIPT", then on the next turn
   extracted its own previous output recursively. For the extract task class the
   "user" message is the rendered prompt, not the player's turn.

4. **My recall metric was wrong.** It measured "did the character echo the fact",
   which measures the model's phrasing rather than the ranking — and makes a
   retrieval regression indistinguishable from a generation one. docs/15 suite 1
   separates recall@k from answer accuracy for exactly this reason, and I had
   collapsed them. Split; recall@k went from 0% to 100% on Ravenhold with no
   change to retrieval at all.

**Also:** a stray `0x02` control character had been written into `mock.ts` —
invisible in the editor, and it silently broke exact-match edits until I dumped
the bytes. Scanned the repo; single occurrence. Separately, lint caught that the
*invisible-character detector* in `sanitize.ts` contained literal invisible
characters. Rewritten with `\u` escapes: a detector you cannot read is precisely
the thing it exists to catch.

**Decided** — nothing new. ADR-016's gate is now implemented and remains
provisional pending suite 1 with and without it.

**Next** — P1-T13 eval harness. The Phase 1 gate still needs real API keys.

---

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
