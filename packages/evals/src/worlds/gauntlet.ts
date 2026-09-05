/**
 * SUITE 2 — THE GAUNTLET. The final gate before the architecture freezes.
 *
 * Deliberately NOT Suite 1.5. Suite 1 plants twenty labelled facts and asks for
 * them back, which measures extraction and retrieval of isolated statements. It
 * cannot measure the things a persistent world is actually made of: that a ring
 * changed hands three times, that Elena never learned what the player told Bram,
 * that a promise is still owed, that the player saw something with their own
 * eyes rather than being told.
 *
 * DESIGN RULES, all of which Suite 1 breaks:
 *
 *  1. The questions are written as a player would ask them, not around our
 *     schema. Nothing says "observed" or "commitment".
 *  2. Facts arrive through play, not as labelled statements to be memorised.
 *  3. Roughly half of every script is mundane, so noise resistance is measured
 *     rather than assumed.
 *  4. Some probes assert what must NOT come back. A world that answers "what did
 *     Elena tell me about the door" with something Bram said is not a world.
 *  5. Nothing is probed at the turn it happens. Everything is asked long after.
 *
 * The `forbid` field is the sharpest instrument here. Recall can be gamed by
 * returning more; knowledge isolation cannot. It is the difference between a
 * cast of characters and one narrator wearing several names.
 */

export type Dimension =
  | "state"
  | "history"
  | "temporal"
  | "relationship"
  | "isolation"
  | "perception"
  | "indirect"
  | "contradiction"
  | "multichar"
  | "longhorizon"
  | "noise";

export interface GauntletProbe {
  id: string;
  dimension: Dimension;
  /** Whose perspective is being asked. Isolation depends on this. */
  askedOf: string;
  question: string;
  /** At least one must appear in what comes back. */
  expect: readonly string[];
  /**
   * None of these may appear. A leak here is worse than a miss: it means a
   * character knows something nobody told them.
   */
  forbid?: readonly string[];
  /** Turn index to ask at. Always well after the events involved. */
  at: number;
  /** Plain-language note on what failure would mean for the product. */
  why: string;
}

export interface GauntletWorld {
  id: string;
  name: string;
  genre: readonly string[];
  tone: string;
  location: string;
  startingDay: number;
  characters: ReadonlyArray<{ id: string; name: string; persona: string }>;
  aliases: readonly string[];
  rules: readonly string[];
  /** The player's turns, in order. Mundane by design about half the time. */
  script: readonly string[];
  probes: readonly GauntletProbe[];
}

/* ════════════════════════════════════════════════════════════════════════════
 * WORLD A — SALTMARSH
 * Ownership that changes hands three times, a secret told to exactly one
 * person, a lie that contradicts what the player witnessed, an unpaid debt.
 * ════════════════════════════════════════════════════════════════════════════ */

