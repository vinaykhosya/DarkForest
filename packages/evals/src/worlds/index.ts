import { ASHFORD } from "./ashford.js";
import { KAPOOR_HOUSE } from "./kapoor-house.js";
import { MARS_COLONY } from "./mars-colony.js";
import { RAVENHOLD } from "./ravenhold.js";
import type { TestWorld } from "./types.js";

export * from "./types.js";
export { RAVENHOLD, KAPOOR_HOUSE, MARS_COLONY, ASHFORD };

/** All four canonical worlds — docs/15 § 3. Order is stable; do not sort. */
export const TEST_WORLDS: readonly TestWorld[] = [
  RAVENHOLD,
  KAPOOR_HOUSE,
  MARS_COLONY,
  ASHFORD,
];

export function worldByName(name: string): TestWorld | undefined {
  return TEST_WORLDS.find((w) => w.name.toLowerCase().includes(name.toLowerCase()));
}
