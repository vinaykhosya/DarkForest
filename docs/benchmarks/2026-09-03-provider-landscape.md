# Free Inference Provider Landscape — verified 2026-09-03

> **Verification method:** provider documentation and terms of service fetched directly, not blog summaries. Where a blog and a provider's own docs disagreed, the docs won — see the Cerebras note.
> **Re-verify:** monthly (task X-06), and before Phase 11 and Phase 13.

---

## Summary table

| Provider | RPM | RPD | Tokens/day | Trains on input? | Tools | Structured output | Verdict |
|---|---|---|---|---|---|---|---|
| **Groq** | 30 | **1,000** per model | 200K per model | **No** — contractual, free tier included | ✅ all models | ✅ JSON mode | **Primary** |
| **Cloudflare Workers AI** | — | 10,000 neurons | ≈1.65M embedding tokens | **No** — explicit | limited | — | **Embeddings** |
| **OpenRouter** `:free` | 20 | 50 → **1,000** with $10 lifetime credit | no token cap | opt-out setting available | ✅ | ❌ no `response_format` | **Deep tier** |
| Google Gemini | varies | ~1,500 | generous | **Yes** — explicit warning | ✅ | ✅ | **Dev only** |
| NVIDIA NIM (direct) | 40 | credits-based; free models exempt | — | **Yes** — records all I/O | ✅ | ✅ | **Dev only** |
| Cerebras | **5** | — | 1M | claims no | ? | ? | Rejected |
| Mistral La Plateforme | **2** | — | ~1B/month | **Yes** — mandatory opt-in | ✅ | ✅ | Rejected |
| GitHub Models | — | — | — | — | — | — | **Retired 2026-07-30** |

---

## Detail

### Groq — the primary provider

**Limits (free tier), per model:**

| Model | RPM | RPD | TPM | TPD | Use |
|---|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8K | 200K | `standard` dialogue |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8K | 200K | `fast` |
| `qwen/qwen3.6-27b` | 30 | 1,000 | 8K | 200K | `standard` alt |
| `qwen/qwen3.8-27b` | 30 | 1,000 | 8K | 200K | `standard` alt |
| `openai/gpt-oss-safeguard-20b` | 30 | 1,000 | 8K | 200K | **moderation stage 2** |
| `meta-llama/llama-prompt-guard-2-86m` | 30 | **14,400** | 15K | 500K | **injection detection** |
| `meta-llama/llama-prompt-guard-2-22m` | 30 | **14,400** | 15K | 500K | injection detection |
| `groq/compound` | 30 | 250 | 70K | — | high-TPM tasks |

**Privacy — why this matters most.** Groq's Services Agreement states Groq may not use customer Inputs or Outputs to train or fine-tune any model without explicit permission. This is account-wide and **not split between free and paid tiers**. Inference requests are not retained by default; troubleshooting/abuse logs are kept at most 30 days. Zero Data Retention is self-serve in the console.

**Consequence:** Groq is the only high-volume free provider we can point *real user content* at without contradicting our own privacy policy ([12](../12-security.md) § 7). This resolves the conflict that otherwise forced a choice between the ₹0 constraint and the privacy promise.

**Capabilities:** all hosted models support tool use; parallel tool use on several including qwen3.6-27b; JSON mode broadly supported.

**Actions:**
- [ ] Enable Zero Data Retention in the Groq console before any real user traffic (Gate A).
- [ ] Verify per-model tool-calling and JSON-mode behaviour empirically (P1-T02) — documentation matrices are frequently ahead of reality.

### Cloudflare Workers AI — embeddings

- **10,000 neurons/day free**, shared across all model types, on both Free and Paid Workers plans.
- `@cf/baai/bge-base-en-v1.5`: **6,058 neurons per 1M input tokens** ≈ 6 neurons per 1K tokens.
- Budget: 10,000 neurons ÷ 6 per 1K ≈ **1.65M embedding tokens/day**. At ~30 tokens per memory, that is **~55,000 memory embeddings/day** — far beyond our needs.
- **768 dimensions**, matching the schema in [03](../03-data-model.md) § 6 exactly.
- **Privacy:** Cloudflare states it neither creates nor trains the models and does not train on customer content. Inputs, outputs and embeddings are Customer Content.
- **Caveat:** the neuron budget is *shared* with LLM inference. Reserve it for embeddings; do not route dialogue here.
- Seven models (Kimi, GLM, DeepSeek variants) require a paid plan — irrelevant to us.

**→ Resolves D-002.**

### OpenRouter — deep tier

