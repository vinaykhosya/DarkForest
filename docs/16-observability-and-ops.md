# 16 — Observability & Operations

> A solo founder cannot watch dashboards. The system must tell you when something is wrong, and stay standing while you sleep.
> **Status:** Authoritative.

---

## 1. What we record

### Structured logs — one JSON line per request

```jsonc
{
  "ts": "2026-09-03T14:22:11.482Z",
  "request_id": "req_01H…",
  "level": "info",
  "event": "turn.completed",
  "user_id": "usr_…",
  "world_id": "wld_…",
  "conversation_id": "cnv_…",
  "turn_id": "trn_…",
  "channel": "web",
  "responders": 2,
  "duration_ms": 4820,
  "ttft_ms": 1340,
  "models": ["standard:model-a", "fast:model-a"],
  "fallbacks": 0,
  "compute_units": 4,
  "memories_retrieved": 11,
  "tool_calls": 2,
  "tool_rejections": 0,
  "plan": "free"
}
```

### What is never logged

Message content · memory content · character or world descriptions · persona text · email addresses · phone numbers · prompts · model outputs. ([12](12-security.md) § 7 — this is a hard rule, not a guideline.)

`request_id` is generated at ingress, threaded through every log line and every `model_requests` row, and returned to the client in `X-Request-Id`. When a user reports a problem, that one id reconstructs the entire turn without ever reading their story.

## 2. Metrics

### Health

| Metric | Alert |
|---|---|
| Request rate | — |
| Error rate (5xx) | > 1% over 5 min |
| p95 turn latency | > 12 s over 10 min |
| p95 TTFT | > 4 s over 10 min |
| Retrieval p95 | > 600 ms |
| DB connection failures | any |
| Job queue depth | > 500 |
| Job dead-letter count | > 10/hour |
| Worker CPU-limit errors | any — this means the request path grew heavy work |

### AI

| Metric | Alert |
|---|---|
| Model failure rate by model | > 20% over 15 min |
| Fallback rate | > 30% over 15 min |
| Circuit breakers open | any, for > 10 min |
| Free-quota headroom per provider | < 20% remaining |
| CU per turn (rolling avg) | > 15% above baseline |
| avg responders/turn | > 2.0 — this is margin leaking |
| Deep-tier share of turns | > 15% |

### Product

Daily: signups, DAU, turns, worlds created, characters created, memories created/retrieved, **Returning World Sessions**, D1/D7/D30 retention, free→paid conversion.

### Business

Daily: cost per turn, cost per user, cost per world · MRR, ARR, churn, ARPU · gross margin · free-tier total cost against its ceiling.

## 3. Alerting

Alerts arrive by push and by email. Three severities, and the discipline is that a **P3 alert must never wake you up** — an alert channel that cries wolf gets muted, and then the real one is missed.

| Severity | Examples | Response |
|---|---|---|
| **P1 — page** | Site down · DB unreachable · all providers down · data-exposure signal · cost anomaly > 5× | Immediate |
| **P2 — notify** | One provider down · error rate > 1% · job queue backing up · free quota < 20% · payment webhooks failing | Same day |
| **P3 — digest** | Latency drift · CU creep · moderation false-positive reports · dependency advisories | Weekly review |

**Every alert states what to do.** An alert that says "error rate high" and nothing else costs ten minutes of rediscovery each time it fires. It should say: *"Error rate 4.2%, mostly AI_UNAVAILABLE. Check provider status in the AI dashboard. Runbook: R-03."*

## 4. The degradation ladder

The system's designed response to worsening conditions. Each step is implemented and testable; the user is always told something honest.

```
LEVEL 0 — Normal
         Full tiers, full responder caps, streaming, background jobs current.

LEVEL 1 — Elevated load or reduced provider availability
         · Deep tier restricted to explicit requests
         · Responder cap reduced by 1
         · Consolidation deferred
         User impact: none visible.

LEVEL 2 — Primary providers degraded
         · All dialogue routed to the fast tier
         · Responder cap = 2
         · Memory extraction queued rather than inline
         User impact: shorter, simpler replies.
         Message: none — do not announce degradation the user cannot perceive.

LEVEL 3 — Severe
         · Responder cap = 1
         · Retrieval limited to pinned + recent
         · Non-essential features disabled (world/character generation)
         Message: "Running in reduced mode — replies may be shorter than usual."

LEVEL 4 — No inference available
         · User messages ACCEPTED AND STORED
         · No generation attempted
         Message: "The world is resting. Your message is saved — come back shortly."
         · Retry offered; on recovery, the pending turn can be resumed.

LEVEL 5 — Database unavailable
         · Read-only from cache where possible
         · Writes refused with a clear error
         Message: "We're having trouble reaching the archive. Nothing is lost."
```

