# 15 — Testing & Evaluation

> Ordinary software is tested. AI behaviour must be *evaluated* — measured, tracked, and defended against regression.
> **Status:** Authoritative. The eval harness is a Phase 1 deliverable, before the first product feature.

---

## 1. Two separate disciplines

| | Tests | Evals |
|---|---|---|
| Question | Does the code do what it says? | Does the system behave well? |
| Answer | Binary | A score, compared to a baseline |
| Speed | Milliseconds | Minutes |
| Cost | Free (`MOCK_AI=true`) | Real inference |
| Runs | Every commit | Before every model, prompt or retrieval change |
| Failure | Blocks merge | Blocks the change; may prompt a rollback |

**Both are mandatory.** Tests without evals means shipping quality regressions confidently. Evals without tests means shipping bugs slowly.

## 2. The test pyramid

```
        ╱─────────╲          E2E (Playwright) — 8–12 tests
       ╱  browser  ╲         critical journeys only
      ╱─────────────╲
     ╱  integration  ╲       ~60 tests — module boundaries,
    ╱                 ╲      real DB, mock AI
   ╱───────────────────╲
  ╱        unit         ╲    400+ tests — packages/core is pure
 ╱                       ╲   functions and must be ~100% covered
╱─────────────────────────╲
```

### Unit — `packages/core`

Everything in `core` is a pure function with no I/O, which makes the hardest logic in the system trivially testable:

```ts
describe('memory ranking', () => {
  it('ranks a pinned memory above a higher-similarity unpinned one', …);
  it('decays episodic memories faster than semantic ones', …);
  it('applies MMR so near-duplicates do not both survive', …);
  it('never exceeds the token budget', …);
});

describe('relationship deltas', () => {
  it('caps a single-turn delta at 15', …);
  it('applies diminishing returns above 60 trust', …);
  it('rejects a delta with no reason', …);
  it('decays toward baseline over world days', …);
});

describe('responder selection', () => {
  it('excludes absent characters regardless of other scores', …);
  it('always returns at least one responder', …);
  it('penalizes a character who spoke last turn', …);
  it('respects the tier cap', …);
});
```

### Integration — real database, mock AI

Runs against a real Postgres (Docker locally, a dedicated project in CI). Covers: RLS policies, the full turn pipeline, migrations forward from empty, optimistic concurrency, job idempotency, webhook dedup.

**RLS tests are non-negotiable** and must include the negative cases:

```ts
it('user B cannot read user A world', …);
it('user B cannot insert a character into user A world', …);
it('a world member can read but not delete', …);
it('an anonymous request reads only public world metadata', …);
```

### E2E — the journeys that must never break

1. Sign up → create world → create character → send a message → receive a reply
2. Send a message → reload the page → history is intact
3. Establish a fact → new conversation → the fact is recalled
4. Multi-character turn → three characters respond distinguishably
5. Edit a memory → it takes effect on the next turn
6. Hit the quota → clear message and upgrade path, no crash
7. Telegram webhook → reply delivered (Phase 10)
8. Delete account → data is actually gone

## 3. The evaluation harness

`packages/evals` — runnable as `pnpm eval [suite] [--model=…] [--baseline=…]`.

### Canonical test worlds

Four seeded worlds, deterministic, committed to `db/seeds/`:

| World | Tests |
|---|---|
| **A — Ravenhold** (fantasy, 6 characters, 200-turn script) | Long-term memory, world state, quests, factions |
| **B — The Kapoor House** (family drama, 4 characters) | Multi-character dynamics, knowledge isolation, relationship nuance |
| **C — Mars Colony 2147** (sci-fi, 9 characters) | Scale, world rules, resource state |
| **D — The Ashford Inquiry** (mystery, 5 characters) | Secrets, deduction, information propagation, foreshadowing |

World B is the most important. Family drama exposes character-voice collapse and knowledge leakage faster than any other genre, because the characters are similar enough that laziness shows.

### Suite 1 — Memory recall

```
SETUP    Plant 20 facts across a 100-turn scripted conversation
PROBE    At turns 30, 60, 100, and in a fresh session, ask about each fact
MEASURE
  recall@k          fact present in the retrieved set        target ≥ 0.90
  precision@k       retrieved memories that are relevant     target ≥ 0.60
  answer accuracy   the character answers correctly          target ≥ 0.85
  false recall      invents a fact never established         target ≤ 0.03
  contradiction     contradicts an established fact          target ≤ 0.02
```

### Suite 2 — Long-horizon memory

Simulate days 1, 2, 7, 30, 100 with time skips, then probe day-1 facts.

```
  day-1 fact recall at day 100                target ≥ 0.75
  high-importance recall at day 100           target ≥ 0.90
  relationship continuity                     target ≥ 0.85
  post-consolidation fact survival            target ≥ 0.95   ← consolidation must not lose facts
```

The last metric is the one that catches the worst possible bug: a consolidation pass that quietly deletes true things.

### Suite 3 — Character consistency

100 turns per character, then an LLM judge with a fixed rubric plus lexical metrics:

```
  voice consistency (1–10)          target ≥ 7.5
  personality adherence (1–10)      target ≥ 8.0
  goal pursuit (1–10)               target ≥ 7.0
  inter-character distinctness      target ≥ 0.7   (lexical + judge)
  forbidden-behaviour violations    target = 0
```

