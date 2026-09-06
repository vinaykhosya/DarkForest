-- Extensions, and one shared trigger function.
--
-- Everything here is idempotent, because 0001 is the migration most likely to be
-- run against a database that already has some of it (a Supabase project ships
-- with pgcrypto and vector available, and sometimes enabled).

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists vector;     -- pgvector, for the memory index
create extension if not exists pg_trgm;    -- fuzzy name matching
create extension if not exists unaccent;
create extension if not exists citext;     -- handles are case-insensitive

-- `updated_at` maintained by the database rather than by every caller.
-- A caller that forgets produces a row whose timestamp lies, and nothing catches
-- it until someone sorts by it.
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
