import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // docs/15 § 2 — the unit suite runs offline, free, in seconds.
    // Any test that needs a live model is in the eval harness, not here.
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    env: { MOCK_AI: "true", DF_ENV: "local" },
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**"],
      thresholds: {
        // packages/core holds the algorithms the product depends on.
        // It is pure, so there is no excuse for gaps.
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
