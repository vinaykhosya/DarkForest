-- Worlds and characters. docs/03 § 2 and § 3, subset for V0.1.
--
-- Column names and types match the specification exactly even where V0.1 does
-- not read them, so later migrations ADD columns rather than rename them. A
-- rename is the expensive kind of migration; an addition is free.

create table if not exists worlds (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references profiles(id) on delete cascade,
  name            text not null,
  tagline         text not null default '',
  description     text not null default '',
  genre           text[] not null default '{}',
  visibility      text not null default 'private'
                    check (visibility in ('private','unlisted','public')),
  content_rating  text not null default 'general'
                    check (content_rating in ('general','teen','mature')),
  status          text not null default 'active'
                    check (status in ('active','archived','suspended')),
  last_played_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists worlds_owner_active
  on worlds(owner_id, last_played_at desc nulls last) where deleted_at is null;

drop trigger if exists worlds_updated_at on worlds;
create trigger worlds_updated_at before update on worlds
  for each row execute function set_updated_at();

/*
 * The in-world clock. ONE row per world, and it is the source of `world_day`,
 * which every event is stamped with.
 *
 * It lives in its own table rather than as a column on `worlds` because it is
 * written on every turn while the rest of `worlds` is written almost never, and
 * because `version` is the optimistic-concurrency token for the world engine
 * that V0.2 adds. Putting it here now costs one join and avoids moving it later.
 */
create table if not exists world_state (
  world_id    uuid primary key references worlds(id) on delete cascade,
  version     bigint  not null default 1,
  day         integer not null default 1 check (day >= 0),
  time_of_day text    not null default 'morning'
                check (time_of_day in ('dawn','morning','midday','afternoon',
                                       'evening','night','late_night')),
  updated_at  timestamptz not null default now()
);

drop trigger if exists world_state_updated_at on world_state;
create trigger world_state_updated_at before update on world_state
  for each row execute function set_updated_at();

create table if not exists characters (
  id            uuid primary key default gen_random_uuid(),
  world_id      uuid not null references worlds(id) on delete cascade,
  name          text not null,
  role          text not null default '',
  persona       text not null default '',
  speech_style  text not null default '',
  traits        text[] not null default '{}',
  status        text not null default 'active'
                  check (status in ('active','absent','dead','retired')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists characters_world on characters(world_id) where deleted_at is null;

/*
 * Character names are unique per world, case-insensitively.
 *
 * This is not cosmetic. Events address people BY NAME — the extractor emits
 * `actor: "Elena"`, never a uuid, and that decision is settled (contracts/events
 * records what requiring uuid refs cost). Knowledge isolation then resolves a
 * name to a person. Two characters a world calls "Elena" makes `canRecall`
 * ambiguous, and the failure mode of an ambiguous audience check is a character
 * recalling something the other Elena was told.
 */
create unique index if not exists characters_name_unique_per_world
  on characters(world_id, lower(name)) where deleted_at is null;

drop trigger if exists characters_updated_at on characters;
create trigger characters_updated_at before update on characters
  for each row execute function set_updated_at();
