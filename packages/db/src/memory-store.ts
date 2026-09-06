import type {
  CharacterId,
  KnowledgeSource,
  Memory,
  MemoryId,
  MemoryKind,
  MemoryVisibility,
  WorldId,
} from "@darkforest/contracts";
import type {
  MemoryCandidate,
  MemoryStore,
  NewMemory,
  StructuralQuery,
} from "@darkforest/memory";
import type { DbClient } from "./client.js";

/**
 * PostgresMemoryStore — the translation of `InMemoryMemoryStore`, V1-T10.
 *
 * The store interface was shaped so this would be a translation rather than a
 * redesign, and the one thing that must survive the translation is WHY every
 * retrieval method takes `characterId`: isolation is part of the query, never a
 * step the caller performs afterwards. Here that is literal — the predicate is
 * in the SQL, and there is no method that returns unfiltered rows for a caller
 * to filter later. Making the unfiltered read impossible to EXPRESS is the only
 * version of this that survives contact with a deadline.
 *
 * Takes a `DbClient` rather than a pool: every call belongs to the caller's
 * transaction, which is what makes "the turn, its events and its memories all
 * landed, or none of them did" achievable at all.
 */

/** The isolation predicate. docs/04 § 5, and the direct equivalent of `visibleTo`. */
const VISIBLE = `
  m.deleted_at is null
  and m.superseded_by is null
  and (
    $2::uuid is null
    or m.visibility = 'world'
    or exists (
      select 1 from character_knowledge ck
      where ck.memory_id = m.id and ck.character_id = $2::uuid
    )
  )`;

/**
 * The certainty this character holds a memory at.
 *
 * World-visible memories and the narrator both read 1. A character's own grant
 * supplies its own certainty. Mirrors `visibleTo` returning 1 for those cases
 * rather than null — "visible to everyone" is not "held with low confidence".
 */
/*
 * NOT cast to float8, and the cast is what made this worth a comment.
 *
 * `certainty` is `real` (float4). Casting it up to float8 does not recover
 * precision — it EXPOSES the float4 representation, so a stored 0.9 comes back
 * as 0.899999976158142, while the in-memory store returns exactly 0.9. Left as
 * `real`, Postgres formats it with the fewest digits that round-trip and prints
 * "0.9".
 *
 * The conformance suite caught this. The difference is far too small to change a
 * ranking, which is exactly why it would have survived indefinitely — and it is
 * the kind of thing that turns an equality assertion in some future test into a
 * mystery about the database.
 */
const CERTAINTY = `
  coalesce(
    (select ck.certainty from character_knowledge ck
      where ck.memory_id = m.id and ck.character_id = $2::uuid),
    1::real
  ) as certainty`;

const COLUMNS = `
  m.id, m.world_id, m.kind, m.content, m.subjects, m.location, m.world_day,
  m.importance, m.confidence, m.visibility, m.is_pinned, m.is_user_edited,
  m.superseded_by, m.access_count, m.last_accessed_at,
  m.created_at, m.updated_at, m.deleted_at`;

interface MemoryRow {
  id: string;
  world_id: string;
  kind: string;
  content: string;
  subjects: string[];
  location: string | null;
  world_day: number | null;
  /*
   * `number | string`, deliberately.
   *
   * node-postgres parses int4 and float8 to numbers but hands back some numeric
   * types as strings, and which ones depends on the registered type parsers.
   * Declaring these as `number` would be a claim the driver does not make, and
   * the failure is a score that is a string arriving inside the ranker, where it
   * compares as text: "0.9" < "0.85" is true.
   */
  importance: number | string;
  confidence: number | string;
  visibility: string;
  is_pinned: boolean;
  is_user_edited: boolean;
  superseded_by: string | null;
  access_count: number | string;
  last_accessed_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
  deleted_at: Date | null;
}

function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id as MemoryId,
    worldId: r.world_id as WorldId,
    kind: r.kind as MemoryKind,
    content: r.content,
    // No assertion: EntityRef is a validated string, so string[] already fits.
    subjects: r.subjects,
    location: r.location,
    worldDay: r.world_day,
    // `real` and `double precision` arrive as numbers, but numeric-ish columns
    // can arrive as strings depending on the driver's type parsers. Coercing
    // here means a score never silently becomes NaN inside the ranker.
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    visibility: r.visibility as MemoryVisibility,
    isPinned: r.is_pinned,
    isUserEdited: r.is_user_edited,
    supersededBy: r.superseded_by as MemoryId | null,
    accessCount: Number(r.access_count),
    lastAccessedAt: r.last_accessed_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at?.toISOString() ?? null,
    deletedAt: r.deleted_at?.toISOString() ?? null,
  };
}

