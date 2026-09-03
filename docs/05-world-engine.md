# 05 — World Engine

> The simulation layer. It owns everything a user could argue about.
> **Status:** Authoritative.

---

## 1. Mandate

The world engine is the **only** component permitted to mutate authoritative state. It exists to make one guarantee:

> If the model says it happened, and the world engine did not record it, it did not happen.

That guarantee is what separates a persistent world from a chatbot with a good memory.

## 2. What is authoritative

| Authoritative (database) | Narrative (model) |
|---|---|
| Day, time of day, chapter | How the morning *felt* |
| Location, who is present | The description of the room |
| Flags and numerics (gold, stability, health) | Whether the coin purse feels heavy |
| Quest and step status | How the quest-giver phrases the request |
| Inventory and equipment | How a sword handles |
| Alive / dead | The manner of a death (once recorded) |
| Relationship values | The words that convey them |
| Discovered locations | What the place looks like |

**The test:** if two users could disagree about it and a screenshot would settle the argument, it belongs in the left column.

## 3. State model

State is split across three stores for good reasons:

```
world_state          ← one row, versioned, hot. Read on every turn.
  ├─ scalar fields   (day, time_of_day, location, chapter)
  ├─ flags   jsonb   ({"king_dead": true, "gate_open": false})
  └─ numerics jsonb  ({"gold": 1240, "stability": 41, "hp": 70})

world_events         ← append-only history. Never updated, never deleted.
quests / inventory   ← normalized, queried directly
```

### Why `flags` and `numerics` are jsonb

Every world declares different variables. A fantasy kingdom tracks `stability`; a Mars colony tracks `oxygen`. A fixed column set would be wrong for both.

They are still authoritative, because **writes are schema-validated**. Each world declares its variables in `world_settings.declared_flags` / `declared_numerics`:

```jsonc
{
  "gold":      { "type": "int",  "min": 0, "max": 999999, "default": 0,
                 "label": "Gold", "visible": true },
  "stability": { "type": "int",  "min": 0, "max": 100,   "default": 50,
                 "label": "Kingdom Stability", "visible": true },
  "king_dead": { "type": "bool", "default": false, "visible": false }
}
```

A tool call writing an undeclared key, a wrong type, or an out-of-range value is **rejected**. The model is told the write failed and why, and may narrate around it. It is never silently accepted.

## 4. World rules

Rules are structured rows, not a paragraph in the system prompt.

```
Magic exists but drains the caster's lifespan.        [magic,     always, hard]
The dead cannot be resurrected.                        [magic,     always, hard]
The northern kingdom is at war with Ravenhold.         [politics,  always, soft]
Only royal blood can open the ancient gate.            [magic,     contextual, hard]
  keywords: gate, ancient gate, seal, royal blood
Dragons are extremely rare — perhaps six remain.       [general,   contextual, soft]
  keywords: dragon, wyrm, drake
```

### Injection strategy

- `scope = 'always'` rules go into every prompt. **Cap at ~8**; beyond that the model starts ignoring all of them.
- `scope = 'contextual'` rules are injected only when their keywords match the current turn (user message + scene + retrieved memories).
- When the budget is tight, drop by ascending `priority`, and never drop a `hard` rule.

### Hard rules are enforced twice

A rule marked `is_hard` is stated in the prompt **and** validated in code. `"The dead cannot be resurrected"` means the `set_character_alive(true)` tool rejects a call on a character whose `is_alive` is already false, unless the world declares a resurrection mechanism.

Soft rules are tone and setting; a violation is a quality issue. Hard rules are physics; a violation is a bug.

## 5. Tool calling — the mutation path

The model never writes to the database. It requests a mutation; the backend decides.

```
Model emits tool call
        ↓
 1. Schema validation        (zod — shape, types, ranges)
 2. Existence check          (does this character/item/quest exist in THIS world?)
 3. Authority check          (may this character perform this action?)
 4. Rule check               (does a hard rule forbid it?)
 5. Plausibility check       (is the delta within per-turn caps?)
 6. Idempotency check        (has this tool_call_id already been applied?)
        ↓
   APPLY inside the turn transaction
        ↓
   Return a structured result to the model → it narrates the outcome
```

### Read tools (cheap, always available)

| Tool | Returns |
|---|---|
| `get_world_state()` | day, time, location, visible flags and numerics |
| `get_character(name)` | public profile, presence, alive status |
| `get_relationship(a, b)` | directional relationship values |
| `get_inventory(holder)` | items and quantities |
| `get_quests(status?)` | quests and current steps |
| `search_memory(query)` | scoped to the calling character's knowledge |

### Write tools (validated, capped, audited)

| Tool | Guard rails |
|---|---|
| `update_relationship(from, to, deltas, reason)` | \|delta\| ≤ 15 per dimension per turn; `reason` required |
| `set_flag(key, value)` | Key must be declared; type-checked |
| `adjust_numeric(key, delta)` | Declared, range-clamped, per-turn delta cap |
| `record_event(title, type, participants, importance)` | Always allowed; append-only |
| `start_quest(id)` / `complete_step(id)` / `complete_quest(id)` | Status transitions validated against a state machine |
| `give_item(holder, item, qty)` / `take_item(...)` | Cannot take what is not held; quantity ≥ 0 enforced |
| `move_character(name, location)` | Location must exist and be reachable |
| `advance_time(hours \| to_time_of_day)` | Only if `world_settings.allow_time_skip`; capped at 24 h per turn |
| `set_character_alive(name, alive)` | Resurrection blocked unless the world permits it |

### Per-turn mutation caps

A single turn may apply at most:

- 6 relationship deltas
- 4 numeric adjustments
- 3 flag changes
- 2 quest transitions
- 1 time advance

Exceeding a cap truncates the excess and logs a `MUTATION_CAP_EXCEEDED` warning. This bounds the damage from a confused or manipulated model to something a user can notice and report, rather than a silently rewritten world.

### Idempotency

Every tool call carries a `tool_call_id`. Applied ids are recorded for the turn. A retried generation that repeats a call does not double-apply it. **This matters because retries are normal** — free endpoints return 429 constantly.

## 6. Time

Two clocks, deliberately decoupled.

| Clock | Advances | Purpose |
|---|---|---|
| **World day** | Only via `advance_time` or scene transitions | Story chronology, memory decay |
| **Wall clock** | Real time | Session gaps, "you've been away three days" |

Their relationship is what produces the best re-engagement moment in the product:

> *"You return after three days. In Ravenhold, a week has passed. Elena stopped waiting on the fourth day."*

Advancing time triggers a **time-passage job**: relationship decay toward baseline ([06](06-character-and-relationship-engine.md) § 5), scheduled world events firing, quest deadline evaluation, and a short "what changed while you were away" summary generated at the deep tier and stored as a `world` memory.

## 7. Scenes

A scene is the current spatial and social frame. It bounds who can speak and who can hear.

```
conversations.scene_location        where we are
conversations.present_character_ids who is here
world_state.time_of_day             when it is
```

Scene transitions occur on explicit movement, time skip, or chapter break. On transition:

1. Write a scene summary into `conversations.summary`.
2. Recompute `present_character_ids`.
3. Emit a `world_event` if the transition was narratively significant.
4. Invalidate cached retrieval context.

**Presence gates hearing.** A character not in `present_character_ids` cannot respond ([07](07-multi-character-orchestration.md)) and does not learn what was said unless a later turn explicitly tells them.

## 8. Quests

Modelled as an explicit state machine so that completion is never a matter of opinion.

```
available ──start──▶ active ──all steps complete──▶ completed
    │                  │
    │                  ├──deadline passed / fail condition──▶ failed
    │                  └──user abandons──▶ abandoned
    └──never offered──▶ (stays available)
```

Steps carry both a human-readable `completion` string and an optional machine `predicate`:

```jsonc
{ "all": [
    { "flag": "murderer_identified", "equals": true },
    { "numeric": "evidence_count", "gte": 3 }
] }
```

When a predicate exists, the backend evaluates it after every turn and completes the step automatically. When it does not, the model may call `complete_step` and the backend validates that the step is `active` and belongs to an `active` quest.

> **Design rule:** prefer predicates. Every quest whose completion is machine-checkable is a quest the model cannot get wrong.

## 9. Chapters

Chapters give long worlds a spine and give us a natural summarization boundary.

A chapter advances when: the main conflict resolves, a major time skip occurs, or turn count since chapter start exceeds a threshold (default 120) *and* an open thread has closed.

On chapter close, a background job writes a chapter summary, extracts unresolved threads into the next chapter's `open_threads`, and creates a high-importance `world` memory. Older messages within the closed chapter become eligible for summarization in the rolling conversation summary.

## 10. World creation

Two paths, both landing in the same schema.

**Guided (default).** The user answers five questions — genre, premise, setting, tone, starting situation. One deep-tier generation produces a draft world: description, 6–10 rules, 3–5 characters with profiles and relationships, a starting location, an opening scene and one main quest. The user reviews and edits every part before it is saved. **Nothing is saved without review** — this is what makes the world feel authored rather than generated.

**Manual.** Direct form entry for every field.

Generation cost is capped at one deep-tier call plus one fast-tier repair call. World creation is a high-intent moment worth spending on, but it is also the easiest place to burn a day's free quota on a user who then leaves.

## 11. Interface

```ts
interface WorldEngine {
  getState(worldId: string): Promise<WorldState>;          // includes version
  getContext(worldId: string, conversationId: string): Promise<WorldContext>;

  applyMutations(input: {
    worldId: string;
    turnId: string;
    mutations: ToolCall[];
    expectedVersion: bigint;      // optimistic concurrency
  }): Promise<MutationResult>;    // { applied, rejected, newVersion }

  getRules(worldId: string, keywords: string[]): Promise<WorldRule[]>;
  advanceTime(worldId: string, spec: TimeSpec): Promise<TimePassageReport>;
  transitionScene(conversationId: string, to: SceneSpec): Promise<Scene>;
  evaluateQuestPredicates(worldId: string): Promise<QuestUpdate[]>;
}
```

`applyMutations` is the **only** exported mutation path. If another module needs to change world state, it calls this. Direct writes to `world_state` from outside `modules/worlds/repo.ts` are a CI failure.

## 12. Failure modes

| Failure | Response |
|---|---|
| Version conflict on commit | Re-read state, re-validate mutations, retry once, then `STATE_CONFLICT` to the client |
| Model calls an unknown tool | Return a structured error to the model; it usually recovers in the same turn. Log the name — a repeated unknown tool means the prompt is out of sync with the tool list. |
| Model asserts a state change in prose only | Not persisted. If it recurs for a specific action, that action needs a tool. Track via the prose-assertion detector in evals. |
| Undeclared flag written | Reject; surface to the world owner as "this world tried to track something it hasn't declared" — often a genuine authoring gap |
| Quest predicate never satisfiable | Detected by a weekly job scanning active quests with unreachable predicates; flagged to the owner |
| Time advanced absurdly (year jump) | Cap enforced; excess rejected with an explanation the model can narrate |
