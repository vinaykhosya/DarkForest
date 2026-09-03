// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Architectural rules are enforced here, not by convention.
 * Each block cites the document it enforces — if you are about to disable one,
 * read that document first and open an ADR.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "**/*.tsbuildinfo"],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  // ── Baseline ────────────────────────────────────────────────────────────────
  {
    rules: {
      // CLAUDE.md § 6 — no `any`, no silent escape hatches.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // docs/02 § 3 step 8c — every async boundary has a timeout.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",

      // docs/10 § 2 — errors are typed, never bare strings.
      "@typescript-eslint/only-throw-error": "error",

      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  // ── docs/08 § 4 — no model name outside configuration ───────────────────────
  // A hard-coded model id makes the router's whole purpose moot.
  {
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: [
      "packages/ai/src/registry/**",
      "packages/ai/src/providers/**",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(gpt-oss|nemotron|qwen3|llama-|gemini-|claude-|bge-base|whisper-)/i]",
          message:
            "Model identifiers belong in config/models.json or packages/ai/src/registry. " +
            "See docs/08-ai-router.md § 4 and ADR-009.",
        },
      ],
    },
  },

  // ── docs/02 § 2 — module boundaries ─────────────────────────────────────────
  // A module owns its tables. Others reach it through index.ts, never repo/service.
  {
    files: ["apps/api/src/modules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/modules/*/repo", "**/modules/*/repo.js", "**/modules/*/repo.ts"],
              message:
                "A module's repo.ts is private. Import the module's index.ts instead. " +
                "See docs/02-system-architecture.md § 2.",
            },
            {
              group: ["**/modules/*/service", "**/modules/*/service.js", "**/modules/*/service.ts"],
              message:
                "A module's service.ts is private. Import the module's index.ts instead. " +
                "See docs/02-system-architecture.md § 2.",
            },
          ],
        },
      ],
    },
  },

  // ── docs/01 § P2 — vendor SDKs live only in the provider adapters ───────────
  {
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: ["packages/ai/src/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "openai", message: "Vendor SDKs belong in packages/ai/src/providers/ only." },
            { name: "groq-sdk", message: "Vendor SDKs belong in packages/ai/src/providers/ only." },
            {
              name: "@google/generative-ai",
              message: "Vendor SDKs belong in packages/ai/src/providers/ only.",
            },
          ],
        },
      ],
    },
  },

  // ── packages/core is pure. No I/O, ever. That is what makes it testable. ────
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "packages/core is pure domain logic — no I/O. See docs/02 § 2." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "pg", "postgres", "@supabase/*"],
              message: "packages/core is pure domain logic — no I/O. See docs/02 § 2.",
            },
          ],
        },
      ],
    },
  },

  // Tests may be looser.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "packages/evals/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-syntax": "off",
    },
  },

  // MUST BE LAST. Root tooling configs belong to no package tsconfig, so
  // type-aware rules cannot resolve them. They are build configuration, not
  // product code — syntax linting is enough, and forcing them into a project
  // buys nothing. Placed at the end so it overrides the baseline block above;
  // earlier, the baseline would re-enable the very rules this disables.
  {
    files: ["*.js", "*.mjs", "*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
