import { describe, expect, it } from "vitest";
import type { WorldEvent } from "@darkforest/contracts";
import { openThreads, project } from "./projections.js";

let seq = 0;
function ev(over: Partial<WorldEvent> & Pick<WorldEvent, "type" | "actor">): WorldEvent {
  seq += 1;
  return {
    id: `e${String(seq)}`,
    worldId: "w1",
    worldDay: 1,
    seq,
    target: null,
    object: null,
    value: null,
    quantity: null,
    location: null,
    participants: [],
    visibility: "world",
    knownBy: [],
    importance: 0.5,
    sourceTurn: seq,
    causedBy: null,
    ...over,
  };
}

describe("project — ownership is folded, never stored twice", () => {
  it("gives the object to the target, so the last event decides who holds it", () => {
    /*
     * THE defect this architecture exists to fix. In the memory store, "Elena
     * has the ring" and "Marcus has the ring" both persist and retrieval picks
     * by score — a coin flip that gets worse as history grows. Here there is
     * exactly one owner, computed rather than retrieved.
     */
    const p = project([
      ev({ type: "gave", actor: "the user", target: "Elena", object: "the silver ring", worldDay: 12 }),
      ev({ type: "gave", actor: "Elena", target: "Marcus", object: "silver ring", worldDay: 40 }),
    ]);
    expect(p.ownership.get("silver ring")?.owner).toBe("Marcus");
    expect(p.ownership.size).toBe(1);
  });

  it("normalises articles and case so one object is one key", () => {
    const p = project([
      ev({ type: "acquired", actor: "the user", object: "Ravenblade" }),
      ev({ type: "gave", actor: "the user", target: "Odell", object: "the Ravenblade", worldDay: 3 }),
    ]);
    expect(p.ownership.size).toBe(1);
    expect(p.ownership.get("ravenblade")?.owner).toBe("Odell");
  });

  it("clears the owner when the object is lost", () => {
    const p = project([
      ev({ type: "acquired", actor: "the user", object: "signet ring" }),
      ev({ type: "lost", actor: "the user", object: "signet ring", worldDay: 5 }),
    ]);
    expect(p.ownership.get("signet ring")?.owner).toBeNull();
  });

  it("orders by (worldDay, seq), not array order", () => {
    // A late-arriving extraction must not silently supersede a later event.
    const early = ev({ type: "gave", actor: "u", target: "Elena", object: "ring", worldDay: 1 });
    const late = ev({ type: "gave", actor: "Elena", target: "Marcus", object: "ring", worldDay: 40 });
    expect(project([late, early]).ownership.get("ring")?.owner).toBe("Marcus");
  });
});

describe("project — commitments and questions stay open until discharged", () => {
  it("records a promise as an open commitment against its target", () => {
    const p = project([
      ev({
        type: "promised",
        actor: "the user",
        target: "Elena",
        value: "return before sunset",
      }),
    ]);
    expect(p.commitments).toHaveLength(1);
    expect(p.commitments[0]?.status).toBe("open");
    expect(p.commitments[0]?.target).toBe("Elena");
  });

  it("keeps a refusal as a commitment, because it binds future behaviour too", () => {
    const p = project([
      ev({ type: "refused", actor: "the user", value: "to lie, to anyone, ever" }),
    ]);
    expect(p.commitments[0]?.kind).toBe("refusal");
  });

  it("discharges only the most recent matching commitment", () => {
    // Two promises to the same person are two commitments, not a restatement.
    const p = project([
      ev({ type: "promised", actor: "the user", target: "Odell", value: "half the payment" }),
      ev({ type: "promised", actor: "the user", target: "Odell", value: "half the payment" }),
      ev({ type: "fulfilled", actor: "the user", value: "half the payment", worldDay: 9 }),
    ]);
    expect(p.commitments.filter((c) => c.status === "open")).toHaveLength(1);
  });

  it("answers a question without deleting that it was asked", () => {
    const p = project([
      ev({ type: "asked", actor: "the user", target: "Elena", value: "who sealed the room" }),
      ev({ type: "answered", actor: "Elena", object: "who sealed the room", value: "the steward", worldDay: 4 }),
    ]);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]?.status).toBe("answered");
    expect(p.questions[0]?.answer).toBe("the steward");
  });

  it("reports what is still unresolved", () => {
    /*
     * "What is still unresolved" is an aggregate over the ABSENCE of a later
     * event. There is nothing to embed and nothing to rank, so a flat memory
     * store cannot answer it at all — at any store size, with any weights.
     */
    const p = project([
      ev({ type: "promised", actor: "the user", target: "Elena", value: "return before sunset" }),
      ev({ type: "asked", actor: "the user", target: "Elena", value: "who sealed the room" }),
      ev({ type: "asked", actor: "the user", target: "Odell", value: "the price of rope" }),
      ev({ type: "answered", actor: "Odell", object: "the price of rope", value: "two crowns", worldDay: 2 }),
    ]);
    const open = openThreads(p);
    expect(open.commitments).toHaveLength(1);
    expect(open.questions).toHaveLength(1);
    expect(open.questions[0]?.topic).toContain("sealed");
  });
});

