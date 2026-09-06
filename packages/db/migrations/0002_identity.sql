-- Identity. `profiles` mirrors `auth.users`; application data never lives in the
-- auth schema, which we do not own and cannot migrate.
--
-- docs/03 § 1. V0.1 implements the columns it uses; the rest are added by later
-- migrations rather than invented now with no reader.

create table if not exists profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  handle            citext unique not null,
  display_name      text not null,
  locale            text not null default 'en',
  timezone          text not null default 'UTC',
  status            text not null default 'active'
                      check (status in ('active','suspended','banned','deletion_pending')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

drop trigger if exists profiles_updated_at on profiles;
create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

/*
 * A profile is created BY THE DATABASE when an auth user appears.
 *
 * The alternative is the application creating it after sign-up, which is one
 * network call that can fail between "the account exists" and "the account can
 * do anything". That state is unrecoverable from the client — the user is signed
 * in, has no profile, and every subsequent request fails a foreign key. A
 * trigger makes the two facts the same transaction.
 *
 * `security definer` because the trigger runs as the signing-up user, who has no
 * rights on `profiles`. `search_path` is pinned: a `security definer` function
 * without it is a privilege-escalation hole, since a caller who can create a
 * schema can shadow `profiles` and have this insert into their own table.
 */
create or replace function handle_new_auth_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  base text;
  candidate text;
  suffix int := 0;
begin
  -- A handle must exist and be unique. Derive one rather than asking for it at
  -- sign-up: a blocked sign-up is worse than an ugly handle the user can change.
  base := lower(regexp_replace(split_part(coalesce(new.email, 'traveller'), '@', 1),
                               '[^a-z0-9_]', '', 'g'));
  if length(base) < 3 then base := 'traveller'; end if;
  base := left(base, 24);
  candidate := base;

  while exists (select 1 from profiles where handle = candidate) loop
    suffix := suffix + 1;
    candidate := left(base, 24) || suffix::text;
  end loop;

  insert into profiles (id, handle, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data->>'display_name', candidate))
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_auth_user();
