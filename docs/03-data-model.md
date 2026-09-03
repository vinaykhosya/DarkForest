# 03 — Data Model

> **Status:** Authoritative for MVP through Phase 12. Tables marked *(later)* are specified now so that earlier migrations do not paint us into a corner, but are not created until their phase.
> **Rule:** the DDL here is the source of truth. `db/schema.sql` is generated from applied migrations and must match it.

---

## 0. Conventions

| Convention | Rule |
|---|---|
| Primary keys | `uuid` default `gen_random_uuid()`. No sequential integer ids on user-visible entities. |
| Timestamps | `timestamptz`, always. `created_at` and `updated_at` on every mutable table. Never a bare `timestamp`. |
| Soft delete | `deleted_at timestamptz` on user-content tables. Hard delete only via the account-deletion job. |
| Enums | Postgres `text` + `CHECK` constraint, not `ENUM` types — altering a CHECK is a one-line migration, altering an enum is not. |
| Money | Never `float`. `integer` minor units (paise) plus a `currency` column. |
| Scores | `real` in `[0,1]` for probabilities/importance; `smallint` in `[-100,100]` for relationship dimensions. |
| JSON | `jsonb`, and only for genuinely open-ended structures. If it is queried or filtered, it becomes a column. |
| Naming | `snake_case`, plural tables, singular column names, `_id` suffix on FKs. |
| Migrations | Forward-only, numbered `NNNN_description.sql`. No down-migrations; roll forward. |

**Extensions required:** `pgcrypto` (uuid), `vector` (pgvector), `pg_trgm` (fuzzy search), `unaccent`.

---

## 1. Identity and accounts

```sql
-- Mirrors auth.users; app-level profile data lives here, never in the auth schema.
CREATE TABLE profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle          citext UNIQUE NOT NULL,
  display_name    text NOT NULL,
  avatar_url      text,
  locale          text NOT NULL DEFAULT 'en',
  timezone        text NOT NULL DEFAULT 'UTC',
  age_confirmed   boolean NOT NULL DEFAULT false,
  age_confirmed_at timestamptz,
  content_prefs   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','banned','deletion_pending')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- A persona is who the USER is inside a world. Distinct from their account.
CREATE TABLE personas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  appearance    text NOT NULL DEFAULT '',
  traits        text[] NOT NULL DEFAULT '{}',
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX personas_one_default
  ON personas(user_id) WHERE is_default AND deleted_at IS NULL;
```

### Channel identity linking

```sql
CREATE TABLE channel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('web','telegram','whatsapp','discord')),
  external_id         text NOT NULL,          -- telegram user id, wa phone hash, …
  external_handle     text,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (channel, external_id)
);

-- Short-lived codes for linking a bot chat to a web account.
CREATE TABLE channel_link_codes (
  code        text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
```

> **Privacy note:** for WhatsApp, `external_id` stores a salted hash of the phone number, not the number. The salt is a server secret. We never need to recover the plaintext.

---

## 2. Worlds