- `:free` variants: **20 RPM, 50 RPD**, rising to **1,000 RPD** after a one-time $10 credit purchase (lifetime threshold, not a subscription).
- `nvidia/nemotron-3.5-lightning:free` — 1M context, 65,536 max output, MoE 3B active / 30B total, tool calling ✅, **`response_format` ❌**.
- `nvidia/nemotron-3-ultra-550b-a55b:free` — 1M context, 65,536 max output, MoE 55B active / 550B total, tool calling ✅, **`response_format` ❌**.
- **Note:** the model id in the original blueprint carried a `-20260604` date suffix. The live id has **no date suffix**. Use `nvidia/nemotron-3-ultra-550b-a55b:free`.
- **No token/day cap** — only requests. This makes OpenRouter uniquely valuable for long-context work and for beta scaling, where Groq's TPD cap binds first.
- Privacy is configurable: opting out of training in account settings prevents routing to providers that train. Must be verified to still permit the Nemotron endpoints.

**Structured output consequence:** neither Nemotron supports `response_format`. The strategy ladder in [08](../08-ai-router.md) § 9 must fall back to **tool-calling** for extraction and planning on these models. This was specified as a contingency; it is now confirmed as the required path.

### Google Gemini — development only

- Free tier ~1,500 RPD; embedding models with very high TPM.
- **Terms:** *"Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies"* and, explicitly, *"Do not submit sensitive, confidential, or personal information to the Unpaid Services."* Human reviewers may read inputs.
- EU/Switzerland/UK residents must use paid services regardless.

**→ Usable only with synthetic or founder-authored test data. Never with beta-user content.** Enforced by config: the Gemini provider is disabled in the production environment.

### NVIDIA NIM (build.nvidia.com) — development only

- 40 RPM free tier; ~1,000 developer credits, and free models do not consume the credit balance. Forever-free plan as of 2026.
- Both Nemotron models available directly: `nemotron-3.5-lightning-30b-a3b`, `nemotron-3-ultra-550b-a55b`.
- **Terms:** NVIDIA records inputs and outputs from free endpoints and uses collected information to improve its models. Trial ToS warns not to upload confidential information or personal data.

**→ Same restriction as Gemini. Useful as a second dev-time pool and for benchmarking Nemotron without burning OpenRouter's 50/day.**

### Rejected

**Cerebras** — the marketing figure circulating in blogs (14,400 RPD, no card) does not match Cerebras' own rate-limit documentation, which states Free Trial at **5 RPM**, 30K TPM, 1M TPD, and requires *a verified payment method* before API access activates. 5 RPM cannot serve a multi-character turn. Rejected.

**Mistral La Plateforme** — ~1B tokens/month is the most generous token quota available, but at **2 RPM** it cannot serve interactive traffic, and the free Experiment tier *requires* opting into data training. Rejected on both counts.

**GitHub Models** — fully retired 30 July 2026. Playground, catalogue, inference API and BYOK all withdrawn. Removed from consideration.

---

## The binding constraint is tokens, not requests

The dialogue context budget in [09](../09-context-builder-and-prompts.md) § 2 is ~11,300 input + ~600 output ≈ **12,000 tokens per generation**.

| Pool | Tokens/day | Generations/day | Turns/day @ 1.6 responders |
|---|---|---|---|
| Groq, one model | 200K | ~16 | ~10 |
| Groq, four models | 800K | ~66 | ~41 |
| + OpenRouter free (50 req, no token cap) | — | +50 | ~30 |
| **Total, ₹0** | | **~116** | **~70** |
| + OpenRouter after $10 credit (1,000 req) | — | +1,000 | ~600 |

**Conclusions:**

1. **₹0 is sufficient for Phases 1–10.** ~70 turns/day covers development, the 30-day continuously-played world, and small eval samples.
2. **₹0 is not sufficient for a 50–100 user beta.** The $10 OpenRouter credit is the cheapest route to ~600 turns/day and should be treated as a Phase 11 prerequisite, not a violation of the ₹0 principle — it is a one-time unlock, not recurring spend.
3. **Context size is now an economic lever, not just a quality one.** A compact context profile (~5K tokens) roughly doubles free-tier capacity. Worth building.
4. **Eval suites must run predominantly against the mock provider**, with small real-model samples. Suite 1 alone (100 turns) would consume most of a day's budget at full context.

---

## Open verification tasks

- [ ] **P1-T02a** — empirically confirm Groq tool-calling and JSON-mode behaviour per model
- [ ] **P1-T02b** — confirm OpenRouter training opt-out still permits Nemotron `:free` endpoints
- [ ] **P1-T02c** — measure real token consumption per turn against the specified budget
- [ ] **P1-T02d** — benchmark quality: gpt-oss-120b vs qwen3.6-27b vs Nemotron Lightning vs Nemotron Ultra on eval suites 1, 3, 5, 6
- [ ] **Gate A** — enable Zero Data Retention on Groq before any real user traffic
- [ ] **Gate A** — verify the Gemini and NVIDIA providers are disabled in the production environment config
