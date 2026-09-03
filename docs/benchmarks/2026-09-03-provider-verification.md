# P1-T02 — Empirical Provider Verification

> **Run:** 2026-09-03 · `pnpm exec tsx scripts/verify-providers.ts` · **11/12 checks passed**
>
> Every capability we route on is confirmed by an actual API call, not by reading
> a documentation table. Docs matrices are routinely ahead of reality, and a
> capability we assume but do not have becomes a runtime failure in the extraction
> path — where the cost is corrupt memory, not a clean error.

---

## Results

### Groq — ✅ fully verified, primary provider confirmed

| Check | Result |
|---|---|
| Auth + catalogue | ✅ 14 models visible |
| `openai/gpt-oss-120b` present | ✅ |
| `openai/gpt-oss-20b` present | ✅ |
| `qwen/qwen3.6-27b` present | ✅ |
| Chat completion | ✅ 262 ms · in 76 tok / out 10 tok |
| **Tool calling** | ✅ 1 tool_call returned |
| **JSON mode (`response_format`)** | ✅ **valid JSON returned** |

**The significant finding: Groq supports `response_format` natively.**

The provider-landscape research recorded this as unverified, and both Nemotron
endpoints lack it — which is why [08](../08-ai-router.md) § 9 specifies a
tool-calling fallback for structured output. That fallback is still required for
OpenRouter, but on our **primary** provider extraction can use native JSON mode.

Practical consequence: the `extract` path gets schema-enforced output rather than
prompted-JSON-plus-tolerant-parsing on the majority of traffic. The tolerant
parser and repair path stay — they are needed for the deep tier and as a
safety net — but they stop being the common case.

**262 ms for a trivial completion** is a genuinely good latency baseline, well
inside the < 2 s fast-tier target in [08](../08-ai-router.md) § 2.

### Cloudflare Workers AI — ❌ token invalid

| Check | Result |
|---|---|
| `bge-base-en-v1.5` embeddings | ❌ HTTP 401, code 10000 |
| `/user/tokens/verify` | ❌ code **1000 — Invalid API Token** |
| Account access | ❌ code 9109 |

Code **1000** means the token string itself is not recognised — this is *not* a
missing-permission error (which surfaces as 9109 alone, with the token still
verifying). The token was transcribed from a screenshot; a single misread
character produces exactly this. **Needs re-supplying as text.**

Nothing downstream is blocked in the meantime: the memory loop runs on the mock
embedder, and retrieval degrades to keyword + structural rather than failing
([04](../04-memory-engine.md) § 11) — a property now demonstrated rather than
merely asserted.

### OpenRouter — ✅ verified

| Check | Result |
|---|---|
| Auth + quota | ✅ usage 0 |
| `nvidia/nemotron-3.5-lightning:free` | ✅ reachable, 734 ms |

Only one model probed deliberately: the free tier is 50 requests/day and a
verification script must not consume a meaningful share of it.

### Gemini — ✅ reachable · **development only**

50 models visible. Hard-blocked from production by `checkPoolEligibility()`
(ADR-009): trains on submitted content, explicitly warns against personal data.

### NVIDIA NIM — ✅ reachable · **development only**

81 models visible. Hard-blocked from production by `checkPoolEligibility()`
(ADR-013): API Trial ToS §1.2/§1.4 forbid production use outright, independently
of the privacy question.

---

## Actions arising

- [ ] **Re-supply `CF_API_TOKEN` as text** and re-run. Blocks P1-T07.
- [ ] Enable **Zero Data Retention** in the Groq console before any real user
      traffic. Gate A checklist item.
- [ ] Enable the **training opt-out** in OpenRouter settings, and re-verify that
      the Nemotron `:free` endpoints remain reachable afterwards — opting out
      excludes providers that train, which may remove endpoints.
- [ ] Update [08](../08-ai-router.md) § 9: native JSON mode is the primary
      structured-output strategy on Groq; tool-calling remains the fallback for
      OpenRouter and any model without `response_format`.

## Model benchmark table

Quality scores require eval suites 1 and 3 (P1-T14/T15), which need the real
embedding provider. Capability columns are verified; quality columns are not yet
populated, and **a model without a quality score is not routable in production**
([08](../08-ai-router.md) § 4).

| Model | Provider | Tier | Tools | JSON mode | Latency | Free | Quality | Verified |
|---|---|---|---|---|---|---|---|---|
| `openai/gpt-oss-120b` | Groq | standard | ✅ | ✅ | 262 ms | ✅ | — | 2026-09-03 |
| `openai/gpt-oss-20b` | Groq | fast | ✅ | ✅ | — | ✅ | — | 2026-09-03 |
| `qwen/qwen3.6-27b` | Groq | standard | ✅ | ✅ | — | ✅ | — | 2026-09-03 |
| `nvidia/nemotron-3.5-lightning:free` | OpenRouter | fast | ✅ | ❌ | 734 ms | ✅ | — | 2026-09-03 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter | deep | ✅ | ❌ | — | ✅ | — | not probed |
| `@cf/baai/bge-base-en-v1.5` | Cloudflare | embed | — | — | — | ✅ | — | **failed** |