describe("project — the remaining projections", () => {
  it("supersedes a relation rather than accumulating contradictory ones", () => {
    const p = project([
      ev({ type: "relation_stated", actor: "Elena", target: "the user", value: "distrusts" }),
      ev({ type: "relation_changed", actor: "Elena", target: "the user", value: "trusts", worldDay: 20 }),
    ]);
    expect(p.relations.size).toBe(1);
    expect([...p.relations.values()][0]?.relation).toBe("trusts");
  });

  it("keeps relations directional", () => {
    // Elena's view of Marcus is not Marcus's view of Elena.
    const p = project([
      ev({ type: "relation_stated", actor: "Elena", target: "Marcus", value: "brother" }),
      ev({ type: "relation_stated", actor: "Marcus", target: "Elena", value: "resents" }),
    ]);
    expect(p.relations.size).toBe(2);
  });

  it("supersedes a numeric, because a count is state and not history", () => {
    const p = project([
      ev({ type: "numeric_stated", actor: "Vale", object: "guards at the keep", quantity: 12 }),
      ev({ type: "numeric_stated", actor: "Vale", object: "guards at the keep", quantity: 9, worldDay: 30 }),
    ]);
    expect(p.numerics.get("guards at the keep")?.value).toBe(9);
  });

  it("defaults a disclosure's knownBy to the people present", () => {
    // Knowledge isolation depends on this being right, so it fails toward FEWER
    // knowers rather than more.
    const p = project([
      ev({ type: "revealed", actor: "Marcus", target: "the user", value: "he was at the gate that night" }),
    ]);
    expect(p.disclosures[0]?.knownBy).toEqual(["Marcus", "the user"]);
  });

  it("ignores an event missing the field its projection needs", () => {
    // Extraction will emit incomplete events. A projection must skip them, not
    // store a half-record that later reads as fact.
    const p = project([
      ev({ type: "gave", actor: "the user", target: "Elena" }),
      ev({ type: "numeric_stated", actor: "Vale", object: "guards" }),
      ev({ type: "promised", actor: "the user", target: "Elena" }),
    ]);
    expect(p.ownership.size).toBe(0);
    expect(p.numerics.size).toBe(0);
    expect(p.commitments).toHaveLength(0);
  });

  it("is a pure function of the log", () => {
    const events = [
      ev({ type: "acquired", actor: "the user", object: "Ravenblade" }),
      ev({ type: "promised", actor: "the user", target: "Elena", value: "return before sunset" }),
    ];
    expect(JSON.stringify([...project(events).ownership])).toBe(
      JSON.stringify([...project(events).ownership]),
    );
  });
});

describe("project — observation is knowledge, not world truth", () => {
  it("records a perception without changing what the world contains", () => {
    /*
     * The distinction the `observed` type exists for. A beacon burning on the
     * headland was already burning; the user seeing it changes what the USER
     * knows. Folding that into world state would make "the user saw it" and
     * "it happened" the same record, and the difference is the whole basis of
     * knowledge isolation.
     */
    const p = project([
      ev({
        type: "observed",
        actor: "the user",
        object: "a beacon on the headland",
        value: "the user saw a beacon burning on the headland",
      }),
    ]);
    expect(p.observations).toHaveLength(1);
    expect(p.worldEvents).toHaveLength(0);
    expect(p.ownership.size).toBe(0);
  });

  it("keeps a perception private to the observer by default", () => {
    // Seeing a beacon tells nobody else. Defaulting knownBy to everyone present
    // is how a character mentions something they never witnessed.
    const p = project([
      ev({ type: "observed", actor: "the user", value: "smoke over the granary" }),
    ]);
    expect(p.observations[0]?.knownBy).toEqual(["the user"]);
  });

  it("honours an explicit knownBy when several people saw it", () => {
    const p = project([
      ev({
        type: "observed",
        actor: "the user",
        value: "the signal fire on the ridge",
        knownBy: ["the user", "Elena"],
      }),
    ]);
    expect(p.observations[0]?.knownBy).toEqual(["the user", "Elena"]);
  });

  it("separates observing a thing from the event that created it", () => {
    // Both can exist for one object and they are different facts: the mill
    // burning is world truth, the user smelling smoke is what the user knows.
    const p = project([
      ev({ type: "world_event", actor: "the world", object: "the mill", value: "the mill burned" }),
      ev({ type: "observed", actor: "the user", value: "smoke from the mill", worldDay: 2 }),
    ]);
    expect(p.worldEvents).toHaveLength(1);
    expect(p.observations).toHaveLength(1);
  });

  it("skips an observation carrying nothing to record", () => {
    const p = project([ev({ type: "observed", actor: "the user" })]);
    expect(p.observations).toHaveLength(0);
  });
});