const SALTMARSH_SCRIPT: readonly string[] = [
  /* 0 */ "I come down the marsh road into Saltmarsh as the tide is going out.",
  /* 1 */ "I take a room at the Drowned Bell and ask Sera for something hot.",
  /* 2 */ "I sit by the fire and dry my boots.",
  /* 3 */ "I buy a silver ring from Bram at the forge for eleven marks.",
  /* 4 */ "I ask Sera how long the rain has been like this.",
  /* 5 */ "I watch the boats come in.",
  /* 6 */ "I eat and go up early.",
  /* 7 */ "I walk out to the ferry landing in the morning.",
  /* 8 */ "I promise Tolven I will bring his lantern back before the new moon.",
  /* 9 */ "I help Tolven coil the mooring rope.",
  /* 10 */ "I ask Tolven whether the crossing is bad this time of year.",
  /* 11 */ "I walk back along the seawall.",
  /* 12 */ "I give Elena the silver ring and tell her it is a poor apology.",
  /* 13 */ "Elena and I eat at the Bell and say very little.",
  /* 14 */ "I sleep badly.",
  /* 15 */ "I spend the morning mending my pack.",
  /* 16 */ "I go down into the cellar of the Bell to fetch up a cask for Sera.",
  /* 17 */ "The air down there is colder than it should be.",
  /* 18 */ "I see a sealed door behind the racks at the back of the cellar.",
  /* 19 */ "I come back up and say nothing about it.",
  /* 20 */ "From the seawall I watch the caravan leave, and it takes the east road.",
  /* 21 */ "I count fourteen wagons before they are out of sight.",
  /* 22 */ "I tell Sera the caravan went north, because I do not trust her yet.",
  /* 23 */ "I ask Sera what she pays for salt these days.",
  /* 24 */ "I sharpen my knife.",
  /* 25 */ "I walk up to the forge in the evening.",
  /* 26 */ "I tell Bram about the sealed door in the cellar, and only Bram.",
  /* 27 */ "Bram and I talk about the price of iron for a while.",
  /* 28 */ "I sit outside the forge until it gets dark.",
  /* 29 */ "I sleep better.",
  /* 30 */ "Elena gives the silver ring to Bram to settle a debt of hers.",
  /* 31 */ "I do not say anything about it to Elena.",
  /* 32 */ "I wash my shirt in the rain barrel.",
  /* 33 */ "I take the ferry out to the sandbar with Tolven.",
  /* 34 */ "The water is higher than Tolven expected.",
  /* 35 */ "Tolven pulls me out of the channel when I go under, and holds on until I am on the boards.",
  /* 36 */ "I lie on the deck for a long time and say nothing.",
  /* 37 */ "We come back in after dark.",
  /* 38 */ "I sleep for most of the next day.",
  /* 39 */ "I eat downstairs and listen to the rain.",
  /* 40 */ "I hear bells ringing out in the lower town in the middle of the night.",
  /* 41 */ "Nobody at the Bell will say what the bells were for.",
  /* 42 */ "I walk down to the lower town in the morning.",
  /* 43 */ "The streets are wet and mostly empty.",
  /* 44 */ "Bram sells the silver ring on to a factor from Wexley.",
  /* 45 */ "I buy bread and go back up.",
  /* 46 */ "I mend the strap on my pack again.",
  /* 47 */ "I sit with Elena and neither of us mentions the ring.",
  /* 48 */ "I ask Sera for more candles.",
  /* 49 */ "The rain stops for an hour and then starts again.",
  /* 50 */ "I clean my boots.",
  /* 51 */ "I count what money I have left.",
  /* 52 */ "I walk the seawall again.",
  /* 53 */ "I watch a gull work at something in the mud.",
  /* 54 */ "I go to bed early.",
  /* 55 */ "I wake before it is light.",
  /* 56 */ "I sit in the common room until Sera comes down.",
  /* 57 */ "I ask her whether the ferry is running.",
  /* 58 */ "It is not.",
  /* 59 */ "I spend the day indoors.",
];

const SALTMARSH_PROBES: readonly GauntletProbe[] = [
  {
    id: "A-state-ring",
    dimension: "state",
    askedOf: "Elena",
    question: "Who has that silver ring now?",
    expect: ["Wexley", "factor", "sold"],
    // Elena and Bram both held it earlier. Returning either is a stale answer.
    forbid: [],
    at: 52,
    why: "An object that changed hands three times must resolve to its CURRENT holder, not the loudest memory of it.",
  },
  {
    id: "A-history-ring",
    dimension: "contradiction",
    askedOf: "Elena",
    question: "Who did I give that ring to in the first place?",
    expect: ["Elena"],
    at: 53,
    why: "The original giving is still true as history even though the ownership state has moved on. Both answers must coexist.",
  },
  {
    id: "A-isolation-bram",
    dimension: "isolation",
    askedOf: "Bram",
    question: "What do you know about the cellar under the Bell?",
    expect: ["door", "sealed"],
    at: 50,
    why: "Bram was told. He should know.",
  },
  {
    id: "A-isolation-elena",
    dimension: "isolation",
    askedOf: "Elena",
    question: "What do you know about the cellar under the Bell?",
    expect: [],
    // The whole point. Elena was never told and never went down there.
    forbid: ["sealed door", "sealed", "behind the racks"],
    at: 51,
    why: "Elena was never told. If she knows, characters are one narrator wearing several names, and the product is fake.",
  },
  {
    id: "A-perception-caravan",
    dimension: "perception",
    askedOf: "Elena",
    question: "Which way did I actually watch the caravan go?",
    expect: ["east"],
    forbid: ["north"],
    at: 48,
    why: "What the player WITNESSED must outrank what the player SAID. Confusing them makes the world unable to hold a lie.",
  },
  {
    id: "A-history-lie",
    dimension: "history",
    askedOf: "Elena",
    question: "What did I tell Sera about the caravan?",
    expect: ["north"],
    at: 49,
    why: "The lie is itself an event. A world that only records truth cannot support deception, which is most of drama.",
  },
  {
    id: "A-relationship-tolven",
    dimension: "relationship",
    askedOf: "Elena",
    question: "Why do I owe Tolven anything?",
    expect: ["pulled", "water", "channel", "under", "saved"],
    at: 47,
    why: "A relationship changed because of a specific event. The reason must survive, not just the fact that something changed.",
  },
  {
    id: "A-commitment",
    dimension: "state",
    askedOf: "Tolven",
    question: "Is there anything I still owe you?",
    expect: ["lantern"],
    at: 46,
    why: "An unfulfilled promise is an open thread. Forgetting it is how a world stops feeling like it is watching.",
  },
  {
    id: "A-perception-bells",
    dimension: "perception",
    askedOf: "Sera",
    question: "Did I hear anything strange the other night?",
    expect: ["bell"],
    at: 55,
    why: "Perception with no actor and no object taken. The category that scored 33% before the ontology gained `observed`.",
  },
  {
    id: "A-longhorizon",
    dimension: "longhorizon",
    askedOf: "Bram",
    question: "What did I buy from you when I first came here?",
    expect: ["ring", "silver"],
    at: 57,
    why: "Turn 3 recalled at turn 57, across fifty turns of mostly nothing. This is the product promise in one question.",
  },
  {
    id: "A-noise",
    dimension: "noise",
    askedOf: "Sera",
    question: "What have I actually done since I arrived?",
    expect: ["ring", "ferry", "cellar", "caravan", "Tolven"],
    forbid: ["boots", "gull", "candles"],
    at: 58,
    why: "Half this world is mundane. If cleaning boots ranks alongside nearly drowning, memory has no sense of proportion.",
  },
];

