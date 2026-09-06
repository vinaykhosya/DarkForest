/*
 * Embeddings are `halfvec(768)`, as docs/03 § 6 specifies. 0006 used `vector`.
 *
 * This is not a stylistic preference and the specification's reasoning is the
 * binding kind: half precision halves storage at negligible recall cost, and
 * docs/01's storage math puts the free tier at its limit around 100k memories.
 * At 768 dimensions that is 300 MB of vectors as `vector` and 150 MB as
 * `halfvec` — the difference between fitting and not.
 *
 * Safe to convert in place only because the table is empty. Doing this later
 * means rewriting every row and rebuilding the HNSW index on live data, which is
 * exactly the outage the specification was trying to avoid.
 */

drop index if exists memory_embeddings_hnsw;

alter table memory_embeddings
  alter column embedding type halfvec(768) using embedding::halfvec(768);

-- Parameters from docs/03 § 6 rather than the pgvector defaults. m=16 /
-- ef_construction=64 is the documented build for this corpus size.
create index memory_embeddings_hnsw on memory_embeddings
  using hnsw (embedding halfvec_cosine_ops) with (m = 16, ef_construction = 64);

/*
 * The composite primary key (memory_id, model, version) is KEPT, and it is a
 * deliberate divergence from docs/03, which keys this table by memory_id alone.
 *
 * The document's own note is the argument for it: "changing embedding provider
 * is a background re-embed job, not an outage". One row per memory cannot
 * express that — the job would overwrite each vector in place, so for its whole
 * duration retrieval compares distances across two different vector spaces.
 * Those distances are not comparable, and the failure is silent: retrieval
 * simply gets worse for a few hours and nobody can say why.
 *
 * With the composite key both generations coexist, readers pin the model and
 * version they want, and the cutover is one query changing which pair it asks
 * for. The old rows are then deleted at leisure.
 */
