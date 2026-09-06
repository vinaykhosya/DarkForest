# PROGRESS

> Updated at the end of **every** work session. Not weekly — every session.
> Newest entry at the top.

---

## Current state

| | |
|---|---|
| **Phase** | **V0.1 — the vertical slice** (ADR-029 reorders Phases 2–9) |
| **Phase status** | **The loop closes.** A stranger is remembered a day later — on 6 of 9 runs. Every failure is the same step, and it is extraction on first mention. |
| **Next task** | **V1-T19** make first-mention extraction reliable, on evidence, then **V1-T18** play it as a user |
| **Blocked on** | Nothing. Supabase provisioned, 9 migrations applied, RLS enforced through `asUser`. |
| **Code** | 328 tests · typecheck green · lint green · `pnpm db:verify` green against Supabase |
| **Money spent** | ₹0 |

### Where the memory foundation actually stands

Measured over 3 repetitions with nothing changed between them, on two worlds:

| | | |
|---|---|---|
| **KNOWLEDGE** | 57/57 | zero leaks. The hard criterion, and it holds. |
| **TRUTH** | 48/57 (84%) | the 9 misses are 3 extraction gaps × 3 reps, all logged as M1-T01…04 |
| **EXPRESSION** | 39/48 (81%) | from 27/48, after one model's reasoning config was fixed |

**None of these is the V0.1 gate.** V0.1 is judged by one sentence — a stranger
creates Elena, tells her something, comes back tomorrow, and she remembers —
because every benchmark worth running on the frozen foundation has been run.

### The next three things

1. **V1-T19** — the same sentence must be captured on 9 runs in 10, not 6 in 9.
2. **V1-T18** — play it as a user. The only number that matters now is 1 person.
3. **V1-T20** — re-verify `gpt-oss-20b` for the widened category, or drop the
   task class from its `verifiedTaskClasses`. ADR-022: competence is measured,
   never assumed.

---

## Session log

## 2026-09-06 (V0.1) — the loop closes, two times in three

**Done** — V1-T01…T16 ☑ · V1-T17 ◐ (6 of 9) · ADR-030

The product exists. A stranger signs up, makes a world and a character, has a
conversation, closes the browser, comes back to a new session the next day, and
is remembered:

    you:   The ferry's not running. Should we wade across the channel instead?
    Elena: And drown? Keep your boots dry. You'll stick to the shore while I
           handle the water.
    drew on: the user cannot swim, never learned

Nothing in that question mentions swimming. The retrieval is machine-checked;
the reply is left for a person to read, because a substring check for "swim"
would score a character who recites the fact above one who acts on it — which is
the exact failure ADR-026 already records about the matcher.

### It passes 6 of 9. That is the headline, not the transcript above.

Every failure is the same step: day one, the confession produces no event. The
layer trace says where it was lost — `events (0) · memories (0) · grants (0)` —
so it is not a downstream loss. The extractor returned valid JSON with an empty
array, rejected nothing, dropped nothing, and simply declined to record the
sentence.

**Not tuned green.** Raising `aggressiveness` until this fixture passes optimises
for one sentence; retrying until the model says something turns "nothing durable
here" — the correct answer on most turns — into a thing we refuse to accept.
V1-T19 measures it properly.

### Three real bugs the acceptance test found, in the order it found them

**1. The ontology had no slot for a fact about oneself.** "I can't swim. I never
learned" produced nothing. A 10-sentence probe: **8 of 8 self-descriptions
missed — inability, condition, history, identity, capability, constraint —
while both controls were kept.** Not a judgement failure and not a parse failure;
`preference_stated` was described as "a like, dislike, fear or refusal", under
which an inability is none of them. Widening that one description: **2/10 →
8/10** on the same probe. It stays ONE type rather than becoming two, because
ADR-025's rule is that a type earns its place by feeding a projection nothing
else feeds, and a trait and a preference both fold into the same PersonaFact.
Still missing: past occupation and stated name. Recorded, not chased.

**2. Nobody told the system Elena was in the room.** With the event finally
stored, she still could not recall it: `audienceFor` restricts a
`preference_stated` to its actor, and the extractor had not named her. The
player was speaking directly to her and she could not remember a word of it.
The wrong fix is loosening `audienceFor` — that rule fails closed because the
extractor is demonstrably unreliable about who was present, and loosening it is
what produced the Saltmarsh leak. The right fix is that the BACKEND knows who
the conversation was between, the same class of fact as `worldDay` and
`sourceTurn` which it already stamps. Being TOLD something is how a character
legitimately learns it; the Saltmarsh leak was a character recorded as having
SEEN something, which is a different claim.

**3. The grant read the wrong field.** It mirrored `knownBy` — what the extractor
fills in — instead of the stored audience, so it granted nothing whenever the
model failed to name the listener, which is most of the time. The character held
the event and could not retrieve the memory derived from it: two representations
of one fact, disagreeing. That is the third time this codebase has hit that
shape. It now goes through `canRecall`, the single implementation.

