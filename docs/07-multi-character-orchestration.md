# 07 — Multi-Character Orchestration

> Who speaks, in what order, knowing what.
> This is the most visible differentiator and the most expensive subsystem. Both facts drive its design.
> **Status:** Authoritative.

---

## 1. The problem

A user says one sentence into a room with four characters. The system must decide:

- Does anyone respond at all?
- Which characters?
- In what order?
- What does each of them know at the moment they speak?
- How does each one react to what the others just said?
- And it must do all of this within a cost budget, because each responder is a separate inference call.

Naively calling every character every turn is the obvious implementation. It is also 4× the cost, produces a wall of text nobody reads, and makes every scene feel like a press conference.

## 2. Cost reality

| Responders | Inference calls/turn | Relative cost | Typical UX |
|---|---|---|---|
| 1 | 1 | 1× | Focused, can feel lonely in a crowd |
| 2 | 2 | 2× | **The sweet spot** — dialogue, not monologue |
| 3 | 3 | 3× | Good for dramatic beats; tiring if constant |
| 4+ | 4+ | 4×+ | Unreadable. Reserved for deliberate crowd scenes. |

**Design target: average 1.6 responders per turn.** Not a cap — an average. Some turns have one, dramatic turns have three, and the orchestrator's job is to spend the extra calls where they matter.

This single number is the largest lever on our unit economics ([17](17-monetization-and-unit-economics.md)).

## 3. The pipeline

```
User message
     │
     ▼
┌──────────────────────┐
│ 1. Scene resolution  │  who is present, where, when
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 2. Addressing        │  was anyone named or clearly targeted?
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 3. Candidate scoring │  deterministic, free
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 4. Selection + cap   │  threshold + tier cap
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 5. Ordering          │  who speaks first
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 6. Sequential gen    │  each sees prior speakers this turn
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 7. Merge + commit    │
└──────────────────────┘
```

Steps 1–5 are **deterministic and free**. Only step 6 costs money. Keeping selection out of the model is a deliberate cost decision and also makes behaviour reproducible in tests.

## 4. Candidate scoring

Every present, active, alive character is scored:

```
score(c) = w_add · addressed(c)
         + w_pre · presence(c)
         + w_sta · stake(c)
         + w_rel · relationship_intensity(c)
         + w_tal · c.talkativeness
         + w_goa · goal_relevance(c)
         − w_cool · recency_penalty(c)
```

| Term | Weight | Definition |
|---|---|---|
| `addressed` | 0.35 | 1.0 if named or unambiguously targeted; 0.6 if the group was addressed ("everyone", "you all"); 0.0 otherwise |
| `presence` | 0.10 | 1.0 in scene, 0.0 absent. **A hard gate, not just a weight** — score 0 means excluded regardless of other terms |
| `stake` | 0.20 | Entity overlap between the user's message and the character's goals, secrets, relationships and recent memories |
| `relationship_intensity` | 0.10 | `max(|trust|, |hostility|, |romance|) / 100` — characters with strong feelings react more |
| `talkativeness` | 0.10 | Static personality trait |
| `goal_relevance` | 0.10 | Does this turn touch an active goal |
| `recency_penalty` | 0.15 | `0.5 × (turns_since_spoke ≤ 1) + 0.25 × (spoke_in_last_3)` — prevents one character dominating |

### Selection rule

```
selected = [c for c in candidates if score(c) ≥ 0.45]
sorted by score desc
truncated to min(tier_cap, world_settings.max_responders)

if selected is empty:
    if a character was addressed → force that character (score floor bypass)
    elif narration would help    → narrator responds
    else                         → highest-scoring present character responds
```

**Never return zero responders.** A user message that produces silence reads as a bug even when it is realistic.

### When the model helps

If the top two scores are within 0.05 of each other and both are below 0.6, the selection is genuinely ambiguous. Only then do we spend one **fast-tier** call on a planner that returns a responder list. This is expected on well under 10% of turns.

## 5. Ordering

Order is dramatically important — the first speaker frames the scene.

```
1. Directly addressed character always speaks first.
2. Otherwise, order by descending stake.
3. Tie-break: the character who has spoken less recently.
4. Suppression: avoid opening two consecutive turns with the same character
   unless they were directly addressed.
```

Rule 4 is small and matters a lot. Without it, the highest-talkativeness character opens every single turn and the scene develops a rut that users notice within twenty messages.

## 6. Sequential generation

Characters generate **in sequence**, each seeing what came before *in the same turn*:

```
transcript = [user_message]

for character in ordered_responders:
    ctx     = build_context(character, transcript)   # includes prior speakers this turn
    output  = ai_router.generate(ctx, task='dialogue')
    moderate(output)
    transcript.append(output)
    apply_tool_calls(output)                          # validated, per 05 § 5
```

### Why sequential and not parallel

