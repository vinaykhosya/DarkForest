/*
 * The memory vocabulary must match `packages/contracts`. 0006 did not.
 *
 * 0006 constrained `kind` to fact/event/relationship/preference/secret/goal/
 * world_rule and `visibility` to world/witnessed/private. Neither set exists
 * anywhere in this system. The real ones are:
 *
 *   MemoryKindSchema        episodic, semantic, relational, world, persona, reflection
 *   MemoryVisibilitySchema  world, restricted, private
 *
 * So every insert from the frozen memory store would have been rejected by a
 * constraint quoting a vocabulary nothing uses.
 *
 * WHERE IT CAME FROM, since the answer changes what to do about it: I wrote
 * those constraints from memory instead of reading the specification. docs/03
 * § 6 has the correct enums, and has had them all along. This was not a
 * document contradiction to resolve — it was a table written without opening
 * the document it was supposed to implement.
 *
 * ROLLED FORWARD rather than edited into 0006, which is already applied. The
 * checksum guard exists to make that the only option, and being the first to be
 * inconvenienced by it is not a reason to make an exception to it.
 */

alter table memories drop constraint if exists memories_kind_check;
alter table memories add constraint memories_kind_check
  check (kind in ('episodic','semantic','relational','world','persona','reflection'));

alter table memories drop constraint if exists memories_visibility_check;
alter table memories add constraint memories_visibility_check
  check (visibility in ('world','restricted','private'));

/*
 * No default for `visibility`.
 *
 * 0006 defaulted it to 'private' and docs/03 defaults it to 'world'. Both are
 * defensible; a SILENT disagreement between them is not, because an insert that
 * omits the column would then mean one thing to the schema and another to every
 * reader of the specification. The store always supplies it, so requiring it
 * costs nothing and removes the ambiguity — the same reasoning as
 * `events.audience`.
 */
alter table memories alter column visibility drop default;

-- `content` has no length CHECK on purpose. MemoryContentSchema bounds it at
-- 8..200 characters and validates before the write; duplicating a product rule
-- in a constraint makes a future change to it a migration on live data.