### And one that would not have been found by reading

`renderEventAsMemory`. Memories were being built by joining event fields, which
produced

    the user preference stated swimming cannot swim, never learned

That retrieves correctly and reads like a database row — and it goes into the
prompt under "WHAT YOU REMEMBER", read by the model that has to sound like it
remembers. Now: `the user cannot swim, never learned`.

### The finding that was not on the task list

The `SchedulerRouter` lived in `packages/evals`, so the product could not use the
scheduler every benchmark was measured through. Moving it to `@darkforest/ai`
exposed `pool: "development"`, `environment: "local"`,
`isSyntheticContent: true` — hardcoded. All three are true in the eval harness
and **false in the product**, and `isSyntheticContent` gates whether real user
conversations may reach providers whose terms permit training on them (ADR-013,
ADR-009). It is now a required config field with no default, so a caller who
forgets does not compile.

**Learned** — an acceptance test written as a product sentence found four defects
in an afternoon that three weeks of benchmarks did not, because it was the first
thing to ask whether the parts work TOGETHER. None of them were in the memory
architecture ADR-028 froze; all four were in the wiring around it.

**Decided** — ADR-030 (Supabase Auth; the API connects as the user, never as
`service_role`).

**Next** — V1-T19: make first-mention extraction reliable, on evidence. Then
V1-T18, played as a user rather than as its author.

---

## 2026-09-06 (latest) — a second judge; V0.1 begins

**Done** — Expression Suite judge hardened · results recorded · D-003 resolved
(ADR-030) · V0.1 put on the board · V1-T01 migration runner

### The second judge, and what it actually showed

v1 ran ONE judge and scored whatever came back. Two of its six cases were
therefore not measurements:

- **E-D relational** read 1/3.
- **E-F long-horizon** read 0/3 — resting on a single verdict, because the
  other two came back unparseable.

Now two judges must agree, each retries once, and a split or a missing verdict
is recorded as **unmeasured** rather than scored.

| Case | v1 | now | what changed |
|---|---|---|---|
| E-A explicit recall | 3/3 | 3/3 judged | — |
| E-B contextual | 3/3 | 3/3 judged | — |
| E-C behavioural | 3/3 | 2/2 judged, 1 unmeasured | a judge failed twice |
| E-D relational | 1/3 | **1/1 judged, 2 unmeasured** | the judges contradict each other |
| E-E restraint | 3/3 | 3/3 judged | — |
| E-F long-horizon | 0/3 | **1/3 judged, 0 unmeasured** | the retry recovered the lost verdicts |

**Read the headline carefully. 13/15 (87%) is NOT an improvement on 13/18 (72%).
The character did not change — nothing in the product was touched. The
denominator changed, because the old one counted reps nobody could judge as
failures.** Quoting 87% as progress would be the fifth measurement bug in a row,
and this time I would have introduced it while fixing the fourth.

Two findings, in opposite directions:

**E-D was never a failure.** On the same reply — *"The caravan went east. You
told me north. Six days ago."* — one judge wrote *"Not a guarded, cooler reply;
just factual statement"* and the other wrote *"Cool, short, guarded, references
lie."* That is not a character missing a standard, it is a rubric two competent
readers apply oppositely. Relational tone is currently **unmeasurable** by this
instrument, and saying so is more useful than 1/3.

**E-F is real, and worse than it looked.** With the retry, all three reps
produced verdicts and both judges AGREED on all three: 1 pass, 2 failures, both
*"Ignores user's inability to swim."* v1's 0/3 was untrustworthy; the trustworthy
number is 1/3. Long-horizon callback is a genuine weakness — a fact from far back
in a session is held and not used — and it is now the best-evidenced gap in
expression. Logged against M2-T02.

The suite was hardened, not redesigned, and it was re-run once (18 reps), not
hundreds of times.

### V0.1 started

- **ADR-030** resolves D-003: Supabase Auth. The reasoning that decided it is not
  convenience — it is that RLS needs `auth.uid()`, and the alternative is
  ownership checks in application code, which is the same class of mistake as
  filtering knowledge in application code.
- **The half that is easy to get wrong is written down**: the API must connect as
  the *user* (`set local role authenticated`, claims set LOCAL to the
  transaction), never as `service_role`. A service-role connection bypasses every
  policy silently — CI still passes, negative tests against raw SQL still pass,
  and no policy ever runs in production. `set_config(..., false)` would be worse
  still: claims persisting on a pooled connection means the next request runs as
  the previous user.
- **V1-T01 migration runner**: forward-only, one transaction per migration,
  checksums on applied files, advisory lock around the run. No `down`
  migrations — a down migration is written when the schema is understood and run
  when it is not.

**Learned** — an instrument that cannot express "I don't know" will express it as
a score, and a score is acted on. Three of the six expression cases were affected
and one of them (E-D) would have sent us tuning a character that was fine.

**Decided** — ADR-030 (Supabase Auth; connect as the user).