```sql
CREATE TABLE worlds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  tagline         text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  genre           text[] NOT NULL DEFAULT '{}',
  cover_url       text,
  visibility      text NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private','unlisted','public')),
  content_rating  text NOT NULL DEFAULT 'general'
                    CHECK (content_rating IN ('general','teen','mature')),
  origin_world_id uuid REFERENCES worlds(id),   -- set when forked from a published world
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived','suspended')),
  last_played_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX worlds_owner_active ON worlds(owner_id, last_played_at DESC)
  WHERE deleted_at IS NULL;

-- Explicit, structured rules. Injected selectively, never all at once.
CREATE TABLE world_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id    uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  rule_text   text NOT NULL,
  category    text NOT NULL DEFAULT 'general'
                CHECK (category IN ('general','magic','technology','politics',
                                    'physics','society','tone','forbidden')),
  scope       text NOT NULL DEFAULT 'always'
                CHECK (scope IN ('always','contextual')),
  keywords    text[] NOT NULL DEFAULT '{}',   -- for contextual injection matching
  priority    smallint NOT NULL DEFAULT 50,   -- higher wins when the budget is tight
  is_hard     boolean NOT NULL DEFAULT false, -- hard rules are also validated in code
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_rules_lookup ON world_rules(world_id, scope, priority DESC);

-- The authoritative, versioned state of the world. ONE row per world.
CREATE TABLE world_state (
  world_id        uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  version         bigint NOT NULL DEFAULT 1,        -- optimistic concurrency token
  day             integer NOT NULL DEFAULT 1,
  time_of_day     text NOT NULL DEFAULT 'morning'
                    CHECK (time_of_day IN ('dawn','morning','midday','afternoon',
                                           'evening','night','late_night')),
  current_location text,
  weather         text,
  chapter         integer NOT NULL DEFAULT 1,
  chapter_title   text,
  scene_summary   text NOT NULL DEFAULT '',
  flags           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- named booleans/counters
  numerics        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- stability: 41, gold: 1240, …
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

> **`flags` and `numerics` are jsonb on purpose.** Every world defines different state variables; a fixed column set would be wrong for all of them. They are still authoritative — only validated tool calls write them, and each world declares its allowed keys in `world_settings`.

```sql
CREATE TABLE world_settings (
  world_id            uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  max_responders      smallint NOT NULL DEFAULT 3,
  narration_style     text NOT NULL DEFAULT 'balanced',
  perspective         text NOT NULL DEFAULT 'second'
                        CHECK (perspective IN ('first','second','third')),
  allow_time_skip     boolean NOT NULL DEFAULT true,
  memory_aggressiveness real NOT NULL DEFAULT 0.5 CHECK (memory_aggressiveness BETWEEN 0 AND 1),
  declared_flags      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- key → {type, min, max, default}
  declared_numerics   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id     uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  parent_id    uuid REFERENCES world_locations(id),
  discovered   boolean NOT NULL DEFAULT true,
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (world_id, name)
);

-- Multiplayer / shared worlds. Single-player MVP inserts one owner row.
CREATE TABLE world_members (
  world_id    uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  persona_id  uuid REFERENCES personas(id),
  role        text NOT NULL DEFAULT 'player'
                CHECK (role IN ('owner','gm','player','observer')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, user_id)
);
```

---

## 3. Characters

```sql
CREATE TABLE characters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id        uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name            text NOT NULL,
  role            text,                          -- 'mother', 'blacksmith', 'antagonist'
  avatar_url      text,
  summary         text NOT NULL DEFAULT '',      -- one line, used in rosters
  appearance      text NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT true,
  is_alive        boolean NOT NULL DEFAULT true,
  talkativeness   real NOT NULL DEFAULT 0.5 CHECK (talkativeness BETWEEN 0 AND 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (world_id, name)
);

