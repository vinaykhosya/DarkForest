import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations } from "./migrate.js";

/**
 * Loading is pure enough to test offline, and it is where the expensive mistakes
 * live: a mis-sorted migration produces a schema that is correct on every
 * database that has already run it and wrong on the next clean one.
 */

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "df-migrations-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadMigrations", () => {
  it("orders numerically, not by the order the filesystem returns", () => {
    const dir = fixture({
      "0002_second.sql": "select 2",
      "0010_tenth.sql": "select 10",
      "0001_first.sql": "select 1",
    });
    expect(loadMigrations(dir).map((m) => m.id)).toEqual([
      "0001_first",
      "0002_second",
      "0010_tenth",
    ]);
  });

  it("rejects an unpadded number rather than sorting it wrongly", () => {
    // "10_x" sorts BEFORE "2_x" as text. Accepting it would run migration 10
    // before migration 2 — on a clean database only, months later.
    const dir = fixture({ "2_two.sql": "select 2", "10_ten.sql": "select 10" });
    expect(() => loadMigrations(dir)).toThrow(/NNNN_lower_snake/);
  });

  it("rejects two migrations claiming the same number", () => {
    const dir = fixture({ "0001_a.sql": "select 1", "0001_b.sql": "select 2" });
    expect(() => loadMigrations(dir)).toThrow(/duplicate migration number/);
  });

  it("rejects capitals and spaces in a filename", () => {
    expect(() => loadMigrations(fixture({ "0001_Mixed_Case.sql": "x" }))).toThrow();
    expect(() => loadMigrations(fixture({ "0001 spaced.sql": "x" }))).toThrow();
  });

  it("ignores non-sql files, so a README beside the migrations is harmless", () => {
    const dir = fixture({ "0001_a.sql": "select 1", "README.md": "notes" });
    expect(loadMigrations(dir).map((m) => m.id)).toEqual(["0001_a"]);
  });

  it("gives the same checksum for CRLF and LF", () => {
    // This repository is developed on Windows. A checkout that normalises line
    // endings must not read as a tampered migration, which would block every
    // deploy from that machine with a message about editing applied files.
    const lf = loadMigrations(fixture({ "0001_a.sql": "select 1;\nselect 2;\n" }));
    const crlf = loadMigrations(fixture({ "0001_a.sql": "select 1;\r\nselect 2;\r\n" }));
    expect(crlf[0]?.checksum).toBe(lf[0]?.checksum);
  });

  it("gives different checksums for genuinely different content", () => {
    const a = loadMigrations(fixture({ "0001_a.sql": "select 1" }));
    const b = loadMigrations(fixture({ "0001_a.sql": "select 2" }));
    expect(a[0]?.checksum).not.toBe(b[0]?.checksum);
  });
});