**Next** — V1-T02…T08, the migrations, `turns → events → projections → memory
index` from the first one.

---

## 2026-09-06 (later) — final gate: zero leaks, expression 81%

Three repetitions, nothing changed between them, on the post-fix code.

    KNOWLEDGE   57/57   the Elena leak is GONE
    TRUTH       48/57   84%
    EXPRESSION  39/48   81%, from 27/48 before the reasoning fix

A-isolation-elena is 3/3 with 0 leaks, having leaked in two of the four earlier
runs. Cause: the extractor wrote knownBy=["the user","Elena"] on a perception
Elena was never present for; the audience rule obeyed. Fixed by ignoring
model-supplied audience on `observed` entirely.

THE FIX CHARGED FOR ITSELF and the data shows where. Two probes now report
`isolation` in their lost-at column — A-state-ring 0/3, B-temporal 1/3 — because
narrowing audiences means a fact that used to reach a viewer sometimes does not.
That was the stated trade, and it is visible rather than theoretical.

The verdict line still reads BELOW BAR on end-to-end at 68%. That threshold
predates the three-layer split and conflates memory with generation. Left
untouched: moving a bar to agree with a result is how a gate stops meaning
anything.

Every ADR-028 freeze criterion is now met, including the single item recorded as
open at the time of freezing.

Raw run JSON is gitignored, so these numbers live here and in commit messages.

NEXT: Expression Suite v1 per category, then Postgres and the V0.1 vertical
slice (ADR-029).



## 2026-09-06 — Memory Foundation v1 FROZEN

Three Gauntlet repetitions, 57 probe observations, nothing changed between runs.

    KNOWLEDGE   57/57   zero leaks
    TRUTH       48/57   all misses at extraction, 3 probes, each 0/3
    EXPRESSION  27/48   character knew it and did not say it

ADR-028 freezes the architecture. P0 is closed; P1 is four bounded extraction
gaps; P2 is context construction and generation, which is where the real
unknowns now are.

What this stretch actually found, in order: capacity was metered per credential
when Groq meters per model (4x); a model that fails cheaply looks like a model
with capacity; the vector query was being diluted by recent dialogue; four
measurement bugs, each in the instrument written to check the previous one; a
knowledge leak caused by one rule with two implementations; a second leak
because isolation rested on the model picking an event type; dialogue was the
only task class running with uncontrolled reasoning; and four live provider keys
committed inside the redaction test.

Six architecture investigations, and every one of them found a defect in the
instrument or the implementation rather than the design. That is the argument
for stopping.

NEXT: the website. World creation, characters, chat, persistence. The next
important discovery should come from someone entering a world, doing something
at 2am, and returning two days later to find it remembered.



### 2026-09-04 — Phase 1 gate run: MARGINAL, and the instrument is the problem

**Done** — P1-T02 ☑ · P1-T05 ☑ · P1-T07 ☑ · full gate runner built and run 7×.

**Result: recall@k median 91%, range 73–100% across 7 runs.** Four of seven clear
the 85% gate. Full numbers: [gate benchmark](../docs/benchmarks/2026-09-04-phase1-gate.md).

**I am not calling this a pass**, and the reason matters more than the number.
The fixture has 11 planted facts, so one fact flipping moves the score 9 points.
A threshold at 85% cannot be resolved by an instrument whose smallest increment
is 9 points — the 27-point spread is exactly what that looks like. docs/15 § 3
specifies suite 1 as 20 facts across 100 turns; what exists is 11 across 39.
Reporting the median of a noisy instrument as a measurement would be the wrong
call, and tuning extraction until a small sample lands above the line would be
worse.

**Learned:**

1. **Reasoning tokens are 95–97% of content output.** They roughly double the
   cost of a generation. Any capacity number that ignores them is wrong by about
   2×.

2. **Requests bind before tokens, by a wide margin.** The token pool supports
   ~175 turns/min; the request pool allows 13.5 sustained. So *calls per turn* is
   the economic lever, not context size — which inverts the premise of ADR-012.
   Measured capacity: **~18,900 turns/day, ~975 DAU at 20 turns each.**

3. **The extraction gate saves 36% of turns** outright. Largest single cost
   reduction in the system, and it is free deterministic code.

4. **The 8K ceiling is not currently binding** — largest observed request was
   1,325 tokens against a ceiling of 8,000.

5. **Temperature was not the variance.** Setting extraction to 0 changed the
   distribution but not the spread (82/91/82 vs 73/100/100/91). Kept at 0 anyway
   because extraction is transcription.

6. **Ashford stores 1 memory from 6 turns, every run.** Its facts live inside
   questions the player asks, and the gate's signals do not fire on
   interrogatives. Real gap: in a mystery, what the player asks IS the fact.

7. Latency is genuinely good — dialogue p50 ~660 ms, p95 ~1.1 s.

**Next** — build suite 1 properly (P1-T14) before re-testing the gate. Do not
buy the OpenRouter credit, add providers, or start Phase 2 until the gate is
measurable.

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
