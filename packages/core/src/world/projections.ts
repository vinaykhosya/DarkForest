import type { WorldEvent } from "@darkforest/contracts";

/**
 * PROJECTIONS — what is true now, folded from what happened (ADR-025).
 *
 * Pure and deterministic. No inference, no clock, no I/O. The same event log
 * always folds to the same state, which is what makes the whole architecture
 * recoverable: if a projection is wrong, fix the fold and replay, rather than
 * migrating data that was written wrong.
 *
 * The property worth stating: a projection holds exactly ONE current value per
 * key. Contradiction is not unlikely here, it is unrepresentable. That is the
 * difference from the memory store, where "Elena has the ring" and "Marcus has
 * the ring" both persist and retrieval picks by score.
 */

export interface Commitment {
  /** Who is bound. */
  actor: string;
  /** Who they are bound to, when stated. */
  target: string | null;
  /** What was promised or refused, in the world's own words. */
  what: string;
  kind: "promise" | "refusal";
  status: "open" | "fulfilled";
  worldDay: number;
  sourceTurn: number;
}

export interface OpenQuestion {
  asker: string;
  askee: string | null;
  /** What was asked about. */
  topic: string;
  status: "open" | "answered";
  answer: string | null;
  worldDay: number;
  sourceTurn: number;
}

export interface Ownership {
  object: string;
  owner: string | null;
  /** How they came to hold it — acquired, given, or lost. */
  via: string;
  worldDay: number;
  sourceTurn: number;
}

export interface RelationFact {
  from: string;
  to: string;
  /** "brother", "saved my life", "distrusts" — the world's own phrasing. */
  relation: string;
  /** Why, when the transcript said why. */
  reason: string | null;
  worldDay: number;
  sourceTurn: number;
}

export interface PersonaFact {
  subject: string;
  /** "fears", "hates", "refuses", "likes". */
  stance: string;
  topic: string;
  worldDay: number;
  sourceTurn: number;
}

export interface NumericFact {
  key: string;
  value: number;
  worldDay: number;
  sourceTurn: number;
}

export interface Disclosure {
  /** Who revealed it. */
  actor: string;
  /** Who they revealed it to. */
  target: string | null;
  what: string;
  knownBy: readonly string[];
  worldDay: number;
  sourceTurn: number;
}

export interface WorldProjection {
  /** object → who holds it now. Exactly one entry per object. */
  ownership: Map<string, Ownership>;
  commitments: Commitment[];
  questions: OpenQuestion[];
  /** "from→to" → the current relation. Later statements supersede earlier ones. */
  relations: Map<string, RelationFact>;
  persona: PersonaFact[];
  /** key → current value. A count is state, not history. */
  numerics: Map<string, NumericFact>;
  disclosures: Disclosure[];
  /** Events with no projection of their own, kept in order. */
  worldEvents: WorldEvent[];
  /** Every event, ordered. The log is the record; this is just the ordering. */
  ordered: WorldEvent[];
}

function emptyProjection(): WorldProjection {
  return {
    ownership: new Map(),
    commitments: [],
    questions: [],
    relations: new Map(),
    persona: [],
    numerics: new Map(),
    disclosures: [],
    worldEvents: [],
    ordered: [],
  };
}

/** Case- and article-insensitive key, so "the ring" and "Ring" are one object. */
export function normaliseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|a|an|my|his|her|their)\s+/, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function relationKey(from: string, to: string): string {
  return `${normaliseKey(from)}→${normaliseKey(to)}`;
}

