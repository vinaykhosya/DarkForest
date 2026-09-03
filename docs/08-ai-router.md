# 08 — AI Router

> The compute layer. One chokepoint through which every token passes.
> **Status:** Authoritative for the interface and the selection algorithm. The model registry is *configuration* and changes without an ADR.

---

## 1. Mandate

The router exists so that four things are true:

1. **No module knows which model it is talking to.** Model choice is a runtime decision.
2. **No single provider's disappearance causes an outage.** Only a quality degradation.
3. **No token is spent without being metered first.**
4. **Model changes are configuration, not code changes.**

Requirement 2 is not hypothetical. Free endpoints are withdrawn, rate-limited and renamed with no notice. The architecture assumes this is normal operating condition, not an incident.

## 2. Model tiers — the abstraction that matters

Application code **never** names a model. It names a **task class**, and the router maps task class → tier → concrete model.

| Tier | Purpose | Latency target | Relative cost |
|---|---|---|---|
| `fast` | Classification, extraction, planning, short reactions, moderation | < 2 s | 1× |
| `standard` | Ordinary character dialogue — the bulk of all traffic | < 5 s | 3× |
| `deep` | Complex reasoning, world generation, consolidation, long-context synthesis | < 20 s | 10× |

### Task class → tier mapping

| Task class | Default tier | Notes |
|---|---|---|
| `moderate` | fast | Cheapest possible; heuristics first |
| `classify` | fast | Intent, emotion, addressing ambiguity |
| `plan` | fast | Only when § 07 selection is ambiguous |
| `extract` | fast | Memory extraction — structured output required |
| `dialogue` | standard | The default path |
| `dialogue_reaction` | fast | 2nd/3rd responder in a turn |
| `narrate` | standard | |
| `world_create` | deep | High-intent, worth spending on |
| `character_create` | deep | |
| `consolidate` | deep | Background; latency irrelevant |
| `reflect` | deep | Background |
| `summarize_chapter` | deep | Background |
| `dialogue_deep` | deep | User explicitly requests, or a dramatic beat is detected |

**Upgrades** happen when: the user's plan permits *and* the turn is flagged significant (a major event, a chapter climax, an unusually complex user message), or the user explicitly requests deeper generation.

**Downgrades** happen when: the compute budget is low, the tier's models are all unhealthy, or the turn is a routine reaction.

## 3. The provider interface

```ts
// packages/contracts/ai.ts — the ONLY AI surface the rest of the app sees.

export interface AIProvider {
  readonly id: string;                     // 'openrouter' | 'gemini' | 'mock' | …
  readonly models: ModelDescriptor[];

  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncGenerator<StreamChunk, GenerateResponse>;
  health(): ProviderHealth;
}

export interface ModelDescriptor {
  id: string;                              // provider-native id
  tier: 'fast' | 'standard' | 'deep';
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  costPerMTokIn: number;                   // micro-rupees; 0 for free endpoints
  costPerMTokOut: number;
  isFree: boolean;
  rateLimit?: { rpm?: number; rpd?: number; tpm?: number };
  qualityScore?: number;                   // 0..10, from our own eval suite
}

export interface GenerateRequest {
  taskClass: TaskClass;
  messages: ChatMessage[];
  system: string;
  tools?: ToolDefinition[];
  responseSchema?: JSONSchema;             // structured output
  maxTokens: number;
  temperature: number;
  stopSequences?: string[];
  timeoutMs: number;
  // Routing metadata — never sent to the provider
  meta: { userId: string; worldId?: string; turnId?: string; requestId: string };
}
```

**Enforced by lint rule:** no file outside `modules/ai/providers/**` may import a vendor SDK or reference a concrete model id.

## 4. Model registry

The registry is **data**, loaded from configuration and overridable at runtime without a deploy.