Parallel generation is 3× faster and produces three characters talking past each other. The Daughter's line must be able to react to the Mother's. That reactivity is the entire point.

**The one exception:** when two selected characters are in different locations (a split-scene turn), they may generate in parallel because neither can hear the other. This is rare and is an optimization, not the default.

### Latency management

Sequential generation means latency is the sum of the calls. Mitigations:

- **Stream the first responder immediately.** The user starts reading while the second generates. This is the single biggest perceived-latency win available and must be in the MVP.
- **Cap responders** by tier.
- **Later speakers may use the fast tier** even when the first used deep — the reaction line is a smaller problem than the opening line.
- **Hard timeout per character** (12 s). On timeout, drop that responder and continue; a missing second speaker is far better than a stalled turn.

## 7. Context differences between speakers

Every responder receives a **different** context package. The differences are the product.

| Component | Shared | Per-character |
|---|---|---|
| World rules | ✅ | |
| World state | ✅ | |
| Scene description | ✅ | |
| This turn's transcript so far | ✅ | |
| Character profile | | ✅ |
| Retrieved memories | | ✅ — filtered by knowledge |
| Relationship state | | ✅ — this character's view only |
| Goals and secrets | | ✅ |
| Emotional state | | ✅ |

> The Son does not receive the Mother's secrets. Not because the prompt asks him to ignore them — because they were never retrieved for him.

## 8. The narrator

A special non-character responder that describes environment, transitions and outcomes. Uses world-scope visibility.

Speaks when: the scene changes, a significant time passage occurs, a physical action needs an outcome, or no character response is appropriate but silence would be wrong.

Kept short — 1–3 sentences. A verbose narrator turns dialogue into prose fiction and users disengage.

## 9. Tier caps

| Plan | Max responders/turn | Max active characters/world | Rationale |
|---|---|---|---|
| Free | 3 | 8 | Enough to demonstrate the differentiator |
| Creator | 4 | 25 | Ensemble casts |
| Pro | 6 | 43+ | Crowd scenes; genuinely more compute |
| Future | 8 | 100+ | Requires the batching work in [17](17-monetization-and-unit-economics.md) |

**Active characters ≠ responders.** A world may hold 43 characters while only 3 speak in any given turn. Character count drives context, retrieval and state cost; responder count drives inference cost. They are priced separately because they cost differently.

The "43+ character world" is a legitimate premium capability: it multiplies orchestration, retrieval and state-management work. It is compute being sold, not a feature being withheld.

## 10. Group play *(Phase 10+)*

In a Telegram group, multiple humans share one world.

Additional problems, and their resolutions:

| Problem | Resolution |
|---|---|
| Whose turn is it? | No turn order. Free-form, with a 3-second debounce so rapid messages batch into one turn |
| Who is the message addressed to? | Same addressing detection, extended to human participants |
| Message flood | Per-chat rate limit; batch multiple human messages into a single turn context |
| Bot spam in a busy group | Respond only when addressed, mentioned, or when the world state demands it |
| Whose persona acts? | Each human has their own persona in the world; `world_members` already supports this |
| Who pays? | The world owner's compute budget, with a group multiplier. Non-owners consume from their own budget when they act. |

Group play is the strongest viral surface we have, and also the easiest way to burn a free-tier quota. It ships **after** economics are instrumented (Phase 12), not before.

## 11. Interface

```ts
interface Orchestrator {
  plan(input: {
    conversationId: string;
    userMessage: string;
    maxResponders: number;
  }): Promise<ResponsePlan>;

  execute(plan: ResponsePlan): AsyncGenerator<TurnChunk, TurnResult>;
}

interface ResponsePlan {
  turnId: string;
  responders: Array<{
    kind: 'character' | 'narrator';
    id: string | null;
    score: number;
    reason: string;              // for the trace UI and for debugging
    tier: 'fast' | 'standard' | 'deep';
  }>;
  sceneSnapshot: SceneSnapshot;
  plannerUsedModel: boolean;     // was step 4 ambiguous
}
```

`reason` is stored with the turn. When a user asks *"why didn't Marcus say anything?"*, we can answer *"he wasn't in the room."*

## 12. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Same character speaks every turn | Speaker-distribution metric per conversation | Recency penalty is too low, or `talkativeness` is uniformly high |
| Nobody responds | Empty plan | Fallback ladder in § 4. Never ship silence. |
| Responder count creeping up | `avg_responders_per_turn` metric | Threshold drift. Recalibrate; this directly hits margin. |
| Characters ignore each other | Human review of transcripts | Prior-speaker transcript is not reaching the context — a builder bug |
| Absent character responds | Automated presence test | **P1.** Presence gate bypassed. |
| Turn latency > 15 s | p95 metric | Reduce cap, downgrade later speakers, verify streaming is actually enabled |
| Second responder times out | Timeout counter | Drop and continue. Log; if frequent, the tier assignment is too aggressive. |