CREATE TABLE character_profiles (
  character_id    uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  personality     text NOT NULL DEFAULT '',
  traits          text[] NOT NULL DEFAULT '{}',
  speech_style    text NOT NULL DEFAULT '',
  values_beliefs  text NOT NULL DEFAULT '',
  fears           text[] NOT NULL DEFAULT '{}',
  backstory       text NOT NULL DEFAULT '',
  example_lines   text[] NOT NULL DEFAULT '{}',  -- few-shot anchors for voice
  forbidden       text[] NOT NULL DEFAULT '{}',  -- things this character never does
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE character_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  goal          text NOT NULL,
  kind          text NOT NULL DEFAULT 'long_term'
                  CHECK (kind IN ('immediate','short_term','long_term','hidden')),
  priority      smallint NOT NULL DEFAULT 50,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','achieved','abandoned','blocked')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE character_secrets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id      uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  secret            text NOT NULL,
  severity          real NOT NULL DEFAULT 0.5 CHECK (severity BETWEEN 0 AND 1),
  known_by          uuid[] NOT NULL DEFAULT '{}',   -- other character ids
  revealed_to_user  boolean NOT NULL DEFAULT false,
  reveal_condition  text,                            -- prose hint for the model
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The knowledge-isolation table. This is what makes secrets enforceable.
CREATE TABLE character_knowledge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  memory_id     uuid REFERENCES memories(id) ON DELETE CASCADE,
  fact          text,                        -- for facts not stored as memories
  knows         boolean NOT NULL DEFAULT true,
  certainty     real NOT NULL DEFAULT 1.0 CHECK (certainty BETWEEN 0 AND 1),
  learned_at_day integer,
  source        text CHECK (source IN ('witnessed','told','inferred','overheard','authored')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (memory_id IS NOT NULL OR fact IS NOT NULL)
);
CREATE INDEX character_knowledge_lookup
  ON character_knowledge(character_id, knows) WHERE knows;
CREATE INDEX character_knowledge_by_memory ON character_knowledge(memory_id);
```

> **Design note.** `character_knowledge` is a *positive* index: a character knows what is listed. World-scope memories are visible to all present characters by default; anything sensitive is created with explicit per-character rows. Retrieval joins against this table, so a character physically cannot retrieve what they do not know. Knowledge isolation is a query, never a prompt instruction. ([04](04-memory-engine.md) § Isolation)

---

## 4. Relationships

```sql
CREATE TABLE relationships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id       uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  -- Directional: from_ perceives to_. Both directions may exist with different values.
  from_type      text NOT NULL CHECK (from_type IN ('character','persona')),
  from_id        uuid NOT NULL,
  to_type        text NOT NULL CHECK (to_type IN ('character','persona')),
  to_id          uuid NOT NULL,
  trust          smallint NOT NULL DEFAULT 0  CHECK (trust       BETWEEN -100 AND 100),
  affection      smallint NOT NULL DEFAULT 0  CHECK (affection   BETWEEN -100 AND 100),
  respect        smallint NOT NULL DEFAULT 0  CHECK (respect     BETWEEN -100 AND 100),
  fear           smallint NOT NULL DEFAULT 0  CHECK (fear        BETWEEN -100 AND 100),
  romance        smallint NOT NULL DEFAULT 0  CHECK (romance     BETWEEN -100 AND 100),
  loyalty        smallint NOT NULL DEFAULT 0  CHECK (loyalty     BETWEEN -100 AND 100),
  hostility      smallint NOT NULL DEFAULT 0  CHECK (hostility   BETWEEN -100 AND 100),
  familiarity    smallint NOT NULL DEFAULT 0  CHECK (familiarity BETWEEN 0 AND 100),
  status_label   text,                        -- derived, cached: 'wary ally'
  last_interaction_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, from_type, from_id, to_type, to_id)
);

-- Append-only audit of every change. Powers the relationship timeline UI
-- and lets us debug "why does she hate me".
CREATE TABLE relationship_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  uuid NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  world_id         uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  event_id         uuid REFERENCES world_events(id) ON DELETE SET NULL,
  deltas           jsonb NOT NULL,             -- {"trust": -7, "hostility": 4}
  reason           text NOT NULL,
  source           text NOT NULL DEFAULT 'model'
                     CHECK (source IN ('model','rule','decay','manual','import')),
  world_day        integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationship_events_recent
  ON relationship_events(relationship_id, created_at DESC);
