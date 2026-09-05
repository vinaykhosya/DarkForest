/**
 * QUERY ROUTING — decide whether a question has an exact answer (ADR-025).
 *
 * Deterministic. No inference call, because spending a model call to decide how
 * to spend a model call is backwards (ADR-008), and because a classifier that
 * costs nothing can run on every turn without touching the economics.
 *
 * The honest risk, stated where it will be read: these patterns were written
 * against the question forms in Suite 1, and a router fitted to its benchmark
 * will look excellent on that benchmark and brittle in front of a user. Two
 * things guard against it — `structuredShare` is reported alongside recall so
 * over-routing is visible, and anything that does not match falls through to
 * semantic retrieval rather than failing. Unmatched is the SAFE outcome here,
 * so the patterns stay narrow deliberately.
 */

export type StructuredIntent =
  | { kind: "ownership"; object: string | null; owner: string | null }
  | { kind: "commitment"; actor: string | null; target: string | null; commitmentKind: "promise" | "refusal" | null }
  | { kind: "question"; asker: string | null; askee: string | null }
  | { kind: "relation"; from: string | null; to: string | null }
  | { kind: "persona"; subject: string | null; stance: string | null }
  | { kind: "numeric"; key: string | null }
  | { kind: "disclosure"; actor: string | null }
  | { kind: "world_event"; topic: string | null }
  | { kind: "open_threads" };

export interface RoutingResult {
  intent: StructuredIntent | null;
  /** Which pattern matched. Recorded so misrouting can be attributed. */
  matched: string | null;
}

/** First alias appearing in the text, so "Elena" is found wherever it sits. */
function findAlias(text: string, aliases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  let best: { alias: string; at: number } | null = null;
  for (const alias of aliases) {
    const at = lower.indexOf(alias.toLowerCase());
    if (at >= 0 && (best === null || at < best.at)) best = { alias, at };
  }
  return best?.alias ?? null;
}

/**
 * The speaker's own first person. "What did I promise" is about the user, and
 * resolving that here keeps the projections free of pronoun handling.
 */
const SELF = "the user";

interface Pattern {
  name: string;
  test: RegExp;
  build: (m: RegExpMatchArray, text: string, aliases: readonly string[]) => StructuredIntent | null;
}

/*
 * Ordered: the first match wins, so more specific patterns come first. "What did
 * I ask Elena about the sealed room" must route to questions, not to disclosure,
 * even though both mention a character and a topic.
 */
const PATTERNS: Pattern[] = [
  {
    name: "open_threads",
    test: /\b(unresolved|still (need|have) to|loose ends?|outstanding|what.*left to (do|investigate))\b/i,
    build: () => ({ kind: "open_threads" }),
  },
  {
    name: "commitment.promise",
    test: /\b(promise|promised|swear|swore|vow|vowed|oath)\b/i,
    build: (_m, text, aliases) => ({
      kind: "commitment",
      actor: /\b(i|my|me)\b/i.test(text) ? SELF : null,
      target: findAlias(text, aliases),
      commitmentKind: "promise",
    }),
  },
  {
    name: "commitment.refusal",
    test: /\b(refuse|refused|refusal|never do|won'?t do|will not do)\b/i,
    build: (_m, text, aliases) => ({
      kind: "commitment",
      actor: /\b(i|my|me)\b/i.test(text) ? SELF : null,
      target: findAlias(text, aliases),
      commitmentKind: "refusal",
    }),
  },
  {
    name: "question.asked",
    test: /\b(ask|asked|question|enquir|inquir)\w*\b/i,
    build: (_m, text, aliases) => ({
      kind: "question",
      asker: /\b(i|my|me)\b/i.test(text) ? SELF : null,
      askee: findAlias(text, aliases),
    }),
  },
  {
    name: "numeric",
    test: /\bhow (many|much)\b/i,
    build: (_m, text) => {
      // The counted noun is whatever follows "how many/much", minus the verb tail.
      const m = /\bhow (?:many|much)\s+([a-z\s]+?)(?:\s+(?:do|does|did|are|is|remain|remains|left|owe|owed)\b|\?|$)/i.exec(
        text,
      );
      return { kind: "numeric", key: m?.[1]?.trim() ?? null };
    },
  },
  {
    name: "relation",
    test: /\b(who is|who are|relation|related|brother|sister|father|mother|who saved|who betrayed)\b/i,
    build: (_m, text, aliases) => {
      // Ordered by where they appear in the QUESTION, not by their order in the
      // alias table. Relations are directional, so "Who is Marcus to Elena?"
      // resolved from list order would query the edge backwards and answer
      // confidently with the wrong relation.
      const lower = text.toLowerCase();
      const found = aliases
        .map((a) => ({ a, at: lower.indexOf(a.toLowerCase()) }))
        .filter((x) => x.at >= 0)
        .sort((x, y) => x.at - y.at)
        .map((x) => x.a);
      return { kind: "relation", from: found[0] ?? null, to: found[1] ?? null };
    },
  },
  {
    name: "ownership",
    test: /\b(own|owns|owned|possess|have|carry|carrying|sold me|gave me|bought|lose|lost)\b/i,
    build: (_m, text, aliases) => ({
      kind: "ownership",
      object: null,
      owner: /\b(i|my|me)\b/i.test(text) ? SELF : findAlias(text, aliases),
    }),
  },
  {
    name: "persona",
    test: /\b(afraid|fear|scared|hate|hates|love|loves|like|likes|dislike|prefer|favou?rite)\b/i,
    build: (_m, text, aliases) => ({
      kind: "persona",
      subject: /\b(i|my|me)\b/i.test(text) ? SELF : findAlias(text, aliases),
      stance: null,
    }),
  },
  {
    name: "disclosure",
    test: /\b(admit|admitted|confess|confessed|reveal|revealed|told me|secret|hidden)\b/i,
    build: (_m, text, aliases) => ({ kind: "disclosure", actor: findAlias(text, aliases) }),
  },
  {
    name: "world_event",
    test: /\bwhat happened\b/i,
    build: (_m, text) => {
      const m = /\bwhat happened (?:to|at|in|with)\s+([a-z\s]+?)(?:\?|$)/i.exec(text);
      return { kind: "world_event", topic: m?.[1]?.trim() ?? null };
    },
  },
];

export function routeQuery(text: string, aliases: readonly string[] = []): RoutingResult {
  for (const p of PATTERNS) {
    const m = p.test.exec(text);
    if (m === null) continue;
    const intent = p.build(m, text, aliases);
    if (intent !== null) return { intent, matched: p.name };
  }
  return { intent: null, matched: null };
}
