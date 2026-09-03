# Operating Rules — Dark Forest

Instructions for anyone working in this repository, human or AI. Read this before touching anything.

---

## 1. Orient yourself first

Before any work, in this order:

1. [workflow/PROGRESS.md](workflow/PROGRESS.md) — where we are, what is next
2. [workflow/TASKS.md](workflow/TASKS.md) — the task board
3. [workflow/WORKFLOW.md](workflow/WORKFLOW.md) — the current phase's gate
4. The relevant spec in `docs/`

**Do not start work that is not a task on the board.** If it should be done, add it as a task first. This is not bureaucracy — it is how a plan survives contact with a hundred small good ideas.

## 2. Document authority

```
docs/00-product-identity.md          ← wins over everything
docs/01-principles-and-constraints.md ← vetoes any design that violates it
docs/02 … 19                          ← authoritative in their domain
workflow/DECISIONS.md                 ← records every reversal
workflow/WORKFLOW.md                  ← the build order
```

Conflict resolution: lower number wins. If a spec contradicts an ADR, the ADR wins if it is newer. If you find a genuine contradiction, **stop and resolve it in the document** — do not resolve it silently in code. A contradiction resolved in code is a decision nobody can find later.

## 3. The phase discipline

- Work only on the current phase, unless a task explicitly says otherwise.
- **Never skip a gate.** A gate marked passed while failing corrupts every downstream decision.
- If a gate fails, the response is *fix*, not *proceed*. This applies most to Phases 1, 4 and 11.
- If you are tempted to build something from a later phase, re-read [01](docs/01-principles-and-constraints.md) § Part D.

## 4. Before writing any feature

Answer all ten questions from [01](docs/01-principles-and-constraints.md) § Part D on the task card. In particular:

- What happens when it fails?
- Can it be tested with `MOCK_AI=true`?
- What does it cost in compute units?
- What does it prevent us from building later?

An unanswerable question means the feature is not ready to build.

## 5. Hard rules — violating these is a bug, not a style preference

| Rule | Where |
|---|---|
| No model name outside `config/models.json` | [08](docs/08-ai-router.md) |
| No vendor SDK outside `modules/ai/providers/**` | [08](docs/08-ai-router.md) |
| No cross-module imports of `repo.ts` or `service.ts` | [02](docs/02-system-architecture.md) |
| No secret in client code, logs or error messages | [12](docs/12-security.md) |
| No message content, memory content or prompt in any log | [12](docs/12-security.md) § 7 |
| No AI call without prior admission control | [14](docs/14-billing-and-entitlements.md) § 3 |
| No unvalidated model output written to the database | [08](docs/08-ai-router.md) § 9 |
| No state mutation outside `worldEngine.applyMutations` | [05](docs/05-world-engine.md) § 11 |
| No knowledge filtering in application code — it happens in SQL | [04](docs/04-memory-engine.md) § 5 |
| No relationship delta without a reason | [06](docs/06-character-and-relationship-engine.md) § 5 |
| No public table without RLS | [03](docs/03-data-model.md) § 11 |
| No prompt change without an eval comparison | [15](docs/15-testing-and-evaluation.md) § 5 |
| No offset pagination | [10](docs/10-api-contracts.md) § 1 |

## 6. Code conventions

- **TypeScript strict.** No `any`. No `@ts-ignore` without a comment explaining why.
- **Pure logic in `packages/core`** — no I/O, so it is trivially testable. Scoring, ranking, budgeting and delta rules all belong there.
- **Module shape is uniform:** `index.ts` (public), `service.ts` (logic), `repo.ts` (SQL), `routes.ts` (HTTP), `types.ts`.
- **Contracts first.** Define the Zod schema in `packages/contracts` before implementing either side.
- **Errors are typed and use the envelope** from [10](docs/10-api-contracts.md) § 2. Never throw a bare string.
- **Every async operation has a timeout.** No exceptions.
- **Every background job is idempotent.** Assume it runs at least twice.
- **Comments explain *why*, never *what*.** The code says what.

## 7. Testing expectations

| Change | Required |
|---|---|
| Pure logic in `core` | Unit tests, including edge cases |
| Repository / SQL | Integration test against a real database |
| RLS policy | Negative test — verify the *unauthorized* path fails |
| Prompt | Eval comparison against the previous version |
| Model or routing change | Full eval suite vs baseline |
| API endpoint | Contract test |
| Critical journey | E2E test |

`pnpm test` must pass before any commit. It runs with `MOCK_AI=true` and must be free and offline.

## 8. When to stop and ask

Stop and ask the founder when:

- A specification is ambiguous in a way that changes the implementation materially
- Two documents contradict each other
- A task requires spending money
- A task requires an open decision (D-001 … D-006) to be resolved
- A gate appears to fail
- Something discovered in the code contradicts a document
- A change would violate a § 5 hard rule

Do **not** stop to ask about: naming, file layout inside a module, test structure, or anything already specified. Read the spec; it probably answers it.

## 9. Session hygiene

At the end of every session:

1. Update task statuses in [TASKS.md](workflow/TASKS.md)
2. Append an entry to [PROGRESS.md](workflow/PROGRESS.md) using the template there
3. Record any new decision in [DECISIONS.md](workflow/DECISIONS.md)
4. Leave the working tree clean, or note explicitly what is half-finished and where

Skipping step 2 is the most common way a solo project loses a week.

## 10. Things that are easy to get wrong here

Collected because each has a real cost and a non-obvious cause:

- **Webhooks must ACK before processing.** Telegram retries on non-2xx; a slow handler produces duplicate turns.
- **Knowledge isolation is a `WHERE` clause, never a prompt instruction.** Models leak under pressure; SQL does not.
- **`ctx.waitUntil()` is best-effort.** The `jobs` table is the guarantee. Never rely on `waitUntil` alone for anything that matters.
- **The free-tier CPU limit is CPU, not wall clock.** Waiting on a model is free; parsing a large JSON blob is not.
- **A 429 must not trigger a same-model retry.** It wastes the latency budget and can extend the cooldown.
- **Sequential generation is deliberate.** Parallelizing it is 3× faster and destroys the reactivity that is the entire point.
- **Prefer quest predicates over model-judged completion.** A machine-checkable quest is one the model cannot get wrong.
- **Never regenerate around a minor-safety block.** Other blocks retry with a constraint; that one does not.
- **Degrade before refusing.** A shorter reply keeps a session alive; a wall ends it.

## 11. The test that outranks everything

> Does this make it more likely that one person cares deeply about one persistent world?

If the answer is no, it does not belong in the current phase — however clever, however easy, however much you want to build it.