/** Loose containment, for matching a question's topic against a stored one. */
function overlaps(a: string, b: string): boolean {
  const x = normaliseKey(a);
  const y = normaliseKey(b);
  if (x.length === 0 || y.length === 0) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * Folds an event log into current state.
 *
 * Events are sorted by (worldDay, seq) rather than trusted in array order: an
 * extraction that arrives late must not silently supersede a later event.
 */
export function project(events: readonly WorldEvent[]): WorldProjection {
  const p = emptyProjection();
  const ordered = [...events].sort((a, b) =>
    a.worldDay !== b.worldDay ? a.worldDay - b.worldDay : a.seq - b.seq,
  );
  p.ordered = ordered;

  for (const e of ordered) {
    switch (e.type) {
      case "acquired":
      case "gave":
      case "lost": {
        if (e.object === null) break;
        const key = normaliseKey(e.object);
        // The whole point of folding: the LAST event about an object decides who
        // holds it. `gave` transfers to the target; `lost` clears the owner.
        const owner = e.type === "gave" ? e.target : e.type === "lost" ? null : e.actor;
        p.ownership.set(key, {
          object: e.object,
          owner,
          via: e.type,
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "promised":
      case "refused": {
        const what = e.value ?? e.object;
        if (what === null) break;
        p.commitments.push({
          actor: e.actor,
          target: e.target,
          what,
          kind: e.type === "promised" ? "promise" : "refusal",
          status: "open",
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "fulfilled": {
        const what = e.value ?? e.object;
        if (what === null) break;
        // Resolve the most recent open commitment this plausibly discharges,
        // rather than all of them — a second promise to the same person is a
        // second commitment, not a restatement.
        for (let i = p.commitments.length - 1; i >= 0; i--) {
          const c = p.commitments[i];
          if (c === undefined) continue;
          if (c.status === "open" && normaliseKey(c.actor) === normaliseKey(e.actor) && overlaps(c.what, what)) {
            c.status = "fulfilled";
            break;
          }
        }
        break;
      }

      case "asked": {
        const topic = e.value ?? e.object;
        if (topic === null) break;
        p.questions.push({
          asker: e.actor,
          askee: e.target,
          topic,
          status: "open",
          answer: null,
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "answered": {
        const topic = e.object ?? e.value;
        if (topic === null) break;
        for (let i = p.questions.length - 1; i >= 0; i--) {
          const q = p.questions[i];
          if (q === undefined) continue;
          if (q.status === "open" && overlaps(q.topic, topic)) {
            q.status = "answered";
            q.answer = e.value;
            break;
          }
        }
        break;
      }

      case "revealed": {
        const what = e.value ?? e.object;
        if (what === null) break;
        p.disclosures.push({
          actor: e.actor,
          target: e.target,
          what,
          knownBy: e.knownBy.length > 0 ? e.knownBy : [e.actor, ...(e.target === null ? [] : [e.target])],
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "relation_stated":
      case "relation_changed": {
        if (e.target === null) break;
        const relation = e.value ?? e.object;
        if (relation === null) break;
        p.relations.set(relationKey(e.actor, e.target), {
          from: e.actor,
          to: e.target,
          relation,
          reason: e.causedBy,
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "preference_stated": {
        const topic = e.object ?? e.value;
        if (topic === null) break;
        p.persona.push({
          subject: e.actor,
          stance: e.value !== null && e.object !== null ? e.value : "prefers",
          topic,
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "numeric_stated": {
        if (e.object === null || e.quantity === null) break;
        p.numerics.set(normaliseKey(e.object), {
          key: e.object,
          value: e.quantity,
          worldDay: e.worldDay,
          sourceTurn: e.sourceTurn,
        });
        break;
      }

      case "world_event": {
        p.worldEvents.push(e);
        break;
      }
    }
  }

  return p;
}

/**
 * Threads still open. The product promise "the world remembers what is
 * unfinished" is this function.
 *
 * A flat memory store cannot answer it at all: "what is unresolved" is an
 * aggregate over the absence of a later event, and there is nothing to embed.
 */
export function openThreads(p: WorldProjection): {
  commitments: Commitment[];
  questions: OpenQuestion[];
} {
  return {
    commitments: p.commitments.filter((c) => c.status === "open"),
    questions: p.questions.filter((q) => q.status === "open"),
  };
}
