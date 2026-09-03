/**
 * FNV-1a, 32-bit. Small, fast, pure, and stable across runs and platforms.
 *
 * Used only to make the mock provider DETERMINISTIC — the same request must
 * always produce the same response, so tests of retry, fallback and the memory
 * loop are reproducible. Not a cryptographic hash and never used as one.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, expressed as shifts to stay in int32 range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic 0..1 from a string. */
export function unitHash(input: string): number {
  return fnv1a(input) / 0xffffffff;
}

/** Deterministic pick from a non-empty list. */
export function pick<T>(items: readonly T[], seed: string): T {
  if (items.length === 0) throw new Error("pick() requires a non-empty list");
  const index = fnv1a(seed) % items.length;
  // Length-checked above, so the index is always in range — but
  // noUncheckedIndexedAccess does not know that.
  return items[index] as T;
}