**Level 4 is the one worth building carefully.** Losing a user's typed message during an outage is a much larger betrayal than the outage itself.

Level is set automatically from provider health and error rates, and can be forced manually by config.

## 5. Runbooks

Kept short. Written before they are needed. Stored in `docs/runbooks/`.

| ID | Situation | First action |
|---|---|---|
| R-01 | All AI providers failing | Check provider status pages → verify keys → confirm level 4 engaged → post status |
| R-02 | Database unreachable | Check platform status → connection limits → confirm level 5 → do not restart blindly |
| R-03 | Elevated error rate | Filter logs by error code; one code usually dominates and names the cause |
| R-04 | Cost anomaly | Identify the top user by CU → check for scripting → throttle → investigate |
| R-05 | Free quota exhausted early | Confirm which provider → shift the chain → tighten free limits temporarily |
| R-06 | Job queue backing up | Check dead-letters for a common error → fix → requeue → verify the cron is firing |
| R-07 | Suspected data exposure | **Contain first** ([12](12-security.md) § 10). Rotate, disable, then assess. |
| R-08 | Bad deploy | Roll back first, diagnose after. Rollback must take under 5 minutes. |
| R-09 | Memory quality complaint | Pull the retrieval trace for the turn; do not guess |
| R-10 | Moderation false positive | Reproduce, add a regression case, tune, notify the user |

## 6. Deployment

```
local → CI (tests + evals) → staging → smoke → production → verify
```

- **Migrations run before code deploy**, and must be backwards compatible with the currently-running version ([03](03-data-model.md) § 12).
- **Rollback under 5 minutes**, tested quarterly. If it has never been tested, it does not work.
- Deploy during your own waking hours. There is no on-call rotation of one.
- Feature flags for anything user-visible and risky; a flag beats a rollback.
- Post-deploy smoke test runs automatically and alerts on failure.

## 7. Admin dashboard

Built in Phase 12, before the beta widens. Read-mostly, and deliberately without a "read any conversation" button.

```
OVERVIEW      DAU · turns today · errors · cost today · providers up
USERS         search, plan, usage, enforcement history — no content
WORLDS        count, size, activity — metadata only
AI            per-model requests, failures, latency, CU, breaker state
COST          per user, per turn, per world; trend; free-tier ceiling
JOBS          queue depth, dead letters, requeue
MODERATION    report queue, verdict distribution, appeals
BUSINESS      MRR, conversion, churn, retention cohorts
CONTROLS      kill switch · degradation level · feature flags · plan limits
```

Content access is a separate, audited path requiring a written justification ([12](12-security.md) § 7). Building the dashboard without content access by default is easier than adding the restriction later.

## 8. Weekly operating rhythm

| When | What |
|---|---|
| Daily (5 min) | Overview dashboard: errors, cost, quota headroom |
| Weekly (1 h) | **Play a world for an hour** ([15](15-testing-and-evaluation.md) § 6) |
| Weekly (30 min) | Metrics review: retention, RWS, cost per user, alert digest |
| Weekly | Update [PROGRESS.md](../workflow/PROGRESS.md) and re-prioritize [TASKS.md](../workflow/TASKS.md) |
| Monthly | Full eval run; benchmark refresh; dependency audit; free-tier limit re-verification |
| Quarterly | Rollback drill; secret rotation; security checklist re-run; ADR review |

## 9. Cost monitoring

The number to watch is **cost per active user per day**, trended weekly.

```
alert if   cost_per_user_today > 2 × cost_per_user_7d_avg
alert if   platform_cost_today > 3 × platform_cost_7d_avg
throttle if platform_cost_today > 5 × platform_cost_7d_avg
```

While the chain is entirely free endpoints, monetary cost is zero and **quota consumption** is the real currency — track headroom per provider with the same seriousness. A quota exhausted at 2pm is an outage for everyone who plays in the evening.