```

---

## 5. Conversations and messages

```sql
CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id       uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  persona_id     uuid REFERENCES personas(id),
  title          text,
  channel        text NOT NULL DEFAULT 'web',
  scene_location text,
  present_character_ids uuid[] NOT NULL DEFAULT '{}',
  message_count  integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  summary        text NOT NULL DEFAULT '',      -- rolling summary of older turns
  summary_upto_seq integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','ended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  world_id       uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  seq            integer NOT NULL,              -- monotonic within conversation
  turn_id        uuid NOT NULL,                 -- groups one user input + N replies
  speaker_type   text NOT NULL
                   CHECK (speaker_type IN ('user','character','narrator','system')),
  speaker_id     uuid,                          -- persona_id or character_id
  content        text NOT NULL,
  content_tokens integer,
  status         text NOT NULL DEFAULT 'complete'
                   CHECK (status IN ('pending','streaming','complete','failed','moderated')),
  model_request_id uuid,
  moderation     jsonb,                         -- verdicts, if screened
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_recent ON messages(conversation_id, seq DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX messages_by_turn ON messages(turn_id);

CREATE TABLE conversation_locks (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  holder          text NOT NULL,        -- request id
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

-- Webhook idempotency.
CREATE TABLE channel_message_ids (
  channel              text NOT NULL,
  provider_message_id  text NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, provider_message_id)
);
```

---

## 6. Memory

```sql
CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind          text NOT NULL
                  CHECK (kind IN ('episodic','semantic','relational',
                                  'world','persona','reflection')),
  content       text NOT NULL,                -- ONE fact, one sentence, third person
  subjects      uuid[] NOT NULL DEFAULT '{}', -- characters/personas involved
  location      text,
  world_day     integer,
  importance    real NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence    real NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  visibility    text NOT NULL DEFAULT 'world'
                  CHECK (visibility IN ('world','restricted','private')),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  is_pinned     boolean NOT NULL DEFAULT false,   -- always retrieved
  is_user_edited boolean NOT NULL DEFAULT false,  -- user corrections are protected
  superseded_by uuid REFERENCES memories(id),     -- set by consolidation
  access_count  integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX memories_active ON memories(world_id, kind, importance DESC)
  WHERE deleted_at IS NULL AND superseded_by IS NULL;
CREATE INDEX memories_subjects ON memories USING gin(subjects);
CREATE INDEX memories_fts ON memories
  USING gin(to_tsvector('english', content));
CREATE INDEX memories_trgm ON memories USING gin(content gin_trgm_ops);

-- Separate table: embeddings are large, regenerable, and versioned independently.
CREATE TABLE memory_embeddings (
  memory_id       uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding       halfvec(768) NOT NULL,
  embedding_model text NOT NULL,
  embedding_version smallint NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_embeddings_hnsw ON memory_embeddings
  USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Explicit relations between memories: causes, contradicts, elaborates.
CREATE TABLE memory_links (
  from_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation       text NOT NULL
                   CHECK (relation IN ('causes','contradicts','elaborates',
                                       'supersedes','same_event')),
  strength       real NOT NULL DEFAULT 1.0,
  PRIMARY KEY (from_memory_id, to_memory_id, relation)
);
```

> **Why `halfvec(768)`:** 768 dimensions is the common output size for the small open embedding models available on free tiers, and half-precision halves storage at negligible recall cost at our scale. `embedding_model` + `embedding_version` exist so that changing embedding provider is a background re-embed job, not an outage. **Never assume a fixed model.**

---

## 7. Events, quests, inventory

```sql
CREATE TABLE world_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_day     integer NOT NULL,
  chapter       integer,
  title         text NOT NULL,
  description   text NOT NULL,
  event_type    text NOT NULL DEFAULT 'story'
                  CHECK (event_type IN ('story','combat','social','discovery',
                                        'death','betrayal','romance','quest','system')),
  participants  uuid[] NOT NULL DEFAULT '{}',
  location      text,
  importance    real NOT NULL DEFAULT 0.5,
  consequences  text[] NOT NULL DEFAULT '{}',
  turn_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_events_timeline ON world_events(world_id, world_day DESC, created_at DESC);

CREATE TABLE quests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  giver_id      uuid REFERENCES characters(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','active','completed','failed','abandoned')),
  is_main       boolean NOT NULL DEFAULT false,
  started_day   integer,
  ended_day     integer,
  reward        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quest_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id      uuid NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  ordinal       smallint NOT NULL,
  description   text NOT NULL,
  completion    text NOT NULL,               -- human-readable completion condition
  predicate     jsonb,                       -- machine-checkable condition, if expressible
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','completed','failed','skipped')),
  completed_day integer,
  UNIQUE (quest_id, ordinal)
);

CREATE TABLE items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  item_type     text NOT NULL DEFAULT 'misc',
  properties    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_unique     boolean NOT NULL DEFAULT false,
  UNIQUE (world_id, name)
);

CREATE TABLE inventory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  holder_type   text NOT NULL CHECK (holder_type IN ('persona','character','location')),
  holder_id     uuid NOT NULL,
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  equipped      boolean NOT NULL DEFAULT false,
  acquired_day  integer,
  UNIQUE (world_id, holder_type, holder_id, item_id)
);

