# 12 — Security

> Users write intimate fiction here. A breach is not an inconvenience; it is the end of the product.
> **Status:** Authoritative. The Phase 13 gate cannot be passed with an open item in § 9.

---

## 1. Threat model

| ID | Threat | Likelihood | Impact | Primary control |
|---|---|---|---|---|
| T-01 | Credential leak via client bundle | **High** | Critical | No secret ever reaches the client; CI secret scanning |
| T-02 | Horizontal privilege escalation (reading another user's world) | High | Critical | Service-layer authz + RLS, defence in depth |
| T-03 | Prompt injection via user-authored world/character content | High | High | § 4 and [09](09-context-builder-and-prompts.md) § 4 |
| T-04 | Compute abuse — scripted turn spam draining quota | **High** | High | Pre-flight admission, rate limits, anomaly detection |
| T-05 | Webhook forgery (fake Telegram/WhatsApp/payment events) | Medium | High | Signature verification, timing-safe compare |
| T-06 | Data exfiltration via a crafted export or trace endpoint | Medium | Critical | Ownership checks on every read; no cross-world queries |
| T-07 | Tool-call abuse — model persuaded to mutate state maliciously | Medium | Medium | Backend validation, mutation caps, pre-computed tool lists |
| T-08 | Account takeover | Medium | Critical | Provider auth, session rotation, re-auth on sensitive actions |
| T-09 | Insider/staff access to private conversations | Low | Critical | No plaintext in logs, audited admin access, justification required |
| T-10 | Payment webhook replay | Medium | High | Signature + event-id idempotency |
| T-11 | Denial of wallet — inflating our provider costs | Medium | High | Hard daily caps, per-user cost anomaly alerts, kill switch |
| T-12 | Malicious published world (Phase 15+) | Medium | High | Content review, sanitization at write, capability isolation |
| T-13 | Enumeration of user handles / world ids | Medium | Low | UUIDs, 404-not-403, rate limits on lookup endpoints |

## 2. Secrets

### The absolute rule

> No API key, service key, bot token or webhook secret ever appears in code shipped to a browser, in a repository, in a log line, or in an error message.

### Inventory

| Secret | Location | Rotation | Blast radius if leaked |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret only | 90 d | **Total.** Bypasses all RLS. |
| `SUPABASE_ANON_KEY` | Public — safe by design | — | None, if RLS is correct |
| `OPENROUTER_API_KEY` | Worker secret | 90 d | Financial |
| `GEMINI_API_KEY` | Worker secret | 90 d | Financial |
| `TELEGRAM_BOT_TOKEN` | Worker secret | On suspicion | Bot impersonation |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret | 90 d | Message injection |
| `WHATSAPP_APP_SECRET` | Worker secret | 90 d | Message injection |
| `PAYMENT_WEBHOOK_SECRET` | Worker secret | 90 d | Fraudulent entitlements |
| `PHONE_HASH_SALT` | Worker secret | **Never** — rotation orphans identities | Phone-number correlation |
| `SESSION_SIGNING_KEY` | Worker secret | 30 d, overlapping | Session forgery |

### Controls

- Secrets set via `wrangler secret put` / dashboard. **Never in `wrangler.toml`.**
- `.env` files are git-ignored; `.env.example` holds names only, never values.
- Pre-commit hook + CI secret scanning (gitleaks or equivalent) blocking merges.
- The service-role key is used only in server-side paths that genuinely need RLS bypass — the job runner and admin tooling. Every such usage is annotated with a comment explaining why, and reviewed.
- A leaked key is rotated **first**, investigated second.

### The anon-key trap

Supabase's anon key is public by design and safe **only if RLS is correct on every table**. A single table with RLS disabled turns the public key into a full database read. Therefore:

```sql
-- Runs in CI. Any row returned fails the build.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND NOT rowsecurity;
```

## 3. Authentication & authorization

### Sessions

- Supabase Auth for web (email + one OAuth provider).
- JWT verified on every request; signature and expiry checked at the edge.
- Refresh rotation with reuse detection — a replayed refresh token invalidates the whole family.
- Re-authentication required for: email change, account deletion, plan changes, and revealing linked channel identities.

### Bot channels have no user JWT

Telegram and WhatsApp requests arrive with a server identity. **Therefore RLS cannot be the only authorization for any code path a bot can reach.**

Every service function authorizes explicitly:

```ts
// The pattern. No exceptions.
async function getWorld(ctx: RequestContext, worldId: string): Promise<World> {
  const world = await repo.findById(worldId);
  if (!world) throw new NotFound();
  if (!(await canAccessWorld(ctx.userId, world))) throw new NotFound();  // 404, not 403
  return world;
}
```

**404 rather than 403** on unauthorized access to another user's resource — a 403 confirms the resource exists.

### Authorization matrix

| Resource | Owner | Member | Public viewer | Anonymous |
|---|---|---|---|---|
| Private world | RW | R (if `world_members`) | — | — |
| Public world | RW | R | R (metadata + fork) | R (metadata) |
| Characters | RW | R | R (if world public) | — |
| Memories | RW | R | — | — |
| Character knowledge | R | — | — | — |
| Conversation | RW (own) | RW (own) | — | — |
| Relationship values | RW | R | — | — |
| Usage / billing | RW | — | — | — |

## 4. Prompt injection

Full mechanics in [09](09-context-builder-and-prompts.md) § 4. The security-relevant summary:

**The only control that reliably works is capability isolation.** Fencing and sanitization reduce the rate; they do not eliminate it. Therefore:

1. The tool list for a turn is computed by the backend from world settings and entitlements, **before** the prompt is assembled. Nothing inside the prompt can add a tool.
2. Every tool call is validated server-side against the actual world state. A model convinced it should grant 10,000 gold still hits the per-turn numeric cap.
3. Tools are scoped to one world. There is no tool that can read or write across worlds. Cross-world data access is structurally impossible, not merely forbidden.
4. Output is screened for system-prompt fingerprints. A hit is a **security event**, routed differently from a moderation event.

## 5. Abuse and cost protection (T-04, T-11)

The failure we must never see is a ₹50,000 provider bill from a scripted client.

### The five layers

```
1. Edge rate limit          per IP, per user, per conversation      (KV counters)
2. Admission control        entitlement check + atomic CU reservation
3. Per-turn caps            responder cap, token cap, mutation caps
4. Daily hard ceilings      per user AND platform-wide
5. Kill switch              one config flag halts all non-essential inference
```

### Anomaly detection

A background job runs every 15 minutes:

| Signal | Threshold | Action |
|---|---|---|
| User CU consumption vs their 7-day baseline | > 5× | Throttle to `fast` tier, alert |
| Platform CU vs baseline | > 3× | Alert; auto-throttle at 5× |
| Turns/minute sustained by one user | > 20 for 5 min | Temporary block, alert |
| New accounts from one IP | > 5 in 1 hour | Require verification |
| Identical prompts across many accounts | Detected | Investigate — likely scripted abuse |

### The kill switch

A single configuration flag, changeable without deploy, that stops all non-essential inference and returns a maintenance message. Every founder-operated product needs one, and it needs to have been tested. **Test it in staging in Phase 12**; do not discover its bugs during an incident.

## 6. Webhook security

| Channel | Verification |
|---|---|
| Telegram | `X-Telegram-Bot-Api-Secret-Token` header, timing-safe compare, plus a random path segment |
| WhatsApp | `X-Hub-Signature-256` HMAC-SHA256 over the **raw body**, timing-safe compare |
| Payments | Provider signature + event-id idempotency table |

Rules for all webhooks:

- Verify **before** parsing JSON, against raw bytes.
- Use a constant-time comparison. `===` on a signature is a timing oracle.
- Deduplicate by provider event id.
- ACK fast, process asynchronously.
- Rate-limit the endpoint itself — an unauthenticated public endpoint is a DoS target.

## 7. Data protection & privacy

### Logging rules (P9, non-negotiable)

| Never logged | Logged |
|---|---|
| Message content | Message id, length, token count |
| Memory content | Memory id, kind, importance |
| Character/world descriptions | Ids |
| Persona text | Persona id |
| Email addresses | User id |
| Phone numbers | Hashed channel id |
| Prompts sent to providers | Token counts, template version |
| Model outputs | Token counts, moderation verdict |

Moderation records store a **SHA-256 of the content**, never the content. That is enough to detect repeat offences without building a searchable archive of users' private fiction.

If a debugging situation genuinely requires content, it is accessed through the admin path with a written justification recorded in `admin_audit_log`, and it is time-boxed.

### Deletion

`DELETE /v1/me` enqueues an account-deletion job:

```
1. Mark profile deletion_pending; revoke sessions immediately
2. 7-day grace period (recoverable — accidental deletion is common)
3. Hard delete: worlds, characters, memories, embeddings, messages,
   personas, relationships, channel accounts
4. Anonymize retained rows required for financial/legal records
   (model_requests, usage_ledger → user_id nulled)
5. Delete storage objects
6. Confirmation email
7. Audit record retained: user id hash, deletion timestamp — nothing else
```

Deletion must be **real**. "Soft-deleted forever" is not deletion, and claiming otherwise in a privacy policy is a legal exposure.

### Encryption

- TLS everywhere. HSTS enabled.
- Encryption at rest via the database provider.
- Phone numbers hashed with a per-deployment salt.
- **Field-level encryption of message content is deliberately not implemented at MVP.** It would break retrieval, search and moderation. This trade-off is recorded as ADR-006 and revisited if we ever handle a genuinely higher-risk content category.

### Training

User content is **not** used to train or fine-tune models. If that ever changes, it requires explicit, separately-obtained, revocable, opt-**in** consent — never a terms-of-service update.

Note that content sent to third-party inference providers is governed by *their* terms. Before launch, confirm and document the training/retention policy of each provider in the chain, and state it plainly in the privacy policy. Users deserve to know which companies see their stories.

## 8. Frontend security

- CSP with no `unsafe-inline` and no `unsafe-eval`.
- All user content rendered as text. If markdown is rendered, it is sanitized with an allowlist; **never** `dangerouslySetInnerHTML` on model or user output.
- No secrets in `NEXT_PUBLIC_*` beyond the intentionally-public anon key and base URL.
- `SameSite=Lax` cookies, `Secure`, `HttpOnly` where applicable.
- Subresource integrity on any third-party script. Prefer zero third-party scripts.
- Dependencies audited in CI; no new dependency without a stated reason on the PR.

## 9. Pre-launch security checklist

**Every box must be ticked before the public URL is live. This is a hard gate.**

- [ ] Every public table has RLS enabled (CI query passes)
- [ ] RLS policies reviewed line by line against the authorization matrix
- [ ] Service-role key used in ≤ 5 annotated locations, each reviewed
- [ ] Secret scanning active in CI and on pre-commit; git history scanned for historical leaks
- [ ] All webhooks verify signatures with timing-safe comparison
- [ ] Rate limits enforced and load-tested
- [ ] Compute admission control verified by attempting to exceed a quota
- [ ] Kill switch tested end-to-end in staging
- [ ] Account deletion tested end-to-end, verified in the database
- [ ] Data export tested (contains everything, and nothing belonging to anyone else)
- [ ] No message content in any log sink (verified by inspecting real logs)
- [ ] Admin access audited and justification-gated
- [ ] Prompt injection suite run against published-world content (Phase 15)
- [ ] Dependency audit clean; no known critical CVEs
- [ ] CSP headers verified in production
- [ ] Password reset / account recovery flow tested against takeover
- [ ] Provider terms reviewed and reflected accurately in the privacy policy
- [ ] Incident response contact and procedure written down (§ 10)
- [ ] Ownership migration complete (§ 11)

## 10. Incident response

```
DETECT   alert, user report, or provider notification
   ↓
CONTAIN  rotate credentials · disable the affected path · kill switch if needed
   ↓
ASSESS   what data, how many users, over what window — write it down as you go
   ↓
FIX      patch, deploy, verify
   ↓
NOTIFY   affected users within 72 hours where a personal-data breach is likely
   ↓
LEARN    written post-mortem, blameless, with concrete preventive actions
```

Severity: **S1** data exposure or full outage — drop everything. **S2** partial outage or security weakness with no known exploitation — same day. **S3** degraded quality — next working day.

Have a pre-written user notification template. Writing one during an incident produces bad decisions.

## 11. Account ownership migration (hard gate before revenue)

| Asset | Development | Before launch |
|---|---|---|
| Domain | — | Company registrant, privacy on, auto-renew, transfer lock |
| Cloudflare | Personal | Company account, 2FA, recovery codes stored offline |
| Supabase | Personal | Company account, 2FA |
| GitHub | Personal | Company org, branch protection, 2FA required |
| Provider accounts | Personal | Company accounts with company billing |
| Bot tokens | Personal Telegram | Company-owned bot with a documented recovery path |
| Payment | — | Company entity, verified, with a second authorized person if possible |
| Email | Personal | Company domain with role addresses (`security@`, `support@`, `legal@`) |

**Recovery must not depend on one person's phone number.** Recovery codes are stored offline in a second physical location.