export const SALTMARSH: GauntletWorld = {
  id: "gauntlet-saltmarsh",
  name: "Saltmarsh",
  genre: ["low fantasy", "coastal"],
  tone: "wet, close, understated",
  location: "the Drowned Bell, Saltmarsh",
  startingDay: 1,
  characters: [
    { id: "elena", name: "Elena", persona: "A travelling companion. Dry, watchful, slow to speak." },
    { id: "bram", name: "Bram", persona: "The smith. Blunt, fair, remembers what he is owed." },
    { id: "tolven", name: "Tolven", persona: "The ferryman. Older, careful on the water, superstitious." },
    { id: "sera", name: "Sera", persona: "Keeps the Drowned Bell. Curious, and not always discreet." },
  ],
  aliases: ["Elena", "Bram", "Tolven", "Sera", "Saltmarsh", "the Drowned Bell", "Wexley"],
  rules: ["Characters only know what they witnessed or were told."],
  script: SALTMARSH_SCRIPT,
  probes: SALTMARSH_PROBES,
};

/* ════════════════════════════════════════════════════════════════════════════
 * WORLD B — ASHFORD
 * An adult relationship tested as MEMORY, not as content: attraction, a stated
 * boundary, a private evening, and who is entitled to know about it afterwards.
 * Nothing explicit is generated or required; what is measured is whether a
 * private event stays private and a boundary persists.
 * ════════════════════════════════════════════════════════════════════════════ */

const ASHFORD_SCRIPT: readonly string[] = [
  /* 0 */ "I take the room above the bakery in Ashford for the winter.",
  /* 1 */ "I meet Ilse on the stair and we talk longer than either of us meant to.",
  /* 2 */ "I unpack what little I brought.",
  /* 3 */ "I buy coal for the grate.",
  /* 4 */ "Ilse brings up bread that did not sell and stays an hour.",
  /* 5 */ "I read until it is too dark to read.",
  /* 6 */ "I walk with Ilse to the mill and back.",
  /* 7 */ "It is cold enough that the puddles hold.",
  /* 8 */ "I tell Ilse I am not passing through after all.",
  /* 9 */ "I fix the shutter that bangs.",
  /* 10 */ "Ronan comes by to ask about work and stays for tea.",
  /* 11 */ "I ask Ronan how long he has been in Ashford.",
  /* 12 */ "I sweep the stair.",
  /* 13 */ "Ilse and I sit up late talking about nothing.",
  /* 14 */ "Ilse tells me she will not talk about her brother, not ever, and I say I will not ask again.",
  /* 15 */ "I do not ask.",
  /* 16 */ "I mend a chair for Marta downstairs.",
  /* 17 */ "Marta pays me in flour.",
  /* 18 */ "I walk out past the orchard.",
  /* 19 */ "The frost has taken most of it.",
  /* 20 */ "Ilse and I argue about something small and neither of us apologises.",
  /* 21 */ "I stay out of the bakery for a day.",
  /* 22 */ "Ilse comes up and we sort it out.",
  /* 23 */ "I bank the fire and we sit close to it.",
  /* 24 */ "I tell Ilse I would rather be here than anywhere I have been.",
  /* 25 */ "She does not answer for a while, and then she does.",
  /* 26 */ "I buy more coal than I need.",
  /* 27 */ "Ronan is away at his sister's for the week.",
  /* 28 */ "Ilse stays with me that night, and neither of us goes down until it is light.",
  /* 29 */ "We do not talk about it in the morning.",
  /* 30 */ "I go out for flour and come back late.",
  /* 31 */ "Things are easier between us after that, and quieter.",
  /* 32 */ "I fix the other shutter.",
  /* 33 */ "It snows and then it rains.",
  /* 34 */ "Ilse tells Marta about that night, and Marta does not say anything to me.",
  /* 35 */ "Ronan comes back and asks what he missed.",
  /* 36 */ "I tell Ronan the shutter is fixed.",
  /* 37 */ "I split kindling for the week.",
  /* 38 */ "Marta gives me a loaf and does not charge me.",
  /* 39 */ "I read by the fire.",
  /* 40 */ "Ilse works late and I do not see her.",
  /* 41 */ "I clean the flue.",
  /* 42 */ "The bakery is busy for three days.",
  /* 43 */ "I keep out of the way.",
  /* 44 */ "Ronan and I carry sacks up from the cart.",
  /* 45 */ "I sleep badly and get up early.",
  /* 46 */ "I sit on the stair where I first met Ilse.",
  /* 47 */ "It is still cold.",
  /* 48 */ "I go back up.",
  /* 49 */ "The winter goes on.",
];

