# 10 — API Contracts

> One backend, many clients. The contract is defined once in `packages/contracts/` as Zod schemas; TypeScript types and the client SDK are derived from it.
> **Status:** Authoritative. Breaking changes require a version bump and an ADR.

---

## 1. Conventions

| Aspect | Rule |
|---|---|
| Base path | `/v1` |
| Format | JSON, `application/json; charset=utf-8` |
| IDs | UUID v4 strings |
| Timestamps | RFC 3339 UTC, `2026-09-03T14:22:00Z` |
| Auth | `Authorization: Bearer <supabase_jwt>` for user requests; HMAC signature for webhooks |
| Idempotency | `Idempotency-Key` header required on all POSTs that mutate world state |
| Request tracing | `X-Request-Id` echoed in every response and in every log line |
| Pagination | Cursor-based: `?cursor=<opaque>&limit=<n≤100>` → `{ items, next_cursor }`. **Never offset pagination** — it double-serves rows under concurrent writes. |
| Partial updates | `PATCH` with only changed fields. `PUT` is not used. |
| Errors | Always the envelope in § 3. Never a bare string. |

## 2. Response envelope

```jsonc
// Success
{
  "data": { /* … */ },
  "meta": { "request_id": "req_…", "version": "1" }
}

// Error
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Daily message limit reached.",   // safe to show the user
    "detail": "compute_units 100/100 for 2026-09-03",  // omitted in production for 5xx
    "retry_after": 3600,
    "fields": { "name": "must be 1–80 characters" }    // validation errors only
  },
  "meta": { "request_id": "req_…" }
}
```

**`message` is always user-safe.** It is rendered directly in the UI. Internal detail goes in `detail`, which is stripped from 5xx responses in production.

## 3. Error taxonomy

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | No | Missing or invalid token |
| `FORBIDDEN` | 403 | No | Authenticated but not permitted |
| `NOT_FOUND` | 404 | No | Also returned instead of 403 when revealing existence would leak information |
| `VALIDATION_FAILED` | 422 | No | See `fields` |
| `CONVERSATION_BUSY` | 409 | Yes | A turn is already generating |
| `STATE_CONFLICT` | 409 | Yes | Optimistic concurrency failure; re-read and retry |
| `RATE_LIMITED` | 429 | Yes | See `retry_after` |
| `QUOTA_EXCEEDED` | 429 | After reset | Compute budget exhausted |
| `ENTITLEMENT_REQUIRED` | 402 | No | Feature requires a higher plan |
| `CONTENT_BLOCKED` | 422 | No | Moderation refusal |
| `AI_UNAVAILABLE` | 503 | Yes | All providers exhausted |
| `INTERNAL` | 500 | Maybe | Never leaks internals |

Clients treat any `5xx` or `429` as retryable with exponential backoff and jitter; everything else is terminal.

## 4. Endpoints

### Auth & identity

```
POST   /v1/auth/session                 exchange Supabase token → app session
GET    /v1/me                           profile, plan, entitlements, usage
PATCH  /v1/me                           update profile
DELETE /v1/me                           request account deletion (enqueues job)
GET    /v1/me/usage                     today's meters + limits
POST   /v1/me/link-code                 issue a channel-linking code
```

### Personas

```
GET    /v1/personas
POST   /v1/personas
PATCH  /v1/personas/:id
DELETE /v1/personas/:id
```

### Worlds

```
GET    /v1/worlds                       ?status=active&cursor=
POST   /v1/worlds                       manual creation
POST   /v1/worlds/generate              guided creation → DRAFT, not saved
GET    /v1/worlds/:id                   world + state + settings + character roster
PATCH  /v1/worlds/:id
DELETE /v1/worlds/:id                   soft delete
GET    /v1/worlds/:id/state
GET    /v1/worlds/:id/rules
POST   /v1/worlds/:id/rules
PATCH  /v1/worlds/:id/rules/:ruleId
DELETE /v1/worlds/:id/rules/:ruleId
GET    /v1/worlds/:id/timeline          ?cursor=      world_events, newest first
GET    /v1/worlds/:id/export            Phase 17
```

`POST /v1/worlds/generate` returns an **unsaved draft**. The client shows it for review; saving is a separate `POST /v1/worlds`. This is deliberate — see [05](05-world-engine.md) § 10.

### Characters

```
GET    /v1/worlds/:id/characters
POST   /v1/worlds/:id/characters
POST   /v1/worlds/:id/characters/generate     draft, not saved
GET    /v1/characters/:id                     profile + goals + public relationships
PATCH  /v1/characters/:id
DELETE /v1/characters/:id
GET    /v1/characters/:id/knowledge            what this character knows (owner only)
GET    /v1/characters/:id/relationships
```

### Conversations & turns — the hot path

```
GET    /v1/worlds/:id/conversations
POST   /v1/worlds/:id/conversations
GET    /v1/conversations/:id
GET    /v1/conversations/:id/messages          ?cursor=&limit=  reverse chronological
POST   /v1/conversations/:id/turns             ← THE endpoint
POST   /v1/conversations/:id/turns/:turnId/regenerate
DELETE /v1/messages/:id                        soft delete, owner only
```

#### `POST /v1/conversations/:id/turns`

```jsonc
// Request
{
  "content": "I tell everyone that I'm leaving tomorrow.",
  "persona_id": "…",              // optional; defaults to conversation persona
  "stream": true,
  "depth": "auto"                 // 'auto' | 'deep' — 'deep' requires entitlement
}
// Headers: Idempotency-Key: <uuid>
```

**Streaming response — Server-Sent Events.** Each event is a JSON object with a `type`.

