/*
 * THE MEMORY INDEX — derived, and rebuildable.
 *
 * This is the semantic search layer over what already happened. It is NOT the
 * record of what happened; `events` is. ADR-028 froze that ordering, and it is
 * the property that lets this whole table be dropped and rebuilt when the
 * embedding model changes — which it will.
 *
 * There is no projections table. `project()` is a pure fold over the event log
 * with one implementation, and a materialised copy is a second source of truth
 * that can silently disagree with it. That is precisely the defect
 * knowledge.ts documents. A snapshot becomes worthwhile when refolding a world
 * is measurably slow; at V0.1 scale it is microseconds, and an unused cache that
 * can diverge is worse than no cache.
 */

create table if not exists memories (
  id             uuid primary key default gen_random_uuid(),
  world_id       uuid not null references worlds(id) on delete cascade,
  kind           text not null check (kind in
                   ('fact','event','relationship','preference','secret','goal','world_rule')),
  content        text not null,
  subjects       text[] not null default '{}',
  location       text,
  world_day      integer,
  importance     real not null default 0.5 check (importance between 0 and 1),
  confidence     real not null default 1.0 check (confidence between 0 and 1),

  /*
   * Visibility mirrors the event vocabulary so knowledge isolation stays ONE
   * concept rather than two. A memory derived from an event inherits the
   * audience decision that event already made.
   */
  visibility     text not null default 'private'
                   check (visibility in ('world','witnessed','private')),

  is_pinned      boolean not null default false,
  is_user_edited boolean not null default false,

  -- The event this was derived from, when it was. Null for memories written
  -- directly (world rules, user-authored notes), which is why it is nullable
  -- rather than forced.
  source_event_id uuid references events(id) on delete cascade,

  superseded_by  uuid references memories(id),
  access_count   integer not null default 0,
  last_accessed_at timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists memories_world_live
  on memories(world_id) where deleted_at is null and superseded_by is null;
create index if not exists memories_subjects on memories using gin (subjects);
-- Keyword path. English stemming, matching what the lexical retriever expects.
create index if not exists memories_content_fts
  on memories using gin (to_tsvector('english', content));
create index if not exists memories_content_trgm
  on memories using gin (content gin_trgm_ops);

drop trigger if exists memories_updated_at on memories;
create trigger memories_updated_at before update on memories
  for each row execute function set_updated_at();

/*
 * Embeddings live in their own table, keyed by model AND version.
 *
 * Not a column on `memories`, because re-embedding a corpus is a background job
 * that runs for hours while the product keeps serving from the old vectors. With
 * one column you either take a write lock across the whole table or serve a
 * mixture of two vector spaces and call the cosine distances comparable. They
 * are not comparable, and the failure is silent: retrieval simply gets worse.
 *
 * 768 dimensions: Cloudflare Workers AI `bge-base-en-v1.5` (ADR-009, D-002).
 */
create table if not exists memory_embeddings (
  memory_id   uuid not null references memories(id) on delete cascade,
  model       text not null,
  version     integer not null,
  embedding   vector(768) not null,
  created_at  timestamptz not null default now(),
  primary key (memory_id, model, version)
);

-- HNSW over cosine distance. Built now so the query plan is the real one from
-- the first row; adding it at 10k memories means an index build on live data.
create index if not exists memory_embeddings_hnsw
  on memory_embeddings using hnsw (embedding vector_cosine_ops);

/*
 * WHO KNOWS WHAT. The isolation boundary for the memory index.
 *
 * A memory being in the world does not mean a character has it. This table is
 * the grant, and `characterId: null` in the store interface means the narrator,
 * which has world scope and therefore no row here.
 */
create table if not exists character_knowledge (
  character_id  uuid not null references characters(id) on delete cascade,
  memory_id     uuid not null references memories(id) on delete cascade,
  source        text not null check (source in
                  ('witnessed','told','overheard','inferred','authored')),
  certainty     real not null default 1.0 check (certainty between 0 and 1),
  learned_at_day integer,
  created_at    timestamptz not null default now(),
  primary key (character_id, memory_id)
);
create index if not exists character_knowledge_by_memory on character_knowledge(memory_id);
