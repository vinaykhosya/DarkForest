import type { StructuredIntent } from "./query-router.js";
import { normaliseKey, openThreads, type WorldProjection } from "./projections.js";

/**
 * STRUCTURED RESOLUTION — answering from state rather than by ranking (ADR-025).
 *
 * Pure. Takes a routed intent and a folded projection, returns the rows that
 * answer it. There is no score, no top-K and no candidate pool: a `SELECT` does
 * not degrade as the store grows, which is the entire claim under test.
 *
 * Returns rendered sentences rather than raw rows so the output is directly
 * comparable with what the memory path produces — same context slot, same
 * evaluation, no separate scoring path to argue about.
 */

export interface ResolvedAnswer {
  /** Sentences to place in context, most relevant first. */
  lines: string[];
  /** The projection consulted. Recorded so misrouting is attributable. */
  source: StructuredIntent["kind"];
  /** False when the intent routed but the projection held nothing. */
  answered: boolean;
}

function matches(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true; // An unspecified filter matches all.
  return normaliseKey(a) === normaliseKey(b) || normaliseKey(a).includes(normaliseKey(b));
}

/** Newest first: a later statement is usually the one being asked about. */
function byRecency<T extends { worldDay: number; sourceTurn: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.worldDay !== b.worldDay ? b.worldDay - a.worldDay : b.sourceTurn - a.sourceTurn,
  );
}

export function resolve(
  intent: StructuredIntent,
  p: WorldProjection,
  limit = 6,
): ResolvedAnswer {
  const done = (lines: string[]): ResolvedAnswer => ({
    lines: lines.slice(0, limit),
    source: intent.kind,
    answered: lines.length > 0,
  });

  switch (intent.kind) {
    case "ownership": {
      const rows = byRecency([...p.ownership.values()]).filter(
        (o) => matches(o.owner, intent.owner) && matches(o.object, intent.object),
      );
      return done(
        rows.map((o) =>
          o.owner === null
            ? `${o.object} is no longer held by anyone.`
            : `${o.owner} has ${o.object}.`,
        ),
      );
    }

    case "commitment": {
      const rows = byRecency(p.commitments).filter(
        (c) =>
          matches(c.actor, intent.actor) &&
          matches(c.target, intent.target) &&
          (intent.commitmentKind === null || c.kind === intent.commitmentKind),
      );
      return done(
        rows.map((c) =>
          c.kind === "refusal"
            ? `${c.actor} refused ${c.what}.`
            : `${c.actor} promised ${c.target ?? "someone"} ${c.what}.` +
              (c.status === "fulfilled" ? " (fulfilled)" : ""),
        ),
      );
    }

    case "question": {
      const rows = byRecency(p.questions).filter(
        (q) => matches(q.asker, intent.asker) && matches(q.askee, intent.askee),
      );
      return done(
        rows.map((q) =>
          q.status === "answered"
            ? `${q.asker} asked ${q.askee ?? "someone"} about ${q.topic}; the answer was ${q.answer ?? "given"}.`
            : `${q.asker} asked ${q.askee ?? "someone"} about ${q.topic}, and it is still unanswered.`,
        ),
      );
    }

    case "relation": {
      const rows = byRecency([...p.relations.values()]).filter(
        (r) =>
          (matches(r.from, intent.from) && matches(r.to, intent.to)) ||
          // Relations are directional, but a question about a pair is usually
          // indifferent to which name was said first.
          (matches(r.from, intent.to) && matches(r.to, intent.from)),
      );
      return done(
        rows.map(
          (r) => `${r.from} is ${r.relation} to ${r.to}.` + (r.reason === null ? "" : ` (${r.reason})`),
        ),
      );
    }

    case "persona": {
      const rows = byRecency(p.persona).filter((f) => matches(f.subject, intent.subject));
      return done(rows.map((f) => `${f.subject} ${f.stance} ${f.topic}.`));
    }

    case "numeric": {
      const rows = byRecency([...p.numerics.values()]).filter((n) =>
        intent.key === null ? true : normaliseKey(n.key).includes(normaliseKey(intent.key)),
      );
      return done(rows.map((n) => `${n.key}: ${String(n.value)}.`));
    }

    case "disclosure": {
      const rows = byRecency(p.disclosures).filter((d) => matches(d.actor, intent.actor));
      return done(rows.map((d) => `${d.actor} revealed to ${d.target ?? "someone"} that ${d.what}.`));
    }

    case "world_event": {
      const rows = byRecency(p.worldEvents).filter((e) => {
        if (intent.topic === null) return true;
        const hay = `${e.object ?? ""} ${e.value ?? ""} ${e.location ?? ""}`;
        return normaliseKey(hay).includes(normaliseKey(intent.topic));
      });
      return done(rows.map((e) => e.value ?? `${e.actor} ${e.type} ${e.object ?? ""}`.trim()));
    }

    case "open_threads": {
      const open = openThreads(p);
      return done([
        ...open.questions.map((q) => `Still unanswered: ${q.asker} asked about ${q.topic}.`),
        ...open.commitments.map((c) => `Still owed: ${c.actor} promised ${c.what}.`),
      ]);
    }
  }
}