```jsonc
event: turn.started
{ "turn_id": "…", "responders": [
    { "kind": "character", "id": "…", "name": "Mother", "reason": "addressed, high stake" },
    { "kind": "character", "id": "…", "name": "Daughter" }
]}

event: message.started
{ "message_id": "…", "speaker": { "type": "character", "id": "…", "name": "Mother" } }

event: message.delta
{ "message_id": "…", "text": "Leaving tomorrow? You " }

event: message.completed
{ "message_id": "…", "content": "…", "tokens": 34 }

event: state.changed
{ "changes": [
    { "kind": "relationship", "character": "Daughter", "deltas": {"trust": -4},
      "reason": "He decided without asking her again." },
    { "kind": "flag", "key": "departure_announced", "value": true }
]}

event: memory.created                      // fired after deferred extraction, if the stream is open
{ "count": 2 }

event: turn.completed
{ "turn_id": "…", "message_ids": ["…"], "world_version": 1841,
  "usage": { "compute_units": 7, "remaining_today": 63 } }

event: error
{ "code": "AI_UNAVAILABLE", "message": "The world is resting. Try again in a moment.",
  "recoverable": true }
```

**Client rules:**

- `turn.started` arrives before any generation completes — render the "who is speaking" indicator immediately. This is most of the perceived-latency win.
- A `message.completed` without a preceding `message.started` is a protocol violation; the client should resync via `GET /messages`.
- On disconnect, the turn **continues server-side**. Reconnect and fetch `GET /conversations/:id/messages?since=<seq>`. Never re-POST the turn — the idempotency key protects against it, but the client should not rely on that.

Non-streaming (`"stream": false`) returns the complete turn as one JSON response. Bot channels use this path.

### Memory

```
GET    /v1/worlds/:id/memories          ?kind=&pinned=&q=&cursor=
POST   /v1/worlds/:id/memories          manual add
PATCH  /v1/memories/:id                 edit content, pin/unpin
DELETE /v1/memories/:id
GET    /v1/turns/:turnId/trace          why these memories surfaced (Phase 12)
```

### Relationships & quests

```
GET    /v1/worlds/:id/relationships                  full graph
GET    /v1/relationships/:id/timeline
GET    /v1/worlds/:id/quests            ?status=
PATCH  /v1/quests/:id                   owner override
GET    /v1/worlds/:id/inventory         ?holder_type=&holder_id=
```

### Billing

```
GET    /v1/plans
GET    /v1/subscription
POST   /v1/subscription/checkout        → provider redirect URL
POST   /v1/subscription/cancel
POST   /v1/webhooks/payments            signature-verified
```

### Moderation

```
POST   /v1/reports
GET    /v1/reports/mine
```

### Webhooks (no user auth; signature-verified)

```
POST   /v1/webhooks/telegram/:secret
POST   /v1/webhooks/whatsapp
GET    /v1/webhooks/whatsapp            hub.challenge verification
```

### Health

```
GET    /v1/health                       liveness — no dependencies touched
GET    /v1/health/deep                  db + providers; auth-gated
```

## 5. Internal message protocol

Every channel normalizes to this. The engine never sees a Telegram or WhatsApp payload.

```ts
interface InboundMessage {
  channel: 'web' | 'telegram' | 'whatsapp' | 'discord';
  externalId: string;              // provider message id — idempotency key
  externalUserId: string;
  externalChatId: string;
  userId: string | null;           // null = unlinked; adapter must handle onboarding
  conversationId: string | null;   // null = resolve or create
  worldId: string | null;
  content: string;
  contentType: 'text' | 'command' | 'callback';
  command?: { name: string; args: string[] };
  replyToExternalId?: string;
  isGroup: boolean;
  receivedAt: string;
  raw: unknown;                    // retained for debugging; NEVER passed to a model
}

interface OutboundMessage {
  channel: string;
  externalChatId: string;
  content: string;
  speaker?: { name: string; avatarUrl?: string };
  replyToExternalId?: string;
  keyboard?: KeyboardSpec;         // channel-agnostic; adapters render natively
  parseMode?: 'plain' | 'markdown';
}
```

`raw` exists for debugging only. It is never passed into a prompt, and it is redacted from logs.

## 6. Rate limits

Enforced at the edge; returned in headers on every response.

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1756900000
```

| Scope | Free | Creator | Pro |
|---|---|---|---|
| Turns/minute | 8 | 20 | 40 |
| Turns/day | 60 | 400 | 1,500 |
| World creations/day | 3 | 15 | 40 |
| Character generations/day | 10 | 60 | 200 |
| API requests/minute (all) | 120 | 300 | 600 |

Numbers are **placeholders** until Phase 12 measures real usage. They are configuration, not code.

## 7. Versioning

- `/v1` is stable once the private beta begins.
- Additive changes (new fields, new endpoints) ship without a version bump.
- Breaking changes create `/v2`; `/v1` is supported for 90 days minimum.
- Clients send `X-Client-Version`; the server can warn or refuse below a floor.
- **The SSE event schema is part of the contract.** Adding an event type is additive; changing an existing one is breaking.

## 8. Client SDK

`packages/contracts` generates a typed client consumed by `apps/web` and by any future native app.

```ts
const df = createClient({ baseUrl, getToken });

const world = await df.worlds.get(worldId);
for await (const ev of df.turns.stream(conversationId, { content: "I walk in." })) {
  switch (ev.type) {
    case 'message.delta': appendText(ev.message_id, ev.text); break;
    case 'state.changed': applyStateChanges(ev.changes); break;
  }
}
```

The web app contains **no `fetch` calls to our API** outside this SDK. That is what keeps the contract honest, and what makes the eventual Android app cheap.