CREATE TABLE story_chapters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  number        integer NOT NULL,
  title         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  main_conflict text,
  open_threads  text[] NOT NULL DEFAULT '{}',
  started_day   integer,
  ended_day     integer,
  UNIQUE (world_id, number)
);
```

---

## 8. AI usage, billing, jobs

```sql
CREATE TABLE model_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  world_id        uuid REFERENCES worlds(id) ON DELETE SET NULL,
  turn_id         uuid,
  task_class      text NOT NULL,              -- 'dialogue','plan','extract','moderate',…
  provider        text NOT NULL,
  model           text NOT NULL,
  tier            text NOT NULL,              -- 'fast','standard','deep'
  input_tokens    integer,
  output_tokens   integer,
  latency_ms      integer,
  ttfb_ms         integer,
  success         boolean NOT NULL,
  error_code      text,
  attempt         smallint NOT NULL DEFAULT 1,
  fallback_from   text,                       -- model we fell back from
  compute_units   integer NOT NULL DEFAULT 0,
  est_cost_micros bigint NOT NULL DEFAULT 0,  -- micro-rupees; 0 for free endpoints
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_requests_user_day ON model_requests(user_id, created_at DESC);
CREATE INDEX model_requests_model_health ON model_requests(model, created_at DESC);

CREATE TABLE plans (
  code            text PRIMARY KEY,           -- 'free','creator','pro'
  name            text NOT NULL,
  price_minor     integer NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'INR',
  entitlements    jsonb NOT NULL,             -- see 14 § Entitlement schema
  is_public       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_code         text NOT NULL REFERENCES plans(code),
  status            text NOT NULL
                      CHECK (status IN ('trialing','active','past_due','canceled','expired')),
  provider          text,                     -- payment provider
  provider_sub_id   text UNIQUE,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_one_active ON subscriptions(user_id)
  WHERE status IN ('trialing','active','past_due');

-- Daily rollup of compute consumption. The spine of cost control.
CREATE TABLE usage_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  usage_date    date NOT NULL,
  meter         text NOT NULL,       -- 'compute_units','messages','images','voice_seconds'
  amount        integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, usage_date, meter)
);

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text UNIQUE,
  priority        smallint NOT NULL DEFAULT 50,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','failed','dead')),
  attempts        smallint NOT NULL DEFAULT 0,
  max_attempts    smallint NOT NULL DEFAULT 5,
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX jobs_claimable ON jobs(status, run_after, priority DESC)
  WHERE status = 'pending';

CREATE TABLE rate_limits (
  bucket        text PRIMARY KEY,     -- 'user:<id>:turn:2026-09-03T14'
  count         integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);
```

> Hot rate-limit counters live in Cloudflare KV for speed; the `rate_limits` table is the durable fallback and the audit surface.

---

## 9. Moderation and trust & safety

```sql
CREATE TABLE moderation_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  world_id      uuid REFERENCES worlds(id) ON DELETE SET NULL,
  surface       text NOT NULL CHECK (surface IN ('input','output','world','character','profile')),
  stage         text NOT NULL CHECK (stage IN ('heuristic','classifier','llm','human')),
  verdict       text NOT NULL CHECK (verdict IN ('allow','flag','block')),
  categories    text[] NOT NULL DEFAULT '{}',
  score         real,
  content_hash  text NOT NULL,          -- SHA-256. NEVER the content itself.
  action_taken  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  target_type   text NOT NULL CHECK (target_type IN ('world','character','user','message')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL,
  details       text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','reviewing','actioned','dismissed')),
  resolution    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE TABLE enforcement_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('warn','restrict','suspend','ban')),
  reason        text NOT NULL,
  report_id     uuid REFERENCES reports(id),
  expires_at    timestamptz,
  created_by    text NOT NULL,          -- 'system' or staff id
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every staff read of user content. Non-negotiable (01 § P9).
CREATE TABLE admin_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor         text NOT NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     uuid,
  justification text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 10. Creator and marketplace *(later — Phase 15/20)*

