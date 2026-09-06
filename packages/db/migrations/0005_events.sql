/*
 * EVENTS — the canonical record (ADR-025, frozen by ADR-028).
 *
 * An event is something that HAPPENED. Immutable, never revised. What is TRUE
 * NOW is folded from this log deterministically and never stored twice.
 *
 * Every column here corresponds to a field of `WorldEventSchema` in
 * packages/contracts. That correspondence is the point: the schema is the
 * frozen architecture, and a table that drops a field it does not currently read
 * is how the architecture quietly becomes the demo. `knownBy` in particular
 * exists even though V0.1 has ONE character and cannot leak to anybody — it is
 * the reason the tenth character costs nothing.
 *
 * Names, not ids, in actor/target/participants/known_by. Settled, and expensive
 * to relearn: requiring `character:<uuid>` refs made one malformed ref reject an
 * entire validated batch and three of four worlds extracted nothing.
 */

create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  world_id      uuid not null references worlds(id) on delete cascade,

  -- Ordering: world_day is the in-world clock, seq breaks ties within a day and
  -- is globally monotonic per world. Projections fold in (day, seq) order.
  world_day     integer not null check (world_day >= 0),
  seq           integer not null check (seq >= 0),

  type          text not null check (type in (
                  'acquired','gave','lost',
                  'promised','refused','fulfilled',
                  'asked','answered',
                  'revealed','observed',
                  'relation_stated','relation_changed',
                  'preference_stated','numeric_stated',
                  'world_event')),

  actor         text not null check (length(trim(actor)) > 0),
  target        text,
  object        text,

  value         text check (value is null or length(value) <= 300),
  quantity      double precision,
  location      text,

  participants  text[] not null default '{}',
  visibility    text not null default 'world'
                  check (visibility in ('world','witnessed','private')),
  known_by      text[] not null default '{}',
  importance    real not null default 0.5 check (importance between 0 and 1),

  /*
   * WHO MAY RECALL THIS — computed once, at write time, and stored.
   *
   * This column resolves a real conflict between two of our own rules.
   *
   *   CLAUDE.md § 5: "No knowledge filtering in application code — it happens in
   *   SQL." Because models leak under pressure and SQL does not.
   *
   *   core/world/knowledge.ts: there must be exactly ONE implementation of the
   *   audience rule. That file exists BECAUSE there were two and they disagreed,
   *   and a character described a cellar door she had never seen.
   *
   * Reimplementing `audienceFor` in plpgsql would satisfy the first rule by
   * breaking the second — the same defect in a new language, and the harder
   * version to test. Filtering in TypeScript after an unfiltered read would
   * satisfy the second by breaking the first.
   *
   * So: `audienceFor()` stays the single implementation and runs at INSERT, and
   * its OUTPUT lives here. Retrieval filters with `audience @> array[$who]` — in
   * SQL, in the query, impossible for a caller to skip. One rule, one
   * implementation, and the unfiltered read is still impossible to express.
   *
   * Consequence, accepted: the audience is frozen at write time, so changing the
   * rule requires recomputing this column from the event log. That is a
   * migration and a script, and it is the correct amount of friction for
   * changing who may know what.
   *
   * `not null` with no default: an event whose audience was never computed must
   * fail loudly at insert. A default of '{}' would silently mean "nobody" and a
   * default of anything else would silently mean "leak".
   */
  audience      text[] not null,

  -- The turn this was read from. The transcript stays the ground truth, so an
  -- event can always be traced back to the sentence that produced it — which is
  -- how the audience leak was finally diagnosed rather than guessed at.
  source_turn   integer not null check (source_turn >= 0),
  caused_by     text,

  created_at    timestamptz not null default now(),

  unique (world_id, seq)
);

create index if not exists events_world_order on events(world_id, world_day, seq);
create index if not exists events_world_type  on events(world_id, type);
create index if not exists events_participants on events using gin (participants);
-- The isolation filter. Every read of an event by a character goes through this.
create index if not exists events_audience    on events using gin (audience);

/*
 * Immutable, by the same trigger pattern as `turns` and for a stronger reason:
 * projections are a deterministic fold of this log, so an UPDATE here makes a
 * previously-correct projection unreproducible. The event log is the one place
 * where "we fixed the data" and "we can still explain the past" are in direct
 * conflict.
 *
 * A wrong event is corrected by appending a later event that supersedes it. That
 * is not a workaround — it is what "Marcus has the ring now" already means.
 */
create or replace function forbid_event_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('app.hard_delete', true), 'off') = 'on' then
    return old;
  end if;

  raise exception
    'events is append-only: % is not permitted. Append a superseding event.',
    tg_op
    using hint = 'Projections are a deterministic fold; editing history unfolds them.';
end;
$$;

drop trigger if exists events_no_update on events;
create trigger events_no_update before update or delete on events
  for each row execute function forbid_event_mutation();

/*
 * `seq` counts events, independently of the turn counter.
 *
 * The two do not need a shared total order: projections fold events by
 * (world_day, seq), and "which turn was this read from" is answered by
 * `source_turn` directly rather than by comparing two counters.
 */
create or replace function next_event_seq(p_world_id uuid) returns integer
language plpgsql
as $$
declare
  next_seq integer;
  locked   uuid;
begin
  select world_id into locked from world_state where world_id = p_world_id for update;
  if locked is null then
    raise exception 'world % has no world_state row', p_world_id;
  end if;
  select coalesce(max(seq), -1) + 1 into next_seq from events where world_id = p_world_id;
  return next_seq;
end;
$$;

/*
 * Every event traces to a real turn, enforced rather than assumed.
 *
 * This is the constraint that keeps the transcript authoritative. Without it,
 * `source_turn` is an integer that is usually right, and the first time it is
 * wrong is during an incident, when tracing an event back to the sentence that
 * produced it is the only tool available. That trace is exactly how the audience
 * leak was diagnosed after four runs of guessing.
 *
 * When the world engine starts emitting events (M1-T04), they still occur DURING
 * a turn and still name it. If an event ever genuinely has no originating turn,
 * that is a schema change with a reason, not a null slipped past a check.
 */
alter table events drop constraint if exists events_source_turn_fk;
alter table events add constraint events_source_turn_fk
  foreign key (world_id, source_turn) references turns(world_id, seq) on delete cascade;