```jsonc
// config/models.json — illustrative shape. Every entry below is UNVERIFIED
// and must be confirmed against the provider's live catalogue in Phase 1 (task P1-T02).
{
  "providers": {
    "openrouter": {
      "enabled": true,
      "baseUrl": "https://openrouter.ai/api/v1",
      "keyEnv": "OPENROUTER_API_KEY",
      "models": [
        { "id": "<fast-free-model>",     "tier": "fast",     "isFree": true,
          "supportsTools": true,  "supportsStructuredOutput": true },
        { "id": "<deep-free-model>",     "tier": "deep",     "isFree": true,
          "supportsTools": true,  "contextWindow": 1000000 },
        { "id": "<standard-free-model>", "tier": "standard", "isFree": true }
      ]
    },
    "gemini":  { "enabled": false, "keyEnv": "GEMINI_API_KEY",  "models": [] },
    "mock":    { "enabled": true,  "models": [{ "id": "mock", "tier": "fast" }] }
  },
  "chains": {
    "fast":     ["openrouter:<fast-free>", "gemini:<free-tier>", "openrouter:<alt-free>", "mock"],
    "standard": ["openrouter:<standard-free>", "openrouter:<fast-free>", "gemini:<free-tier>"],
    "deep":     ["openrouter:<deep-free>", "openrouter:<standard-free>", "gemini:<free-tier>"]
  }
}
```

> **Honest note on model selection.** The blueprint names specific NVIDIA Nemotron free endpoints as the intended fast and deep models. Those specific endpoints, their context windows, their tool-calling support and their free status **have not been verified inside this repository** and post-date the assistant's training data. Task **P1-T02** is to verify them against the live provider catalogue and record the result in [DECISIONS.md](../workflow/DECISIONS.md).
>
> This is exactly the situation the router is designed for: the names go in a config file, the benchmark ([15](15-testing-and-evaluation.md)) decides whether they earn their tier, and if they vanish the chain moves on. **No code anywhere should contain a model name.**

### Registry entry requirements

A model may not enter a chain until it has:

- [ ] Been benchmarked on the eval suite with a recorded quality score
- [ ] Had its tool-calling and structured-output support verified empirically, not from documentation
- [ ] Had its real rate limits observed under load
- [ ] A recorded cost, even if that cost is zero

## 5. Selection algorithm

```
select(taskClass, user) →
  1. tier      = taskMap[taskClass]
  2. tier      = adjustForEntitlements(tier, user)      // free tier may be capped below 'deep'
  3. tier      = adjustForBudget(tier, user)            // low budget → downgrade
  4. chain     = chains[tier]
  5. candidates = chain.filter(m =>
                    provider.enabled
                    && health(m).state !== 'open'       // circuit breaker
                    && withinRateLimit(m)
                    && satisfiesCapabilities(m, req))   // tools? structured output?
  6. if candidates empty → drop one tier and retry (fast → mock)
  7. return candidates[0]
```

**Capability filtering (step 5) is where naive routers break.** If the request needs structured output and the next model in the chain does not support it, falling back to that model produces unparseable garbage. The chain must skip it, or fall back to a prompt-based JSON strategy with stricter validation.

## 6. Fallback and retries

```
attempt(model):
  ├─ 200 OK ─────────────────────▶ record success, return
  ├─ 429 rate limited ───────────▶ mark model cooling; NEXT MODEL immediately (no retry)
  ├─ 5xx ────────────────────────▶ retry once w/ jitter; then next model
  ├─ timeout ────────────────────▶ next model (do not retry the same one)
  ├─ malformed structured output ▶ ONE repair attempt, same model; then next model
  └─ content filter refusal ─────▶ do NOT retry elsewhere; surface as a policy outcome
```

Rules:

- **429 never triggers a same-model retry.** On free endpoints a 429 means the window is exhausted; retrying wastes latency budget and can extend the cooldown.
- **Total attempts per logical request: 3.** After that, the degradation ladder ([16](16-observability-and-ops.md)) applies.
- **Every attempt writes a `model_requests` row**, including failures. Failure data is what lets us rank providers honestly.
- **A provider's content refusal is not a routing failure.** Do not shop the request around providers looking for one that complies — that is both a policy violation and a way to end up with the worst provider handling our most sensitive traffic.

### Circuit breaker

Per model, sliding 5-minute window:

```
closed    → normal
open      → ≥5 failures AND ≥50% failure rate. Skip for 60 s.
half_open → after cooldown, allow 1 probe. Success → closed. Failure → open, 2× cooldown (cap 15 min).
```

Breaker state lives in Cloudflare KV so it is shared across Worker isolates. A per-isolate breaker is nearly useless at the edge.

### Rate-limit accounting