```sql
CREATE TABLE published_worlds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id        uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slug            citext UNIQUE NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  snapshot        jsonb NOT NULL,     -- frozen world/characters/lore at publish time
  play_count      integer NOT NULL DEFAULT 0,
  fork_count      integer NOT NULL DEFAULT 0,
  rating_sum      integer NOT NULL DEFAULT 0,
  rating_count    integer NOT NULL DEFAULT 0,
  review_status   text NOT NULL DEFAULT 'pending'
                    CHECK (review_status IN ('pending','approved','rejected','delisted')),
  published_at    timestamptz
);

CREATE TABLE marketplace_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_type     text NOT NULL CHECK (item_type IN ('world','campaign','character_pack','lorebook')),
  ref_id        uuid NOT NULL,
  price_minor   integer NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'INR',
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','review','listed','delisted')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 11. Row-level security

**Every user-data table has RLS enabled. No exceptions.** The service-role key bypasses RLS and is therefore treated as a break-glass credential ([12](12-security.md)).

Standard pattern:

```sql
ALTER TABLE worlds ENABLE ROW LEVEL SECURITY;

CREATE POLICY worlds_select ON worlds FOR SELECT
  USING (
    deleted_at IS NULL AND (
      owner_id = auth.uid()
      OR visibility = 'public'
      OR EXISTS (SELECT 1 FROM world_members m
                 WHERE m.world_id = worlds.id AND m.user_id = auth.uid())
    )
  );

CREATE POLICY worlds_insert ON worlds FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY worlds_update ON worlds FOR UPDATE
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
```

Child tables authorize through their parent world:

```sql
CREATE POLICY characters_all ON characters FOR ALL
  USING (EXISTS (
    SELECT 1 FROM worlds w
    WHERE w.id = characters.world_id
      AND (w.owner_id = auth.uid()
           OR EXISTS (SELECT 1 FROM world_members m
                      WHERE m.world_id = w.id AND m.user_id = auth.uid()))
  ));
```

**Critical warning.** RLS is the *second* line of defence. The backend also authorizes every request in its service layer, because bot channels do not carry a Supabase JWT and therefore run under a server identity. Never rely on RLS alone for a code path a bot can reach.

`character_knowledge` is a special case: it is readable by the world's members (so the Memory Notebook can show it) but **retrieval queries must still join it** — RLS controls *who* can read the table, not *which character* may use a row.

---

## 12. Migration strategy

1. **Forward-only.** No down migrations. A mistake is corrected by a new migration.
2. **Backwards-compatible in two steps.** Adding a required column: (a) add nullable + backfill, (b) add the constraint in a later migration once code writes it.
3. **Never drop in the same release as the code change.** Ship code that stops using a column; drop it a release later.
4. **Index creation on populated tables uses `CONCURRENTLY`** — and therefore lives in its own migration file with no transaction wrapper.
5. **Every migration is tested against a seeded staging copy** before production.
6. **`db/schema.sql` is regenerated after each migration** and committed, so schema diffs are reviewable in PRs.

### Migration order for Phase 2

```
0001_extensions.sql              pgcrypto, vector, pg_trgm, unaccent, citext
0002_profiles_personas.sql
0003_worlds.sql                  worlds, rules, state, settings, members, locations
0004_characters.sql              characters, profiles, goals, secrets
0005_conversations_messages.sql  + conversation_locks, channel_message_ids
0006_memory.sql                  memories, embeddings, links  (+ character_knowledge FK)
0007_relationships.sql
0008_events_quests_inventory.sql
0009_ai_usage.sql                model_requests, plans, subscriptions, usage_ledger
0010_jobs_ratelimits.sql
0011_moderation.sql
0012_channels.sql                channel_accounts, link codes
0013_rls_policies.sql            all policies, in one reviewable file
0014_seed_plans.sql              free/creator/pro rows
```

> `character_knowledge` references `memories`, and `relationship_events` references `messages` — hence the ordering above. Where a cycle is unavoidable, add the FK in a trailing `ALTER TABLE` migration rather than reordering table creation.
