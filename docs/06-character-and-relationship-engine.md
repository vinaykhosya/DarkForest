# 06 — Character & Relationship Engine

> The social layer. Owns who a character is, what they know, and how they feel.
> **Status:** Authoritative.

---

## 1. What makes a character feel real

Three properties, in order of impact. Most products deliver only the first.

1. **Consistency** — they speak and decide the same way across months.
2. **Ignorance** — they do not know what they were not told. This is the property that most convinces users the world is real, and the one almost no product implements.
3. **Change** — their feelings move as a result of what happens, in a direction a human observer would agree with.

Everything in this document serves one of those three.

## 2. Character composition

```
character
├── identity        name, role, appearance, alive, active
├── profile         personality, traits, speech_style, values, fears, backstory
├── voice           example_lines[]  ← few-shot anchors
├── constraints     forbidden[]      ← things this character never does
├── goals           immediate / short_term / long_term / hidden
├── secrets         with severity and reveal conditions
├── knowledge       character_knowledge rows — what they know, and how they learned it
├── relationships   directional, multi-dimensional
└── dynamics        talkativeness, current emotional state
```

### The voice anchor

`example_lines` is the highest-leverage field in the entire character model, and the one users skip. Three or four lines of actual dialogue do more for consistency than three paragraphs of personality description, because they demonstrate rhythm, vocabulary and register rather than describing them.

**Product consequence:** the character editor should *require* at least two example lines before a character can be used, and the guided creator must generate them. Treat an empty `example_lines` as an incomplete character.

### `forbidden` is a hard constraint

`forbidden: ["never swears", "never breaks a promise", "never speaks about her sister"]`

Stated in the prompt, and — for the subset that is machine-checkable — verified in output moderation. A character who breaks their own stated rules is the fastest way to lose a user's belief in the world.

## 3. Knowledge isolation

The mechanism lives in [04](04-memory-engine.md) § 5. This section covers the *rules* for populating it.

### Default visibility

| Situation | Who learns it |
|---|---|
| Said aloud in a scene | Every character in `present_character_ids` |
| Said in private (2 participants) | Only those two |
| Whispered / aside | Only the addressed character |
| Witnessed action | Every present character |
| Off-screen world event | Nobody, until told or discovered |
| Explicitly told later | The told character, `source = 'told'` |
| Inferred | `source = 'inferred'`, `certainty < 1.0` |

### Information propagation

Characters can tell each other things. When character A tells character B a fact:

```
INSERT INTO character_knowledge (character_id, memory_id, source, certainty, learned_at_day)
VALUES (B, memory, 'told', A_certainty × 0.9, current_day);
```

Certainty decays by 10% per hop. Third-hand information is uncertain information, and a character with `certainty = 0.7` should hedge — *"I heard that…"* — rather than assert. This is stated in the prompt alongside the memory's certainty value.

Propagation happens through:
1. **Explicit** — a tool call, `share_knowledge(from, to, memory_id)`.
2. **Implicit** — the extraction job records who was present when a fact was established.
3. **Never automatic across scenes.** A character does not learn something because it is "in the world."

### The leakage test

Run continuously in evals ([15](15-testing-and-evaluation.md)): establish a secret with character A, then interrogate character B about it across 20 turns using increasingly direct probes. B must never confirm it. A leak is a **P1 bug**, not a quality issue.

## 4. Relationship dimensions

Eight dimensions, directional, `−100..100` (`familiarity` is `0..100`).

| Dimension | Meaning | Moves on |
|---|---|---|
| `trust` | Will they rely on you | Kept/broken promises, honesty, betrayal |
| `affection` | Do they like you | Kindness, shared time, cruelty |
| `respect` | Do they regard you as capable | Competence, courage, cowardice |
| `fear` | Do they feel threatened | Violence, power displays, threats |
| `romance` | Attraction | Romantic action — **gated, see § 7** |
| `loyalty` | Will they stay when it costs them | Sacrifice, defence, abandonment |
| `hostility` | Active antagonism | Insults, harm to their interests |
| `familiarity` | How well they know you | Every interaction, monotonically |

### Directional by design

`Elena → User (trust 82)` and `User → Elena (trust 94)` are separate rows with separate values. Unrequited feeling is the source of most interesting drama, and symmetric relationships cannot express it.

### Not every character needs all eight

A shopkeeper needs `familiarity`, `trust`, `respect`. A rival needs `hostility`, `respect`, `fear`. Unused dimensions stay at 0 and are **omitted from the prompt** — sending eight zeros teaches the model nothing and costs tokens.

### Derived labels

The UI and prompts use a derived label, not raw numbers, because *"wary ally"* conveys more to both a human and a model than *"trust 34, hostility 12."*

```
label = f(trust, affection, hostility, romance, familiarity)

trust > 70 ∧ affection > 60          → "close friend"
trust > 70 ∧ romance > 60            → "beloved"
trust > 40 ∧ hostility < 20          → "ally"
|trust| < 20 ∧ familiarity < 30      → "stranger"
hostility > 50 ∧ respect > 50        → "worthy rival"
hostility > 70                       → "enemy"
trust < −50                          → "betrayed"
fear > 60                            → "terrified of you"
```

Labels are cached in `relationships.status_label` and recomputed on write. Both the number and the label go into the prompt — the label for interpretation, the number for gradation.

## 5. Relationship dynamics

### Delta sources, in precedence order

1. **Deterministic rules** — a small table of unambiguous triggers. Free, instant, consistent.
2. **Model proposal** — `update_relationship` tool call with a required `reason`.
3. **Decay** — background drift toward baseline over world time.

Deterministic rules run first and are cheaper; the model handles nuance.