function toCandidate(
  r: MemoryRow & { certainty: number | string; raw_score: number | string },
): MemoryCandidate {
  return {
    memory: toMemory(r),
    rawScore: Number(r.raw_score),
    certainty: Number(r.certainty),
  };
}

/** pgvector's text form. `Float32Array` -> `[0.1,0.2,...]`. */
function toVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: DbClient) {}

  async insert(input: NewMemory): Promise<Memory> {
    const { rows } = await this.db.query<MemoryRow>(
      `insert into memories
         (world_id, kind, content, subjects, location, world_day,
          importance, confidence, visibility, is_pinned, is_user_edited)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning ${COLUMNS.replace(/m\./g, "")}`,
      [
        input.worldId,
        input.kind,
        input.content,
        [...(input.subjects ?? [])],
        input.location ?? null,
        input.worldDay ?? null,
        input.importance,
        input.confidence ?? 1,
        input.visibility ?? "world",
        input.isPinned ?? false,
        input.isUserEdited ?? false,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("insert returned no row");
    return toMemory(row);
  }

  async get(id: MemoryId): Promise<Memory | null> {
    const { rows } = await this.db.query<MemoryRow>(
      `select ${COLUMNS} from memories m where m.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toMemory(row);
  }

  async update(
    id: MemoryId,
    patch: Partial<Pick<Memory, "content" | "isPinned" | "importance">>,
  ): Promise<Memory> {
    const { rows } = await this.db.query<MemoryRow>(
      // Every parameter is cast. Postgres cannot infer the type of a parameter
      // that arrives as null, and `coalesce($2, content)` with a null $2 fails
      // with "could not determine data type" — at runtime, on the path that
      // leaves content alone, which is the common one.
      `update memories m set
         content        = coalesce($2::text, m.content),
         is_pinned      = coalesce($3::boolean, m.is_pinned),
         importance     = coalesce($4::real, m.importance),
         -- A user correction wins every future contradiction (docs/04 § 8b),
         -- and once set it is never unset.
         is_user_edited = m.is_user_edited or ($2::text is not null)
       where m.id = $1
       returning ${COLUMNS.replace(/m\./g, "")}`,
      [id, patch.content ?? null, patch.isPinned ?? null, patch.importance ?? null],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`Memory not found: ${id}`);

    if (patch.content !== undefined) {
      // A changed body invalidates every vector of it. Re-embedding is a
      // background job; retrieval degrades to keyword and structural meanwhile.
      await this.db.query("delete from memory_embeddings where memory_id = $1", [id]);
    }
    return toMemory(row);
  }

  async softDelete(id: MemoryId): Promise<void> {
    await this.db.query("update memories set deleted_at = now() where id = $1", [id]);
  }

  async supersede(id: MemoryId, by: MemoryId): Promise<void> {
    await this.db.query("update memories set superseded_by = $2 where id = $1", [id, by]);
    // Dropping superseded vectors is the largest storage win available
    // (docs/01 § Storage math).
    await this.db.query("delete from memory_embeddings where memory_id = $1", [id]);
  }

  async vectorSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryVector: Float32Array,
    limit: number,
  ): Promise<MemoryCandidate[]> {
    /*
     * Cosine DISTANCE is what `<=>` returns; the store's contract is a
     * SIMILARITY, where higher is better. `1 - distance` converts it.
     *
     * Getting this backwards produces a ranking that is exactly inverted and
     * still looks plausible — every result is a real memory from the right
     * world, just the least relevant ones. The in-memory store returns
     * `cosineSimilarity` directly, so the two would disagree silently.
     */
    const { rows } = await this.db.query<MemoryRow & { certainty: number | string; raw_score: number | string }>(
      `select ${COLUMNS}, ${CERTAINTY},
              (1 - (e.embedding <=> $3::halfvec))::float8 as raw_score
         from memories m
         join memory_embeddings e on e.memory_id = m.id
        where m.world_id = $1 and ${VISIBLE}
        order by e.embedding <=> $3::halfvec
        limit $4`,
      [worldId, characterId, toVectorLiteral(queryVector), limit],
    );
    return rows.map(toCandidate);
  }

  async keywordSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    queryText: string,
    limit: number,
  ): Promise<MemoryCandidate[]> {
    /*
     * `websearch_to_tsquery` rather than `plainto_tsquery`: it never throws on
     * punctuation. A user message is arbitrary text, and a retrieval path that
     * can be crashed by an apostrophe is not a retrieval path.
     *
     * Scores are NOT comparable with the in-memory store's overlap coefficient,
     * and they do not need to be — fusion is Reciprocal Rank Fusion, which reads
     * only the ORDER. That is why RRF was chosen (ADR: RRF + MMR) and it is what
     * makes two different keyword implementations interchangeable here.
     */
    const { rows } = await this.db.query<MemoryRow & { certainty: number | string; raw_score: number | string }>(
      `select ${COLUMNS}, ${CERTAINTY},
              ts_rank(to_tsvector('english', m.content),
                      websearch_to_tsquery('english', $3))::float8 as raw_score
         from memories m
        where m.world_id = $1 and ${VISIBLE}
          and to_tsvector('english', m.content) @@ websearch_to_tsquery('english', $3)
        order by raw_score desc
        limit $4`,
      [worldId, characterId, queryText, limit],
    );
    return rows.map(toCandidate);
  }

  async structuralSearch(
    worldId: WorldId,
    characterId: CharacterId | null,
    query: StructuralQuery,
  ): Promise<MemoryCandidate[]> {
    /*
     * Three sources, unioned, highest score winning per memory — the same
     * precedence the in-memory store gets by overwriting its map in order:
     * pinned 1.0, subject match 0.8, recent 0.6.
     *
     * Each branch is PARENTHESISED. Without the parentheses the `order by` and
     * `limit` on the third branch bind to the whole UNION instead, so "the 3
     * most recent" silently becomes "3 rows of the combined result" and pinned
     * memories start disappearing from context.
     */
    const { rows } = await this.db.query<MemoryRow & { certainty: number | string; raw_score: number | string }>(
      `with live as (
         select m.id, m.is_pinned, m.subjects, m.world_day
           from memories m
          where m.world_id = $1 and ${VISIBLE}
       ),
       scored as (
         (select id, 1.0::float8 as raw_score from live where $3::boolean and is_pinned)
         union all
         (select id, 0.8::float8 from live
           where cardinality($4::text[]) > 0 and subjects && $4::text[])
         union all
         (select id, 0.6::float8 from (
            select id from live
             where $5::int > 0
             order by world_day desc nulls last, id desc
             limit greatest($5::int, 0)
          ) recent)
       ),
       best as (select id, max(raw_score) as raw_score from scored group by id)
       select ${COLUMNS}, ${CERTAINTY}, best.raw_score::float8 as raw_score
         from memories m
         join best on best.id = m.id
        -- Ties break by world day, not by id. Every memory from the recency
        -- branch scores exactly 0.6, so without this the order among them falls
        -- back to random uuids and "the 3 most recent" comes back shuffled. The
        -- in-memory store gets this ordering for free, from a stable sort over
        -- an already-ordered insertion.
        order by best.raw_score desc, m.world_day desc nulls last, m.id desc`,
      [worldId, characterId, query.includePinned, [...query.subjects], query.recentCount],
    );
    return rows.map(toCandidate);
  }

  async grantKnowledge(
    characterId: CharacterId,
    memoryId: MemoryId,
    source: KnowledgeSource,
    certainty: number,
    learnedAtDay: number | null,
  ): Promise<void> {
    await this.db.query(
      `insert into character_knowledge (character_id, memory_id, source, certainty, learned_at_day)
       values ($1,$2,$3,$4,$5)
       on conflict (character_id, memory_id) do update
         -- Learning something again can only RAISE confidence, never lower it.
         set certainty = greatest(character_knowledge.certainty, excluded.certainty)`,
      [characterId, memoryId, source, certainty, learnedAtDay],
    );
  }

  async setEmbedding(
    id: MemoryId,
    vector: Float32Array,
    model: string,
    version: number,
  ): Promise<void> {
    await this.db.query(
      `insert into memory_embeddings (memory_id, model, version, embedding)
       values ($1,$2,$3,$4::halfvec)
       on conflict (memory_id, model, version) do update set embedding = excluded.embedding`,
      [id, model, version, toVectorLiteral(vector)],
    );
  }

  async pendingEmbeddings(worldId: WorldId, limit: number): Promise<Memory[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `select ${COLUMNS} from memories m
        where m.world_id = $1
          and m.deleted_at is null and m.superseded_by is null
          and not exists (select 1 from memory_embeddings e where e.memory_id = m.id)
        order by m.importance desc, m.created_at asc
        limit $2`,
      [worldId, limit],
    );
    return rows.map(toMemory);
  }

  async recordAccess(ids: readonly MemoryId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `update memories
          set access_count = access_count + 1, last_accessed_at = now()
        where id = any($1::uuid[])`,
      [[...ids]],
    );
  }

  async countByWorld(worldId: WorldId): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `select count(*) as n from memories
        where world_id = $1 and deleted_at is null and superseded_by is null`,
      [worldId],
    );
    return Number(rows[0]?.n ?? "0");
  }

  async allByWorld(worldId: WorldId): Promise<Memory[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `select ${COLUMNS} from memories m
        where m.world_id = $1 and m.deleted_at is null and m.superseded_by is null
        order by m.created_at asc`,
      [worldId],
    );
    return rows.map(toMemory);
  }
}
