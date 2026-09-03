# 11 — Channels: Web, Telegram, WhatsApp

> A channel translates. It does not think.
> **Status:** Authoritative. Web ships in Phase 9, Telegram in Phase 10, WhatsApp in Phase 16.

---

## 1. The rule

```
Channel adapter responsibilities          Channel adapter MUST NOT
─────────────────────────────────         ────────────────────────
verify the request signature              call a model
deduplicate deliveries                    read or write world state
resolve identity                          retrieve memories
normalize → InboundMessage                make product decisions
render OutboundMessage natively           hold its own conversation history
respect provider send limits              have its own prompt
```

There is exactly one world engine. Telegram is a skin over it. The instant a channel grows its own logic, worlds diverge by surface and the promise of continuity is broken.

```ts
interface MessageChannel {
  readonly id: string;
  verify(req: Request): Promise<boolean>;
  parse(req: Request): Promise<InboundMessage[]>;
  send(msg: OutboundMessage): Promise<{ externalId: string }>;
  sendTyping(chatId: string): Promise<void>;
  capabilities: {
    streaming: boolean; markdown: boolean; buttons: boolean;
    maxMessageLength: number; images: boolean;
  };
}
```

## 2. Web (Phase 9)

The primary and most capable surface. Next.js PWA.

### Screens

| Screen | Purpose | Phase |
|---|---|---|
| Landing | Positioning + the day-1/day-30 demo | 9 |
| Auth | Email + one OAuth provider | 9 |
| Dashboard | World cards: name, chapter, day, character count, last played | 9 |
| World creator | Guided (5 questions) + manual | 9 |
| Character editor | Profile, voice anchors, goals, secrets, relationships | 9 |
| **Chat** | The product | 9 |
| Memory notebook | View, pin, edit, delete, add | 9 |
| Relationship graph | Force-directed, click for detail + timeline | 12 |
| Timeline | World events by day | 12 |
| Quest panel | Active quests and steps | 12 |
| Settings | Account, personas, plan, data export, deletion | 9 |
| Turn trace | "Why did she say that?" | 12 |

### Chat layout

```
┌────────────┬──────────────────────────────────────┬──────────────────┐
│ CHARACTERS │                                      │  WORLD STATE     │
│            │  Elena                               │                  │
│ ● Elena    │  "You finally came back."            │  Day 142 · night │
│   trust 82 │                                      │  Ravenhold       │
│            │  You                                 │  War: active     │
│ ● Marcus   │  "I had no choice."                  │  Gold 1,240      │
│   trust −42│                                      │                  │
│            │  Marcus                              │  RELATIONSHIPS   │
│ ○ King     │  "You always have a choice."         │  Elena     +82   │
│   (absent) │                                      │  Marcus    −42   │
│            │  ┌ Elena is thinking… ┐               │                  │
│            │                                      │  QUEST           │
│            │                                      │  Find the        │
│            │                                      │  murderer (2/4)  │
├────────────┴──────────────────────────────────────┴──────────────────┤
│  Say or do something…                                       [Send]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Interaction requirements that are not optional:**

- The "who is responding" indicator appears on `turn.started`, **before** any text arrives. Users tolerate 6 seconds of waiting when they can see three characters are about to speak; they do not tolerate 3 seconds of a blank screen.
- Streaming text renders token-by-token for the first speaker.
- `state.changed` events animate the right panel — a trust number visibly moving is the clearest possible proof that the world is real.
- The right panel is collapsible; on mobile it becomes a bottom sheet.
- Optimistic rendering of the user's own message, reconciled on `turn.completed`.

### PWA requirements

Installable manifest; offline shell showing cached worlds and message history read-only; a service worker that queues nothing (a queued turn that fires hours later is a bug, not a feature).

## 3. Telegram (Phase 10)

Ships early because the integration cost is genuinely low and it is our cheapest viral surface.

### Setup

- Bot created via BotFather; token stored as a secret ([12](12-security.md)).
- Webhook registered with a `secret_token`. **Every request is validated against the `X-Telegram-Bot-Api-Secret-Token` header.** Without this, anyone who guesses the URL can inject messages.
- Additionally, the URL path contains a random segment: `/v1/webhooks/telegram/:secret`.

### Flow

```
Telegram ──▶ webhook ──▶ verify header + path secret
                       ──▶ dedupe on update_id           (channel_message_ids)
                       ──▶ 200 OK IMMEDIATELY  ← critical
                       ──▶ ctx.waitUntil(process)
                             ├─ resolve identity
                             ├─ sendChatAction('typing')
                             ├─ run the standard turn pipeline
                             └─ send one message per character
