/*
 * TURNS — the raw transcript, and the ground truth of the whole system.
 *
 * Everything downstream is derived: events are extracted from turns, projections
 * are folded from events, the memory index is built from both. If any of those
 * is wrong, it can be rebuilt from here. If THIS is wrong, nothing can.
 *
 * So it is append-only, and that is enforced by a trigger rather than by
 * convention. `contracts/events.ts` already states the rule for events — "an
 * event is something that HAPPENED, it is immutable and never revised" — and the
 * transcript it was read from has to be at least as durable as it is.
 *
 * Editing a past turn is a real product idea (users will ask). It is not an
 * UPDATE: it is a new turn that supersedes, so the history of what the character
 * actually saw at the time survives. That is a V0.3 conversation, and this
 * trigger is what stops it being decided by accident in a hotfix.
 */

create table if not exists turns (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references worlds(id) on delete cascade,
  -- Monotonic per world, assigned by the database (see below) rather than by the
  -- caller, so two concurrent turns cannot claim the same number. Events
  -- reference this value as `source_turn`, so it is a stable address, not a
  -- display index.
  seq         integer not null check (seq >= 0),
  -- Who spoke. `character_id` is null for the player, and the pair is checked:
  -- a 'player' turn with a character, or a 'character' turn without one, is a
  -- row that no reader can interpret.
  speaker     text not null check (speaker in ('player','character','narrator')),
  character_id uuid references characters(id) on delete set null,
  content     text not null,
  world_day   integer not null check (world_day >= 0),
  created_at  timestamptz not null default now(),

  constraint turns_speaker_character_agree check (
    (speaker = 'character' and character_id is not null) or
    (speaker in ('player','narrator') and character_id is null)
  ),
  unique (world_id, seq)
);
create index if not exists turns_world_seq on turns(world_id, seq desc);

/*
 * The next `seq` for a world, taken under a row lock on `world_state`.
 *
 * Two turns arriving at once would otherwise both read max(seq)=41 and both
 * insert 42; one gets the unique violation and a user loses their message. The
 * lock is on `world_state` rather than on `turns` because a world is a
 * single-writer thing by nature — one person is typing — so contention is
 * near-zero and the correctness is absolute.
 */
create or replace function next_turn_seq(p_world_id uuid) returns integer
language plpgsql
as $$
declare
  next_seq integer;
  locked   uuid;
begin
  select world_id into locked from world_state where world_id = p_world_id for update;
  if locked is null then
    -- No row means no lock was taken, and the caller would proceed unserialised
    -- believing it held one. `world_state` is created with the world, so this is
    -- a broken world rather than a race — fail loudly instead of racing quietly.
    raise exception 'world % has no world_state row', p_world_id;
  end if;
  select coalesce(max(seq), -1) + 1 into next_seq from turns where world_id = p_world_id;
  return next_seq;
end;
$$;

/*
 * Append-only, with ONE named exception.
 *
 * A blanket ban on DELETE does not work: `worlds` cascades to `turns`, a row
 * trigger fires on cascaded deletes too, and a user who deletes their world
 * would get this exception instead. Worse, account deletion (docs/12) is a legal
 * obligation, so "nothing is ever deleted" was never actually the rule.
 *
 * The rule is: nothing deletes a turn as a side effect of ordinary work. Erasure
 * is deliberate, and it says so by setting `app.hard_delete` for the transaction
 * that performs it. Same reasoning as `asSystem(reason)` on the connection
 * boundary — the dangerous path stays available and becomes greppable.
 *
 * UPDATE has no exception. Editing a past turn is a real product request and it
 * is not an UPDATE: it is a new turn that supersedes, so what the character
 * actually saw at the time survives. That is a V0.3 design conversation, and
 * this trigger is what stops it being settled by accident in a hotfix.
 */
create or replace function forbid_turn_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('app.hard_delete', true), 'off') = 'on' then
    return old;
  end if;

  raise exception
    'turns is append-only: % is not permitted. Supersede with a new turn instead.',
    tg_op
    using hint = 'Deliberate erasure sets app.hard_delete for its transaction.';
end;
$$;

drop trigger if exists turns_no_update on turns;
create trigger turns_no_update before update or delete on turns
  for each row execute function forbid_turn_mutation();