```
Saved from danger        trust +8   respect +5   loyalty +3
Kept a promise           trust +6   respect +3
Broke a promise          trust −10  respect −4
Lied (discovered)        trust −12  respect −5
Betrayed                 trust −30  respect −10  hostility +20  loyalty −25
Defended publicly        trust +5   affection +6 loyalty +5
Gave a meaningful gift   affection +5
Insulted                 affection −6  hostility +5
Threatened               fear +12  hostility +8  affection −5
Ignored when in need     trust −6  affection −5
Shared a vulnerability   affection +4  familiarity +6
Any interaction          familiarity +1  (capped at 100)
```

### Caps and damping

- **Per-turn cap:** ±15 on any dimension. A single sentence does not move someone 60 points.
- **Diminishing returns near the extremes:** effective delta scales by `(1 − |current| / 100)^0.5`. Going from 90 to 95 trust is much harder than from 10 to 15.
- **Asymmetry:** trust falls faster than it rises. Negative deltas apply at full magnitude; positive deltas above `trust = 60` apply at 0.7×. This matches how people actually work and makes high trust feel earned.

### Decay

On time passage, each dimension drifts toward a per-character baseline:

```
value += (baseline − value) · (1 − exp(−days_elapsed / τ))
τ = 60 world days;  familiarity does not decay
```

Decay is what makes returning after an absence *mean* something. It must be gentle: a user who returns after two weeks should find a slightly cooler Elena, not a stranger.

### Explainability

Every delta writes a `relationship_events` row with a `reason`. This powers:

- The relationship timeline in the UI — *"Day 91: Marcus was betrayed. Trust −30."*
- The answer to *"why does she hate me?"*
- Debugging when the model proposes deltas that make no sense

**A delta without a reason is rejected.** No exceptions.

## 6. Emotional state

Distinct from relationships: relationships are durable, emotion is momentary.

```
character_emotional_state (in-memory / conversation-scoped, not a durable table at MVP)
  mood:      calm | anxious | angry | joyful | grieving | suspicious | affectionate
  intensity: 0..1
  cause:     "The user announced he is leaving tomorrow."
  decays over ~5 turns unless reinforced
```

Kept out of the database at MVP deliberately — it is derived from the last few turns and does not need to survive a session. It enters the prompt as one line: *"Elena is currently anxious (0.7) because the user announced he is leaving."*

## 7. Romance gating

The `romance` dimension is subject to explicit constraints, enforced in code, not prompt:

- Does not move without sustained mutual `affection` and `trust` (both > 50).
- Cannot exceed the world's `content_rating` ceiling.
- Never applies to characters described as minors — this is validated at character creation and is a hard block, not a preference. See [13](13-moderation-and-policy.md) § Prohibited.
- Rate-limited: at most +8 per world day.

The purpose is not prudishness. It is that unearned romantic escalation is the most common way an AI roleplay product becomes uninteresting — and, separately, the fastest way to acquire legal exposure.

## 8. Character creation

**Guided:** the user gives a name and a one-line concept. One deep-tier call produces personality, traits, speech style, backstory, 3 goals, 1–2 secrets, 4 example lines and initial relationships to existing characters. The user reviews and edits before save.

**Manual:** direct form entry.

**Import:** a Phase 15 concern. If character-card import is added, treat every field as untrusted user content ([09](09-context-builder-and-prompts.md) § Injection Defense) — imported cards are a known prompt-injection vector.

### Quality validation at creation

| Check | Enforcement |
|---|---|
| Personality ≥ 100 chars | Warn |
| ≥ 2 example lines | **Block** |
| ≥ 1 goal | Warn |
| Not near-duplicate of an existing character in this world (cosine < 0.9) | Warn |
| Not described as a minor if the world rating allows romance | **Block** |
| Passes creation-time moderation | **Block** |

## 9. Interface

```ts
interface CharacterEngine {
  getForPrompt(characterId: string, ctx: TurnContext): Promise<CharacterPromptData>;
  getKnowledge(characterId: string, opts: KnowledgeQuery): Promise<KnowledgeRow[]>;
  shareKnowledge(from: string, to: string, memoryId: string): Promise<void>;
  validate(input: CharacterInput): Promise<ValidationResult>;
}

interface RelationshipEngine {
  get(worldId: string, from: EntityRef, to: EntityRef): Promise<Relationship>;
  getAllFor(worldId: string, entity: EntityRef): Promise<Relationship[]>;
  applyDeltas(input: {
    worldId: string; turnId: string;
    deltas: RelationshipDelta[];      // each REQUIRES a reason
    source: 'model' | 'rule' | 'decay' | 'manual';
  }): Promise<RelationshipUpdate[]>;
  decay(worldId: string, daysElapsed: number): Promise<void>;
  timeline(relationshipId: string, limit: number): Promise<RelationshipEvent[]>;
}
```

## 10. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Character drifts out of personality | Consistency eval score drop | Increase `example_lines` weight in the prompt; check whether the profile is being truncated by the budget |
| All characters sound identical | Human review; lexical-diversity metric across speakers in a turn | Voice anchors missing or dropped. This is usually a context-budget bug, not a model quality problem. |
| Relationship values saturate at ±100 | Metric on distribution | Damping is not applied. Check the diminishing-returns term. |
| Model proposes absurd deltas (trust −80 for a greeting) | Cap triggers | Capped and logged. Recurring → the reason field in the prompt is unclear. |
| Knowledge leak | Leakage eval | **P1.** Halt, reproduce, fix the isolation query, add regression case. |
| Character responds while absent from the scene | Orchestrator test | Presence filter bypassed. **P1.** |
