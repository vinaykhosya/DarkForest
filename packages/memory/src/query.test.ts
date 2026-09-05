import { describe, expect, it } from "vitest";
import { buildQuery } from "./retrieval.js";
import type { WorldId } from "@darkforest/contracts";

const WORLD = "w1" as unknown as WorldId;

function input(over: Partial<Parameters<typeof buildQuery>[0]> = {}) {
  return {
    worldId: WORLD,
    characterId: null,
    userMessage: "",
    ...over,
  } as Parameters<typeof buildQuery>[0];
}

/**
 * These pin the fix for the single largest recall failure measured so far.
 *
 * Suite 1 probed the SAME 38-memory store two ways: mid-session, where
 * `recentLines` is populated, recalled 3 of 19; a fresh session, where it is
 * empty, recalled 4 of 5. 31 of 43 failed probes were stored-but-not-retrieved,
 * and a fact that did surface ranked first — so ranking was fine and the
 * memories were simply missing from the candidate set.
 */
describe("buildQuery — two queries, because the search paths fail differently", () => {
  const NARRATIVE = [
    "Elena turns the lantern down and the shadows crawl up the chapel wall.",
    "Rain hammers the shutters; somewhere below, a door closes.",
  ];

  it("does NOT dilute the vector query when the message can stand alone", () => {
    // An embedding is one averaged point. Appending two lines of prose to a
    // short question drags that point towards the recent topic and away from
    // what was asked.
    const q = buildQuery(
      input({ userMessage: "What did I promise Odell?", recentLines: NARRATIVE }),
    );
    expect(q.vectorText).toBe("What did I promise Odell?");
    expect(q.vectorText).not.toContain("lantern");
    expect(q.vectorText).not.toContain("Rain");
  });

  it("still widens the KEYWORD query, where extra terms only add recall", () => {
    // A term search matches terms independently, so widening costs nothing and
    // rescues short turns. The two paths genuinely want different queries.
    const q = buildQuery(
      input({ userMessage: "What did I promise Odell?", recentLines: NARRATIVE }),
    );
    expect(q.text).toContain("lantern");
    expect(q.text).toContain("promise Odell");
  });

  it("widens the vector query when the message cannot retrieve on its own", () => {
    // The case the widening existed for. "yes" embeds to nothing useful.
    const q = buildQuery(input({ userMessage: "yes", recentLines: NARRATIVE }));
    expect(q.vectorText).toContain("lantern");
  });

  it("treats a message of only stopwords as unable to stand alone", () => {
    const q = buildQuery(input({ userMessage: "and then what", recentLines: NARRATIVE }));
    expect(q.vectorText).toContain("lantern");
  });

  it("keeps entity names on the narrow vector query", () => {
    // A name is the highest-signal retrieval term and costs one token, unlike a
    // paragraph of prose — so narrowing must not drop it. Here the alias appears
    // only in the recent lines, so it survives ONLY if entities are carried over
    // separately from the prose they were found in.
    const q = buildQuery(
      input({
        userMessage: "Which sword did I buy?",
        recentLines: NARRATIVE,
        aliases: ["Elena"],
      }),
    );
    expect(q.entities).toContain("Elena");
    expect(q.vectorText).toContain("Elena");
    expect(q.vectorText).not.toContain("lantern");
  });

  it("counts content words, not raw length, when deciding self-sufficiency", () => {
    // "What did I promise Odell?" is five words but only {promise, odell} carry
    // signal. A threshold set on raw length would widen a specific question.
    expect(buildQuery(input({ userMessage: "What did I promise Odell?" })).vectorText).toBe(
      "What did I promise Odell?",
    );
    expect(buildQuery(input({ userMessage: "he did", recentLines: NARRATIVE })).vectorText).toContain(
      "lantern",
    );
  });

  it("is unchanged by recentLines when there are none", () => {
    // The fresh-session path, which was already working and must stay working.
    const q = buildQuery(input({ userMessage: "What sword do I own?" }));
    expect(q.vectorText).toBe("What sword do I own?");
    expect(q.text).toBe("What sword do I own?");
  });
});
