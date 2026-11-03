/** Tests for fs-walk.ts */

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { walkFiles } from "./fs-walk.js";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a fixture tree:
 *
 *   <tmp>/
 *     src/
 *       index.ts
 *       utils/
 *         helpers.ts
 *     node_modules/
 *       pkg/
 *         index.js     <- must be excluded
 *     .git/
 *       HEAD           <- must be excluded (dot dir)
 *     dangling -> /nonexistent/target  <- dangling symlink, must not throw
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fs-walk-test-"));

  // Normal nested files
  mkdirSync(join(root, "src", "utils"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "// index", "utf-8");
  writeFileSync(join(root, "src", "utils", "helpers.ts"), "// helpers", "utf-8");

  // node_modules -- should be pruned
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "// pkg", "utf-8");

  // .git -- should be pruned (dot directory)
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main", "utf-8");

  // Dangling symlink inside src/ (points to a path that does not exist)
  symlinkSync("/nonexistent/path/that/does/not/exist", join(root, "src", "dangling"));

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walkFiles", () => {
  it("returns absolute paths for normal files", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    const names = files.map((f) => basename(f));
    expect(names).toContain("index.ts");
    expect(names).toContain("helpers.ts");
  });

  it("all returned paths are absolute", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    for (const f of files) {
      expect(f.startsWith("/")).toBe(true);
    }
  });

  it("prunes node_modules at descent time", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
  });

  it("prunes .git (dot directory) at descent time", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    expect(files.every((f) => !f.includes("/.git/"))).toBe(true);
  });

  it("does not throw on a dangling symlink", () => {
    const root = makeFixture();
    expect(() => walkFiles(root)).not.toThrow();
  });

  it("does not follow the dangling symlink (target absent, no error)", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    // The dangling symlink may appear as a non-directory entry (symlink to
    // nonexistent path) -- we only care that the walk completes and does not
    // include a path inside the nonexistent target tree.
    expect(files.every((f) => !f.includes("nonexistent"))).toBe(true);
  });

  it("finds the expected set of real files", () => {
    const root = makeFixture();
    const files = walkFiles(root);
    const relToRoot = files.map((f) => f.slice(root.length + 1).replace(/\\/g, "/"));
    expect(relToRoot).toContain("src/index.ts");
    expect(relToRoot).toContain("src/utils/helpers.ts");
    // node_modules and .git are pruned -- those paths must not appear
    expect(relToRoot.every((p) => !p.includes("node_modules") && !p.includes(".git"))).toBe(true);
  });

  it("accepts custom excludeDirs", () => {
    const root = makeFixture();
    // Add a custom excluded dir
    mkdirSync(join(root, "custom-skip"), { recursive: true });
    writeFileSync(join(root, "custom-skip", "file.ts"), "// skip me", "utf-8");

    const files = walkFiles(root, { excludeDirs: new Set(["custom-skip", "node_modules"]) });
    expect(files.every((f) => !f.includes("custom-skip"))).toBe(true);
    // But node_modules is still excluded via custom set
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
  });

  it("custom excludeDirs does not auto-prune dot dirs -- dot dirs still pruned", () => {
    // Dot dir pruning is unconditional regardless of excludeDirs option
    const root = makeFixture();
    const files = walkFiles(root, { excludeDirs: new Set(["node_modules"]) });
    expect(files.every((f) => !f.includes("/.git/"))).toBe(true);
  });
});
