import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * SECRET SCAN — a real credential must never be committable again.
 *
 * Four live provider keys sat in git history for days: a Groq, OpenRouter,
 * NVIDIA and Gemini key, inside the `redactKeys` test, used to prove the
 * redactor caught real keys. That is the exact leak the function exists to
 * prevent, committed inside its own test, and it was found by chance while
 * preparing the first push rather than by anything that would have caught it.
 *
 * A rule nothing enforces is a rule that gets broken, so this runs in
 * `pnpm check` on every commit.
 *
 * WHY SHAPE-BASED AND NOT A DENYLIST: a denylist only catches keys someone
 * already knew to add. This flags anything shaped like a credential and requires
 * it to be visibly synthetic, so the next provider's format is covered before
 * anyone thinks about it.
 */

/** The formats we actually use. Mirrors redactKeys in packages/ai/src/credentials.ts. */
const CREDENTIAL_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Groq", pattern: /gsk_[A-Za-z0-9]{20,}/g },
  { name: "OpenRouter", pattern: /sk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: "NVIDIA", pattern: /nvapi-[A-Za-z0-9_-]{20,}/g },
  { name: "Gemini", pattern: /AIza[A-Za-z0-9_-]{20,}/g },
  { name: "Cloudflare", pattern: /cf(?:at|ut)_[A-Za-z0-9]{20,}/g },
  { name: "Tavily", pattern: /tvly-[A-Za-z0-9]{16,}/g },
  { name: "GitHub PAT", pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "GitHub fine-grained", pattern: /github_pat_[A-Za-z0-9_]{40,}/g },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
];

/**
 * A match is allowed only if it is OBVIOUSLY not a working key.
 *
 * Two ways to qualify: say so in the value itself, or be a run of one repeated
 * character. Anything with real entropy fails, which is the point — the leaked
 * keys looked exactly like keys, because they were.
 */
function isVisiblySynthetic(match: string): boolean {
  if (/example|placeholder|notareal|fake|dummy|xxxx|redacted/i.test(match)) return true;
  /*
   * A run of eight identical characters ANYWHERE, not anchored after a stripped
   * prefix. The anchored version missed "sk-or-v1-dddddd…" and "AIzaeeeee…"
   * because the prefixes it stripped were not the prefixes those keys have — a
   * guard that only recognises the shapes its author happened to think of.
   */
  return /(.)\1{7,}/.test(match);
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".pnpm-store", "coverage", "runs"]);
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".example", ".sql"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SCAN_EXT.has(extname(entry))) out.push(path);
  }
  return out;
}

describe("no real credential may be committed", () => {
  it("finds nothing credential-shaped that is not visibly synthetic", () => {
    // Repo root from packages/evals/src/contract.
    const root = join(__dirname, "..", "..", "..", "..");
    const findings: string[] = [];

    for (const file of sourceFiles(root)) {
      // .env is gitignored; .env.example is not, and must stay placeholder-only.
      const body = readFileSync(file, "utf8");
      for (const { name, pattern } of CREDENTIAL_SHAPES) {
        for (const match of body.match(pattern) ?? []) {
          if (isVisiblySynthetic(match)) continue;
          // Never print the value — that would put it in CI logs.
          findings.push(
            `${file.slice(root.length + 1)}: ${name}-shaped value, ` +
              `${String(match.length)} chars, starting "${match.slice(0, 8)}…"`,
          );
        }
      }
    }

    expect(findings, `Credential-shaped values found:\n${findings.join("\n")}`).toEqual([]);
  });

  it("recognises the synthetic forms the tests actually use", () => {
    // Guard against the guard: if these stopped counting as synthetic, the scan
    // would fail on its own fixtures and get disabled, which is worse than
    // having no scan at all.
    for (const ok of [
      "gsk_EXAMPLEONLYnotarealkey00000000000000",
      "sk-or-v1-EXAMPLEONLYnotarealkey0000000000000000",
      "gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "AIzaEXAMPLEONLYnotarealkey0000000000",
    ]) {
      expect(isVisiblySynthetic(ok), ok).toBe(true);
    }
  });

  it("treats a high-entropy body as NOT synthetic", () => {
    /*
     * Invented strings. Never a real credential, and never a real one masked.
     *
     * The first version of this test built its examples by masking four
     * characters of the ACTUAL GitHub token, so the source literal was the real
     * token and only the runtime value was safe. Same mistake as using live keys
     * in the redaction test, made an hour after fixing that one, inside the file
     * written to prevent it. Which is the argument for an automated guard rather
     * than for being careful.
     */
    /*
     * Assembled from parts so no credential-shaped LITERAL exists in this file.
     *
     * Written whole, these tripped the scan on its own source — correctly, since
     * they are indistinguishable from real keys, which is the property being
     * asserted. Exempting this file was the other option and the wrong one: the
     * scanner's own source is the likeliest place for someone to paste a real
     * key while testing the scanner.
     */
    const join = (prefix: string, body: string): string => prefix + body;
    for (const bad of [
      join("gsk", "_zqNmT4rvBHkeWdLpYxCgAtJfRoSuMi6291"),
      join("nvapi", "-Kd7wQzBnHxTvLmRpYeCaUgFj4S2801"),
      join("ghp", "_Wq3ZmKfTbRnYxLcVdHgAeJuPo52471NsIkQ"),
    ]) {
      expect(isVisiblySynthetic(bad), bad.slice(0, 10)).toBe(false);
    }
  });
});