```

**Acknowledge first, process second.** Telegram retries on non-2xx; a slow handler produces duplicate turns. This is the single most common Telegram bot bug.

### Commands

```
/start        onboarding or resume
/worlds       list and switch
/new          create a world (guided, one question per message)
/who          who is present, with relationship snapshot
/memory       recent important memories
/state        world state
/link         issue a code to connect a web account
/pause        stop responding in this chat
/help
```

Commands are the scaffolding. **Natural language is the interface** — a user typing "I walk into the tavern" must work with no command at all.

### Presentation

- One Telegram message per speaking character, prefixed with the name in bold. Separate messages read as separate people; a single merged block reads as a bot.
- 300–800 ms delay between messages so the conversation feels paced rather than dumped.
- `sendChatAction('typing')` before each.
- Inline keyboards for choices, world switching and quick actions.
- Long output is split at paragraph boundaries, never mid-sentence, respecting the 4,096-character limit.

### Send limits

Telegram enforces roughly 30 messages/second globally and about 20 messages/minute per group. A three-character response in a busy group can hit the group limit.

**Required:** an outbound queue with per-chat pacing and a global token bucket, retrying on 429 using the `retry_after` value Telegram supplies. Build this in Phase 10, not after the first flood.

### Identity linking

```
Web:      Settings → "Connect Telegram" → code DF-4B7X (10 min TTL)
Telegram: /link DF-4B7X
Result:   channel_accounts row created. Same worlds. Same memories. Both surfaces.
```

An unlinked Telegram user can still play — a lightweight account is created on first message, upgradeable later by linking. Forcing signup before the first message kills the viral loop we came for.

### Group play *(Phase 10.5, after single-chat is stable)*

- Bot added to a group; the adder becomes the world owner.
- Each human gets a persona in the shared world.
- Bot responds when mentioned, when replied to, or when the scene demands it — **not** to every message.
- 3-second debounce batches rapid human messages into one turn.
- `/pause` and `/resume` are mandatory. A bot that cannot be silenced gets removed.
- Compute is charged to the world owner with a group multiplier; other members draw on their own budgets.

## 4. WhatsApp (Phase 16)

Deliberately later. Telegram's constraints are technical; WhatsApp's are operational — business verification, template message rules, the 24-hour customer service window, and per-conversation pricing.

### Constraints that shape the design

| Constraint | Consequence |
|---|---|
| 24-hour session window | Outside it, only pre-approved template messages. **No unprompted story notifications.** |
| Template approval | Any re-engagement message must be submitted and approved in advance |
| Business verification | Required before production scale; start in Phase 15 — it takes weeks |
| Per-conversation pricing | Unlike Telegram, WhatsApp costs real money. It must be entitlement-gated. |
| No rich inline keyboards | Interactive lists and reply buttons only |

### Design decisions that follow

1. WhatsApp is a **continuation** surface, not a full one. Complex authoring redirects to the web app with a deep link.
2. **Entitlement-gated** to paid plans, or hard-capped for free users. It is the only channel with a direct marginal cost.
3. Re-engagement uses at most one approved template, and only with explicit opt-in.
4. Phone numbers are stored as salted hashes ([03](03-data-model.md)).
5. Signature verification via `X-Hub-Signature-256` HMAC-SHA256 over the raw body, compared with a **timing-safe** equality function. Verify against the raw bytes, before any JSON parsing.

## 5. Identity resolution — shared by all channels

```
inbound message
      ↓
lookup channel_accounts (channel, external_id)
      ├─ found ──────────▶ userId
      └─ not found ──────▶ create lightweight account
                            ├─ profile with generated handle
                            ├─ default persona
                            ├─ free plan subscription
                            └─ onboarding message including how to /link
```

Linking merges the lightweight account into the web account: worlds transfer, the lightweight profile is soft-deleted, and `channel_accounts.user_id` is repointed. **This must be transactional** — a half-merged account is a support nightmare with no clean recovery.

## 6. Channel capability matrix

| Capability | Web | Telegram | WhatsApp |
|---|---|---|---|
| Streaming | ✅ | ❌ (send on completion) | ❌ |
| Multi-character | ✅ | ✅ (one message each) | ✅ (one message each) |
| Rich state panel | ✅ | ⚠️ `/state` command | ⚠️ `/state` command |
| Memory notebook | ✅ | ⚠️ `/memory` (read-only) | ❌ → web link |
| World creation | ✅ | ✅ (guided, conversational) | ❌ → web link |
| Character editing | ✅ | ❌ → web link | ❌ → web link |
| Group play | ❌ | ✅ | ⚠️ later |
| Images | Phase 17 | Phase 17 | Phase 17 |

Feature parity is **not** a goal. Each channel does what it is good at and links to the web app for the rest.

## 7. Failure modes

| Failure | Response |
|---|---|
| Webhook signature invalid | 401, log as a security event, no processing. Repeated hits from one source → block. |
| Duplicate delivery | Dedupe table catches it; return 200 without processing |
| Adapter throws mid-turn | Turn is already committed. Retry send with backoff; on final failure, the message is still in history and appears on the web app |
| User blocks the bot | 403 on send → mark the channel account inactive, stop sending, do not delete data |
| Provider outage | Other channels unaffected — this is the payoff of the shared backend |
| Message exceeds length limit | Split at paragraph boundaries |
| Group flooding | Per-chat rate limit → bot posts one "let me catch up" message and batches |
| Rate limit from provider (429) | Honour `retry_after`; queue; never drop silently |
