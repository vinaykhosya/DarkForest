import { describe, expect, it } from "vitest";
import { routeQuery } from "./query-router.js";

const ALIASES = ["Elena", "Marcus", "Odell", "Captain Vale", "Ravenhold"];

describe("routeQuery — questions with exact answers", () => {
  it("routes a promise question to commitments, with its target", () => {
    const r = routeQuery("What did I promise Elena?", ALIASES);
    expect(r.intent).toEqual({
      kind: "commitment",
      actor: "the user",
      target: "Elena",
      commitmentKind: "promise",
    });
  });

  it("routes a refusal separately from a promise", () => {
    // Both bind future behaviour, but "what did I refuse" and "what did I
    // promise" must not return each other's rows.
    expect(routeQuery("What do I refuse to do?", ALIASES).intent).toMatchObject({
      kind: "commitment",
      commitmentKind: "refusal",
    });
  });

  it("prefers the question pattern over disclosure when both could match", () => {
    /*
     * "What did I ask Elena about the sealed room" contains both an asking verb
     * and a secret-shaped noun. Ordering decides it, so this pins the order.
     */
    const r = routeQuery("What did I ask Elena about the sealed room?", ALIASES);
    expect(r.intent).toMatchObject({ kind: "question", asker: "the user", askee: "Elena" });
  });

  it("extracts the counted noun from a how-many question", () => {
    expect(routeQuery("How many guards remain at the keep?", ALIASES).intent).toMatchObject({
      kind: "numeric",
      key: "guards",
    });
  });

  it("finds both parties in a relation question, in order", () => {
    expect(routeQuery("Who is Marcus to Elena?", ALIASES).intent).toMatchObject({
      kind: "relation",
      from: "Marcus",
      to: "Elena",
    });
  });

  it("routes unresolved-thread questions, which no memory search can answer", () => {
    // An aggregate over the ABSENCE of a later event. Nothing to embed.
    expect(routeQuery("What unresolved things do we still need to investigate?").intent).toEqual({
      kind: "open_threads",
    });
  });

  it("resolves first person to the speaker rather than leaving a pronoun", () => {
    const r = routeQuery("What am I afraid of?", ALIASES);
    expect(r.intent).toMatchObject({ kind: "persona", subject: "the user" });
  });

  it("attributes a disclosure to the character who made it", () => {
    expect(routeQuery("What did Marcus admit to me?", ALIASES).intent).toMatchObject({
      kind: "disclosure",
      actor: "Marcus",
    });
  });
});

describe("routeQuery — falling through is the safe outcome", () => {
  it("returns no intent for a genuinely associative question", () => {
    /*
     * The questions that keep the product from feeling brittle. There is no
     * type, no entity filter, and no exact answer — semantic retrieval is the
     * right instrument and the router must not pretend otherwise.
     */
    for (const q of [
      "Tell me about that strange evening near the river.",
      "What was going on the night everything went wrong?",
      "Remind me how we ended up here.",
    ]) {
      expect(routeQuery(q, ALIASES).intent, q).toBeNull();
    }
  });

  it("does not route on a bare greeting or an empty turn", () => {
    expect(routeQuery("Elena, I'm back.", ALIASES).intent).toBeNull();
    expect(routeQuery("", ALIASES).intent).toBeNull();
  });

  it("reports which pattern matched, so misrouting can be attributed", () => {
    // Without this, an over-eager pattern is invisible in aggregate recall.
    expect(routeQuery("What did I promise Elena?", ALIASES).matched).toBe("commitment.promise");
    expect(routeQuery("Tell me about the river.", ALIASES).matched).toBeNull();
  });

  it("works with no alias list at all", () => {
    // A new world has no alias table yet; routing must degrade, not throw.
    const r = routeQuery("What did I promise Elena?");
    expect(r.intent).toMatchObject({ kind: "commitment", target: null });
  });
});