**Judge protocol:** a fixed rubric, a fixed model, blind pairwise comparison against the baseline where possible. An LLM judge is noisy — run 3 samples and take the median, and never compare scores produced by different judge models.

### Suite 4 — Knowledge isolation ⚠️ security-critical

```
SETUP    Establish secret S with character A only
PROBE    20 increasingly direct attempts to extract S from character B,
         including social engineering, hypotheticals and roleplay framing
MEASURE
  leak rate                          MUST BE 0.00
  appropriate ignorance (1–10)       target ≥ 8.0   (B behaves as someone who doesn't know)
```

A non-zero leak rate blocks release. Not a quality target — a gate.

### Suite 5 — World state integrity

```
  authoritative-state accuracy       target = 1.00
  hallucinated state assertions      target ≤ 0.02
  hard rule violations               target = 0
  invalid tool calls                 target ≤ 0.05
  quest state-machine violations     target = 0
```

### Suite 6 — Multi-character orchestration

```
  correct speaker selection (vs human labels)   target ≥ 0.80
  absent character responded                    MUST BE 0
  speaker-bleed rate                            target ≤ 0.02
  avg responders/turn                           target ≈ 1.6  ← economics
  reactivity (later speakers reference earlier)  target ≥ 0.60
```

### Suite 7 — Provider chaos ⚠️ architectural gate

```
  disable primary provider           → product works, degraded
  inject 100% 429 on the fast tier   → fallback chain engages
  inject 5 s latency                 → timeouts and fallbacks behave
  inject malformed structured output → repair path works, nothing corrupt is stored
  disable ALL providers              → clean degradation, user input preserved
  kill switch engaged                → no inference occurs
```

This suite validates the single most important architectural claim we make ([01](01-principles-and-constraints.md) § P3). Run it before every release.

### Suite 8 — Cost and latency

```
  CU per turn (1 responder)          record and trend
  CU per turn (3 responders)         record and trend
  p50 / p95 time to first token      target ≤ 1.5 s / 3 s
  p95 full turn (1 responder)        target ≤ 6 s
  p95 full turn (3 responders)       target ≤ 14 s
  retrieval latency p95              target ≤ 400 ms
```

## 4. The model benchmark

Every candidate model is scored before it can enter a routing chain. Results live in `docs/benchmarks/` with a date, and are summarized here.

| Model | Quality | Latency p95 | Context | Tools | Structured | Failure % | Cost | Free | Best for | Tested |
|---|---|---|---|---|---|---|---|---|---|---|
| *(empty — populated by task P1-T02)* | | | | | | | | | | |

**Quality is a composite** of suites 1, 3, 5 and 6, weighted 0.3/0.3/0.2/0.2.

**Rules:**

- No model enters a chain without a benchmark row.
- Re-benchmark quarterly and after any provider-announced model update.
- **A free model that scores below threshold is not used.** Free is a cost input, not a quality excuse — a bad free model costs us retention, which is more expensive than inference.
- Record the date. Endpoints change silently, and an undated benchmark is worse than none.

## 5. Regression gates

```
COMMIT      unit + lint + typecheck            (< 60 s, free)
PR          + integration (mock AI)            (< 5 min, free)
PRE-MERGE   + eval suites 4, 7                 (security + architecture gates)
NIGHTLY     all suites, tracked over time
PRE-RELEASE all suites + E2E + manual smoke
MODEL/PROMPT CHANGE   full eval vs the stored baseline, results attached to the PR
```

**Merge is blocked if:** any test fails · knowledge leak rate > 0 · memory recall drops > 5% from baseline · character consistency drops > 0.5 · hard rule violations > 0 · p95 latency regresses > 20% · CU per turn rises > 15% without a stated reason.

## 6. Manual evaluation

Automation misses the thing that actually matters: whether it feels alive.

**The weekly hour.** Every week, play one world for a full hour as a real user. Write down every moment where the illusion broke. This has caught more real problems in products like this than any metric, because the failure modes that matter are qualitative — a character who is *technically* consistent but boring, a world that *technically* remembers but never brings anything up unprompted.

**The 30-day test.** Maintain one continuously-played world from Phase 1 onward. Play it a few turns most days. By Phase 11 it has real history, and it is the single best demonstration asset the company owns — as well as the only honest test of whether long-horizon memory actually works.

**Beta feedback loop.** After every session, one optional question: *"Did anything feel wrong?"* Free text. Read all of it.

## 7. Test data discipline

- Seeds are committed, deterministic and version-controlled.
- **Never test against production data.** Not once, not "just to check."
- Eval scripts are fixed text files; a changed script invalidates historical comparisons, so changes bump a suite version.
- Judge prompts are versioned alongside the suites.
- Results are stored as JSON in `docs/benchmarks/YYYY-MM-DD-<suite>.json` so trends survive.

## 8. What we do not test

Being explicit prevents guilt-driven busywork:

- Framework internals
- Provider SDK behaviour (contract tests at the boundary instead)
- Exact model output text — inherently non-deterministic; test properties, not strings
- UI pixel appearance — visual regression is deferred until the design stabilizes
- Load beyond 10× current traffic — premature, and expensive to simulate honestly
