/**
 * AGENCY FIXTURE — fresh sentences, deliberately not Suite 1.
 *
 * The context ladder placed the extraction blind spot: f12 ("I see X") and f13
 * ("X saved my life") produce NO events even when handed to the model alone,
 * while f19 — same event type, same machinery — captures every time. Everything
 * that works has the user as agent of an explicit act. Both hard failures have
 * the user as witness or recipient.
 *
 * That hypothesis cannot be tested on Suite 1, which is where it came from. So
 * this is a new cast, new setting, and thirty-two sentences the extractor has
 * never seen, balanced across four agency shapes with filler for precision.
 *
 * WHY THIS MATTERS BEYOND A BENCHMARK
 * A world that records what the player does and forgets what happens around
 * them is not a persistent world. "The bridge collapses", "Elena betrays me",
 * "the old wizard dies" are the events a story is made of, and none of them has
 * the player as agent.
 *
 * The category label is metadata for scoring only. Nothing in the prompt tells
 * the model which shape a sentence is.
 */

export interface AgencyCase {
  id: string;
  /** Scoring metadata only — never shown to the model. */
  category: "user" | "other" | "world" | "perception" | "filler";
  text: string;
  /**
   * Surface forms that count as capture, matched by the frozen contract.
   * Empty for filler: any event at all is a false positive there.
   */
  expect: readonly string[];
}

/** A cast with no overlap with Suite 1, so no alias can leak between them. */
export const AGENCY_ENTITIES = ["Bram", "Sera", "Tolven", "the magistrate"] as const;

export const AGENCY_CASES: readonly AgencyCase[] = [
  // ── the user acts. The shape that already works. ──────────────────────────
  { id: "u1", category: "user", text: "I buy a lantern from Bram for six coins.", expect: ["lantern"] },
  { id: "u2", category: "user", text: "I promise Sera I will not go back to the mill.", expect: ["mill"] },
  { id: "u3", category: "user", text: "I hide the brass key under the loose flagstone.", expect: ["key"] },
  { id: "u4", category: "user", text: "I tell Tolven I have never trusted the magistrate.", expect: ["magistrate", "trust"] },
  { id: "u5", category: "user", text: "I give Sera my father's ring.", expect: ["ring"] },
  { id: "u6", category: "user", text: "I refuse to sign the warrant.", expect: ["warrant", "sign"] },

  // ── someone else acts, often upon the user. ───────────────────────────────
  { id: "o1", category: "other", text: "Sera hands me the sealed letter without a word.", expect: ["letter"] },
  { id: "o2", category: "other", text: "Bram steals the lantern while my back is turned.", expect: ["lantern", "stole", "steal"] },
  { id: "o3", category: "other", text: "Tolven pulls me out of the water before I go under.", expect: ["water", "pull", "saved"] },
  { id: "o4", category: "other", text: "The magistrate accuses me of forging the ledger.", expect: ["ledger", "accus", "forg"] },
  { id: "o5", category: "other", text: "Sera admits she has been reading my letters.", expect: ["letters", "read"] },
  { id: "o6", category: "other", text: "Bram swears he will never speak to me again.", expect: ["speak", "never"] },

  // ── the world acts, with no actor at all. ─────────────────────────────────
  { id: "w1", category: "world", text: "The east bridge collapses into the river.", expect: ["bridge", "collaps"] },
  { id: "w2", category: "world", text: "Lightning splits the old oak beside the gate.", expect: ["oak", "lightning"] },
  { id: "w3", category: "world", text: "The mill burns through the night.", expect: ["mill", "burn"] },
  { id: "w4", category: "world", text: "A bell begins ringing in the lower town.", expect: ["bell", "ring"] },
  { id: "w5", category: "world", text: "The river rises over the causeway.", expect: ["river", "causeway"] },
  { id: "w6", category: "world", text: "Frost kills the last of the orchard.", expect: ["orchard", "frost"] },

  // ── the user perceives. The shape f12 failed on. ──────────────────────────
  { id: "p1", category: "perception", text: "I see a signal fire on the northern ridge.", expect: ["signal fire", "ridge", "fire"] },
  { id: "p2", category: "perception", text: "I discover a passage behind the wine racks.", expect: ["passage"] },
  { id: "p3", category: "perception", text: "I hear someone weeping below the floor.", expect: ["weep", "crying"] },
  { id: "p4", category: "perception", text: "I notice the magistrate's seal on the cellar door.", expect: ["seal"] },
  { id: "p5", category: "perception", text: "I find Bram's knife in the ashes.", expect: ["knife"] },
  { id: "p6", category: "perception", text: "I smell smoke coming from the granary.", expect: ["smoke", "granary"] },

  /*
   * Filler. Any event here is a false positive.
   *
   * "The fire burns low" is deliberately the hardest case in the set: it is
   * grammatically a world event and narratively scenery. An extractor that
   * fires on it is recording weather.
   */
  { id: "n1", category: "filler", text: "I walk to the window and look out.", expect: [] },
  { id: "n2", category: "filler", text: "Good evening, Sera.", expect: [] },
  { id: "n3", category: "filler", text: "The fire burns low in the grate.", expect: [] },
  { id: "n4", category: "filler", text: "I wait.", expect: [] },
  { id: "n5", category: "filler", text: "I sit down and rub my eyes.", expect: [] },
  { id: "n6", category: "filler", text: "It is colder tonight than it was.", expect: [] },
  { id: "n7", category: "filler", text: "I nod.", expect: [] },
  { id: "n8", category: "filler", text: "I think about it for a while.", expect: [] },
];
