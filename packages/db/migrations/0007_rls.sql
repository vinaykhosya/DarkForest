/*
 * ROW-LEVEL SECURITY on every table. docs/03 § 11, CLAUDE.md § 5.
 *
 * READ THIS BEFORE TRUSTING ANY OF IT (ADR-030): these policies do nothing at
 * all if the API connects as `postgres` or `service_role`. Not "less" — nothing.
 * The policies exist, the CI check finds them, negative tests run against raw
 * SQL still pass, and in production every request bypasses the lot. That is why
 * `asUser()` drops to the `authenticated` role, and why V1-T09's negative tests
 * must go through the API rather than only through SQL.
 *
 * Ownership flows outward from `worlds.owner_id`. Everything else — characters,
 * turns, events, memories — belongs to whoever owns its world. Each policy
 * re-derives that rather than trusting a denormalised owner column, because a
 * denormalised owner that drifts is an access-control bug rather than a stale
 * field.
 *
 * `enable` + no permissive policy = deny. Every table below therefore starts
 * closed and is opened deliberately, one statement at a time.
 */

alter table profiles            enable row level security;
alter table worlds              enable row level security;
alter table world_state         enable row level security;
alter table characters          enable row level security;
alter table turns               enable row level security;
alter table events              enable row level security;
alter table memories            enable row level security;
alter table memory_embeddings   enable row level security;
alter table character_knowledge enable row level security;
alter table schema_migrations   enable row level security;

-- ── profiles ────────────────────────────────────────────────────────────────
-- A user reads and edits their own profile. No policy grants INSERT: profiles
-- are created by the `on_auth_user_created` trigger, which runs as definer.
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles
  for select using (id = auth.uid());

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ── worlds ──────────────────────────────────────────────────────────────────
drop policy if exists worlds_owner_all on worlds;
create policy worlds_owner_all on worlds
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

/*
 * Public worlds are readable by anyone signed in. Separate from the owner policy
 * on purpose: policies are OR-ed, so the owner keeps full access while everyone
 * else gets SELECT only, and there is no combined predicate to misread later.
 */
drop policy if exists worlds_public_select on worlds;
create policy worlds_public_select on worlds
  for select using (visibility = 'public' and deleted_at is null);

-- ── everything owned through a world ────────────────────────────────────────
-- One shared predicate, written once. A helper function rather than a repeated
-- subquery so that changing what "owns" means is a single edit.
create or replace function owns_world(p_world_id uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from worlds w
    where w.id = p_world_id and w.owner_id = auth.uid() and w.deleted_at is null
  );
$$;

drop policy if exists world_state_owner on world_state;
create policy world_state_owner on world_state
  for all using (owns_world(world_id)) with check (owns_world(world_id));

drop policy if exists characters_owner on characters;
create policy characters_owner on characters
  for all using (owns_world(world_id)) with check (owns_world(world_id));

drop policy if exists turns_owner on turns;
create policy turns_owner on turns
  for all using (owns_world(world_id)) with check (owns_world(world_id));

drop policy if exists events_owner on events;
create policy events_owner on events
  for all using (owns_world(world_id)) with check (owns_world(world_id));

drop policy if exists memories_owner on memories;
create policy memories_owner on memories
  for all using (owns_world(world_id)) with check (owns_world(world_id));

/*
 * `memory_embeddings` and `character_knowledge` have no world_id of their own,
 * so they resolve ownership through their parent.
 *
 * NOTE what this policy is NOT. It is the ACCOUNT boundary: it stops user B
 * reading user A's rows. It is NOT the character knowledge boundary — a world's
 * owner can legitimately read every memory in their own world, and it is the
 * retrieval query (`audience @> array[$who]`, `character_knowledge`) that
 * decides what a CHARACTER may recall. Two different boundaries, and confusing
 * them is how "RLS is on" comes to be mistaken for "characters cannot leak".
 */
drop policy if exists memory_embeddings_owner on memory_embeddings;
create policy memory_embeddings_owner on memory_embeddings
  for all using (
    exists (select 1 from memories m where m.id = memory_id and owns_world(m.world_id))
  ) with check (
    exists (select 1 from memories m where m.id = memory_id and owns_world(m.world_id))
  );

drop policy if exists character_knowledge_owner on character_knowledge;
create policy character_knowledge_owner on character_knowledge
  for all using (
    exists (select 1 from characters c where c.id = character_id and owns_world(c.world_id))
  ) with check (
    exists (select 1 from characters c where c.id = character_id and owns_world(c.world_id))
  );

-- ── schema_migrations ───────────────────────────────────────────────────────
-- RLS enabled, no policy: nobody but the migration runner (which is not
-- `authenticated`) touches it. Present so the "every table has RLS" check has
-- no exception list — an exception list is where the next unprotected table
-- hides.

/*
 * THE CHECK THAT MAKES THIS ENFORCEABLE (V1-T08).
 *
 * A view rather than a script, so the CI check is one query and the answer is a
 * row count. A new table with no RLS appears here the moment it is created,
 * which is the only version of this that survives someone adding a table in a
 * hurry.
 */
create or replace view public_tables_without_rls as
  select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;