For each free model, track observed limits in KV with a token-bucket per `(model, window)`. **Pre-emptively skip** a model whose bucket is empty rather than spending a round-trip to learn it is 429. Free endpoints are the common case, so this saves real latency.

## 7. Budget integration

Before any call:

```
1. resolve entitlements                          (billing)
2. estimate compute units for (tier, maxTokens)
3. reserve units atomically                      → insufficient? downgrade tier, re-estimate
4. still insufficient?                           → REFUSE with QUOTA_EXCEEDED, zero tokens spent
5. call
6. reconcile actual vs reserved                  (deferred, § 02 step 12)
```

Compute-unit costs in [14](14-billing-and-entitlements.md). Reservation is atomic and precedes the network call — post-hoc accounting cannot stop a runaway loop.

## 8. Caching

| Cache | Key | TTL | Saves |
|---|---|---|---|
| Embeddings | `sha256(text)` | ∞ | Repeated identical text across worlds |
| Moderation verdicts | `sha256(text)` | 7 d | Re-screening of retried content |
| World-creation drafts | `sha256(inputs)` | 1 h | Users regenerating identical prompts |
| System-prompt prefixes | Provider-side prefix caching where supported | — | Meaningful savings on long stable prefixes |

**Never cache character dialogue.** Identical input must not produce identical output — that is the fastest way for a user to discover the machinery.

Prompt structure is nonetheless ordered **stable-prefix-first** ([09](09-context-builder-and-prompts.md)) so that providers offering prefix caching can exploit it.

## 9. Structured output

For `extract`, `plan`, `classify` and `consolidate`, we need parseable JSON.

Strategy ladder, best available first:

1. **Native structured output** / JSON schema mode, when the model supports it.
2. **Tool-calling** with a single "submit" tool — often more reliable than JSON mode.
3. **Prompted JSON** with a fenced example, plus tolerant parsing (strip prose, extract the first balanced JSON object).
4. **Repair pass** — one fast-tier call: *"This should be valid JSON matching the schema. Fix it."*

Always Zod-validate the result. **Never** feed an unvalidated model object into a database write.

## 10. The mock provider

Not a test double — a **first-class provider**, and a Phase 1 deliverable.

```ts
class MockProvider implements AIProvider {
  // Deterministic, seeded by hash(taskClass + last user message + characterId)
  // - dialogue      → templated in-character line referencing a retrieved memory
  // - extract       → schema-valid memories derived from keywords in the input
  // - plan          → the first N present characters
  // - configurable  → latency, failure injection, 429 injection, malformed output
}
```

What it buys us:

- All UI development at zero inference cost
- A test suite that runs in CI in seconds, offline, for free
- Deterministic tests of the retry, fallback and circuit-breaker paths
- A working demo when every provider is down

`MOCK_AI=true` must yield a **fully functional product**. If a feature cannot be demonstrated with the mock provider, the feature has a hidden dependency on model behaviour and that is worth knowing.

## 11. Observability

Every call records ([03](03-data-model.md) `model_requests`): provider, model, tier, task class, tokens in/out, latency, TTFB, success, error code, attempt number, fallback origin, compute units, estimated cost.

Derived dashboards ([16](16-observability-and-ops.md)):

- Cost per user per day, cost per turn, cost per world
- Failure rate and fallback rate by model
- p50/p95/p99 latency by tier
- Free-quota headroom per provider
- Tier distribution — *is `deep` creeping into routine turns?*

## 12. Failure modes

| Failure | Response |
|---|---|
| All providers in a tier down | Drop a tier. If all tiers down → degradation ladder → "the world is resting" message, user input preserved, retry offered |
| Model returns empty | Treat as failure, advance the chain |
| Model ignores tools and narrates the mutation | Not persisted ([05](05-world-engine.md)). If frequent for a model, downgrade its quality score or drop it from chains needing tools |
| Latency spike on one provider | Breaker opens on timeouts; traffic shifts automatically |
| Free tier withdrawn without notice | 401/404 → provider disabled → alert → chain continues. **This must be a non-event, and there is a chaos test for it.** |
| Provider changes response format | Contract test in CI catches it before users do |
| Cost anomaly | Daily cost-per-user alert; auto-throttle at 3× baseline |
