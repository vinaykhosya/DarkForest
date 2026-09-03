/**
 * Lightweight text similarity.
 *
 * WHY THIS EXISTS INSTEAD OF COSINE ON EMBEDDINGS
 * -----------------------------------------------
 * ADR-010: the Workers free tier allows 10 ms of CPU per invocation. Computing
 * pairwise cosine over 40 candidates × 768 dimensions in the request path would
 * spend most of that budget on arithmetic, and the vectors are already in Postgres
 * anyway — shipping them to the edge to compare them there is backwards.
 *
 * So the redundancy term in MMR uses lexical overlap instead. Memories are capped
 * at 200 characters (~30 tokens), so a Jaccard comparison is a set intersection
 * over ~30 elements — microseconds, not milliseconds.
 *
 * This is a good proxy for the specific job MMR needs: near-duplicate memories are
 * near-duplicate precisely because they restate the same fact with the same nouns.
 * "User owns Ravenblade" and "Ravenblade belongs to the user" share their content
 * words. Lexical overlap catches that reliably.
 *
 * It is NOT a substitute for semantic similarity in retrieval — that still comes
 * from pgvector, computed in the database where the vectors live.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "will", "would", "shall", "should", "may",
  "might", "must", "can", "could", "to", "of", "in", "on", "at", "by", "for",
  "with", "about", "from", "as", "into", "it", "its", "he", "she", "they",
  "them", "his", "her", "their", "who", "whom", "which", "what", "when", "where",
]);

/** Content words only, lowercased, punctuation stripped, stopwords removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** |A ∩ B| / |A ∪ B|. Returns 0 for two empty sets rather than NaN. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Overlap coefficient — |A ∩ B| / min(|A|,|B|).
 *
 * Used for topic overlap rather than Jaccard because a short memory and a long
 * scene description should still count as matching when the short one is fully
 * contained in the long one. Jaccard would penalise that purely for the size gap.
 */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) intersection++;
  return intersection / small.size;
}

/**
 * Conservative token estimate: ~3.6 characters per token for English prose.
 *
 * Deliberately an OVER-estimate. Over-estimating wastes a little context budget;
 * under-estimating causes a hard truncation mid-generation, which is far worse.
 * Replaced by the provider's own tokenizer where one is available. docs/09 § 7.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
