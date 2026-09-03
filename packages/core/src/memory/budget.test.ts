import { describe, expect, it } from "vitest";
import {
  COMPACT_PROFILE,
  FULL_PROFILE,
  REQUEST_CEILINGS,
  fitsUnderCeiling,
  totalBudget,
} from "./budget.js";

/**
 * ADR-020. These assertions encode a measured provider constraint, not a
 * preference — if a profile change breaks one, the prompt genuinely will not be
 * accepted by the provider.
 */
describe("request ceilings", () => {
  it("compact fits on Groq free tier", () => {
    expect(fitsUnderCeiling(COMPACT_PROFILE, REQUEST_CEILINGS.groqFree)).toBe(true);
  });

  it("full does NOT fit on Groq free tier — it must route to OpenRouter", () => {
    expect(fitsUnderCeiling(FULL_PROFILE, REQUEST_CEILINGS.groqFree)).toBe(false);
    expect(fitsUnderCeiling(FULL_PROFILE, REQUEST_CEILINGS.openrouter)).toBe(true);
  });

  it("leaves real headroom on compact rather than sitting on the limit", () => {
    // A profile that exactly hits 8000 fails the moment a character profile
    // runs long. Keep a margin.
    const used = totalBudget(COMPACT_PROFILE) + 600;
    expect(REQUEST_CEILINGS.groqFree - used).toBeGreaterThan(1_000);
  });

  it("accounts for the output reservation, not just the input", () => {
    const almost = REQUEST_CEILINGS.groqFree - totalBudget(COMPACT_PROFILE) - 10;
    expect(fitsUnderCeiling(COMPACT_PROFILE, REQUEST_CEILINGS.groqFree, almost)).toBe(true);
    expect(fitsUnderCeiling(COMPACT_PROFILE, REQUEST_CEILINGS.groqFree, almost + 100)).toBe(false);
  });
});