const ASHFORD_PROBES: readonly GauntletProbe[] = [
  {
    id: "B-isolation-ronan",
    dimension: "isolation",
    askedOf: "Ronan",
    question: "Did anything happen between me and Ilse while you were away?",
    expect: [],
    // Ronan was at his sister's. Nobody told him. This is the load-bearing test.
    forbid: ["stayed with", "that night", "stayed the night", "slept"],
    at: 44,
    why: "A private adult event must stay private. A character volunteering it is the single most damaging failure this product can have.",
  },
  {
    id: "B-isolation-marta",
    dimension: "isolation",
    askedOf: "Marta",
    question: "Has Ilse told you anything about me lately?",
    expect: ["night", "told", "Ilse"],
    at: 45,
    why: "Marta WAS told. Isolation must be a boundary, not a blanket refusal — a world where nobody knows anything is equally broken.",
  },
  {
    id: "B-boundary",
    dimension: "relationship",
    askedOf: "Ilse",
    question: "Is there anything you would rather I did not bring up?",
    expect: ["brother"],
    at: 46,
    why: "A stated boundary is a standing constraint on future behaviour. Forgetting it is how a character becomes unsafe to be close to.",
  },
  {
    id: "B-indirect",
    dimension: "indirect",
    askedOf: "Ilse",
    question: "What happened between us that night before Ronan got back?",
    expect: ["night", "stayed", "light"],
    at: 47,
    why: "An oblique reference with no keyword to match. This is where a structured lookup fails and semantic recall has to carry it.",
  },
  {
    id: "B-relationship-change",
    dimension: "relationship",
    askedOf: "Ilse",
    question: "Has anything changed between us this winter?",
    expect: ["easier", "quieter", "night", "closer"],
    at: 48,
    why: "Relationships evolve through events. A world that stores only the current label loses why it got there.",
  },
  {
    id: "B-temporal",
    dimension: "temporal",
    askedOf: "Ilse",
    question: "What were we arguing about before all that?",
    expect: ["argue", "small", "apolog"],
    at: 43,
    why: "Ordering matters. 'Before all that' is only answerable if events carry time rather than similarity.",
  },
  {
    id: "B-longhorizon",
    dimension: "longhorizon",
    askedOf: "Ilse",
    question: "Where was it that we first talked properly?",
    expect: ["stair"],
    at: 49,
    why: "Turn 1 recalled at turn 49. The first meeting is exactly what a returning player expects a world to still hold.",
  },
  {
    id: "B-noise",
    dimension: "noise",
    askedOf: "Marta",
    question: "What has actually mattered around here this winter?",
    expect: ["Ilse", "night", "brother", "argu"],
    forbid: ["shutter", "kindling", "flue"],
    at: 42,
    why: "Half of Ashford is chores. If fixing a shutter competes with a relationship changing, retrieval has no sense of weight.",
  },
];

export const ASHFORD: GauntletWorld = {
  id: "gauntlet-ashford",
  name: "Ashford",
  genre: ["contemporary", "quiet drama"],
  tone: "restrained, domestic, adult",
  location: "the room above the bakery, Ashford",
  startingDay: 1,
  characters: [
    { id: "ilse", name: "Ilse", persona: "Works the bakery. Direct, private, does not repeat herself." },
    { id: "ronan", name: "Ronan", persona: "Looks for work where he can. Friendly, talks a lot, away often." },
    { id: "marta", name: "Marta", persona: "Owns the bakery. Watches everything and says little." },
  ],
  aliases: ["Ilse", "Ronan", "Marta", "Ashford", "the bakery"],
  rules: [
    "Characters only know what they witnessed or were told.",
    "Adult relationships are handled with restraint; nothing explicit is narrated.",
  ],
  script: ASHFORD_SCRIPT,
  probes: ASHFORD_PROBES,
};

export const GAUNTLET_WORLDS: readonly GauntletWorld[] = [SALTMARSH, ASHFORD];
