/**
 * THE EXTRACTION STUDY SET — held out, balanced, and independent of every prompt.
 *
 * Built after two contaminations, so the properties are deliberate:
 *
 *  1. EVERY SENTENCE IS IN A DOMAIN NO PROMPT EXAMPLE USES. The prompts teach
 *     with rope, Odell, Elena, sunset, beacons, cellars, horses, mountains and
 *     the north bridge. Nothing here touches any of them, and
 *     `contamination.test.ts` proves it rather than my asserting it.
 *
 *  2. STANDING FACTS ARE OVER-REPRESENTED, because that is the failing category.
 *     Eight of twenty-two positives, against one or two per transition type.
 *     A balanced-by-type set would average the failure away.
 *
 *  3. NEGATIVES ARE REAL NEGATIVES. Six sentences that a good extractor must
 *     leave alone. Without them a prompt change that simply extracts more looks
 *     like an improvement, and the way to score 22/22 is to record everything.
 *
 * `shape` is finer-grained than `expectedType` on purpose: "inability" and
 * "origin" both map to `preference_stated`, and reporting per SHAPE is what
 * shows that one is captured and the other is not.
 */

export interface StudyCase {
  id: string;
  /** The natural-language shape being tested. Reported per shape. */
  shape: string;
  /** What the player types. The only thing extraction sees (V1-T19). */
  text: string;
  /**
   * Whether a durable fact is present at all.
   *
   * Not which type it should be. Capture is the question under study, and
   * scoring the type as well would conflate "did not notice" with "noticed and
   * filed it differently than I would have" — which need opposite fixes.
   */
  durable: boolean;
  /** The family, for reporting. Standing facts are the weak one. */
  family: "transition" | "standing" | "none";
}

export const STUDY_CASES: readonly StudyCase[] = [
  // ── transitions — the shapes that already work, kept as the control group ──
  { id: "T01", shape: "acquired", family: "transition", durable: true, text: "I picked up a brass key from the innkeeper's desk." },
  { id: "T02", shape: "gave", family: "transition", durable: true, text: "I handed Sera the last of my bread." },
  { id: "T03", shape: "lost", family: "transition", durable: true, text: "My knife went over the side of the boat." },
  { id: "T04", shape: "promised", family: "transition", durable: true, text: "I swore to Sera I would fix her roof before the rains." },
  { id: "T05", shape: "refused", family: "transition", durable: true, text: "I told the reeve I will not carry messages for him." },
  { id: "T06", shape: "fulfilled", family: "transition", durable: true, text: "I finished mending Sera's roof this morning, as I said I would." },
  { id: "T07", shape: "asked", family: "transition", durable: true, text: "I asked Sera what happened to the old mill." },
  { id: "T08", shape: "answered", family: "transition", durable: true, text: "I told Sera the mill stopped when the sluice gate broke." },
  { id: "T09", shape: "revealed", family: "transition", durable: true, text: "I admitted to Sera that I was the one who let the dog out." },
  { id: "T10", shape: "observed", family: "transition", durable: true, text: "I noticed a fresh scorch mark on the forge wall." },
  { id: "T11", shape: "world_event", family: "transition", durable: true, text: "A fire took the tannery last night." },
  { id: "T12", shape: "relation_stated", family: "transition", durable: true, text: "Sera is my cousin on my mother's side." },
  { id: "T13", shape: "relation_changed", family: "transition", durable: true, text: "Sera and I are not speaking any more." },
  { id: "T14", shape: "numeric_stated", family: "transition", durable: true, text: "There are four wells left in this town." },

  // ── standing facts — the category the V0.1 gate fails on ──────────────────
  { id: "S01", shape: "inability", family: "standing", durable: true, text: "I have never been able to hold my breath underwater." },
  { id: "S02", shape: "capability", family: "standing", durable: true, text: "I speak the northern tongue well enough to bargain in it." },
  { id: "S03", shape: "condition", family: "standing", durable: true, text: "My knee locks up in cold weather." },
  { id: "S04", shape: "origin", family: "standing", durable: true, text: "I was raised in a village three valleys east of here." },
  { id: "S05", shape: "past occupation", family: "standing", durable: true, text: "I kept books for a merchant house before all this." },
  { id: "S06", shape: "identity", family: "standing", durable: true, text: "People call me Wren, though it isn't the name I was given." },
  { id: "S07", shape: "obligation", family: "standing", durable: true, text: "I am not allowed to set foot in the upper town." },
  { id: "S08", shape: "fear", family: "standing", durable: true, text: "Deep water frightens me more than any blade." },

  // ── negatives — a good extractor leaves every one of these alone ──────────
  { id: "N01", shape: "greeting", family: "none", durable: false, text: "Evening. Quiet in here tonight." },
  { id: "N02", shape: "movement", family: "none", durable: false, text: "I walk down to the water and stand there a while." },
  { id: "N03", shape: "scenery", family: "none", durable: false, text: "The lamps are guttering low along the quay." },
  { id: "N04", shape: "politeness", family: "none", durable: false, text: "Thank you. That is kind of you to say." },
  { id: "N05", shape: "filler", family: "none", durable: false, text: "Hm. I suppose that is one way to look at it." },
  { id: "N06", shape: "idle action", family: "none", durable: false, text: "I brush the dust off my coat and sit down." },
];

export const STUDY_POSITIVES = STUDY_CASES.filter((c) => c.durable);
export const STUDY_NEGATIVES = STUDY_CASES.filter((c) => !c.durable);
