/** Tests for apply-inline-images.ts */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyInlineImages,
  containsPath,
  extractPlaceholders,
  main,
  stripFailed,
  substitute,
} from "./apply-inline-images.js";

// ---------------------------------------------------------------------------
// extractPlaceholders
// ---------------------------------------------------------------------------

describe("extractPlaceholders", () => {
  it("returns empty array when no placeholders", () => {
    expect(extractPlaceholders("# No images here\n\nJust text.")).toEqual([]);
  });

  it("extracts a single placeholder path", () => {
    const body = "![alt](attachment://{{shots/foo.png}})";
    expect(extractPlaceholders(body)).toEqual(["shots/foo.png"]);
  });

  it("extracts multiple unique placeholder paths", () => {
    const body = [
      "![a](attachment://{{a.png}})",
      "some text",
      "![b](attachment://{{b/sub.jpg}})",
    ].join("\n");
    expect(extractPlaceholders(body)).toEqual(["a.png", "b/sub.jpg"]);
  });

  it("deduplicates repeated paths, preserving first-seen order", () => {
    const body = [
      "![first](attachment://{{dup.png}})",
      "![second](attachment://{{dup.png}})",
      "![third](attachment://{{other.png}})",
    ].join("\n");
    expect(extractPlaceholders(body)).toEqual(["dup.png", "other.png"]);
  });
});

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

describe("substitute", () => {
  it("replaces placeholder paths with attachment ids", () => {
    const body = "![x](attachment://{{shots/a.png}}) end";
    const map = new Map([["shots/a.png", "att-abc123"]]);
    expect(substitute(body, map)).toBe("![x](attachment://att-abc123) end");
  });

  it("leaves unknown paths untouched", () => {
    const body = "![x](attachment://{{unknown.png}})";
    expect(substitute(body, new Map())).toBe(body);
  });

  it("replaces all occurrences of the same path", () => {
    const body = [
      "![a](attachment://{{foo.png}})",
      "![b](attachment://{{foo.png}})",
    ].join("\n");
    const map = new Map([["foo.png", "att-xyz"]]);
    const result = substitute(body, map);
    expect(result).toBe(
      "![a](attachment://att-xyz)\n![b](attachment://att-xyz)",
    );
  });
});

// ---------------------------------------------------------------------------
// stripFailed
// ---------------------------------------------------------------------------

describe("stripFailed", () => {
  it("returns body unchanged when failedPaths is empty", () => {
    const body = "![x](attachment://{{ok.png}})";
    expect(stripFailed(body, [])).toBe(body);
  });

  it("strips lines whose path is in failedPaths", () => {
    const body = [
      "before",
      "![bad](attachment://{{bad.png}})",
      "after",
    ].join("\n");
    expect(stripFailed(body, ["bad.png"])).toBe("before\nafter");
  });

  it("leaves lines for non-failed paths intact", () => {
    const body = [
      "![good](attachment://{{good.png}})",
      "![bad](attachment://{{bad.png}})",
    ].join("\n");
    expect(stripFailed(body, ["bad.png"])).toBe(
      "![good](attachment://{{good.png}})",
    );
  });
});

// ---------------------------------------------------------------------------
// containsPath
// ---------------------------------------------------------------------------

describe("containsPath", () => {
  it("accepts a simple relative path with no root", () => {
    expect(containsPath("shots/foo.png")).toBe(true);
  });

  it("accepts a relative path with no path separators", () => {
    expect(containsPath("foo.png")).toBe(true);
  });

  it("rejects absolute paths unconditionally", () => {
    expect(containsPath("/etc/passwd")).toBe(false);
    expect(containsPath("/tmp/shots/a.png")).toBe(false);
  });

  it("rejects paths with .. segments unconditionally", () => {
    expect(containsPath("../outside.png")).toBe(false);
    expect(containsPath("shots/../../../etc/passwd")).toBe(false);
    expect(containsPath("shots/../../etc/passwd")).toBe(false);
  });

  it("rejects absolute paths even when shotsRoot is provided", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "containspath-test-"));
    expect(containsPath("/etc/passwd", tmpDir)).toBe(false);
  });

  it("rejects .. paths even when shotsRoot is provided", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "containspath-test-"));
    expect(containsPath("../sibling.png", tmpDir)).toBe(false);
    expect(containsPath("subdir/../../outside.png", tmpDir)).toBe(false);
  });

  it("accepts a path that resolves inside shotsRoot", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "containspath-test-"));
    expect(containsPath("shots/a.png", tmpDir)).toBe(true);
    expect(containsPath("a.png", tmpDir)).toBe(true);
  });

  it("rejects a path that would escape shotsRoot via normalization", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "containspath-test-"));
    // This should resolve to outside tmpDir once normalized.
    // Use a deeply nested then escaping path.
    expect(containsPath("deep/path/../../../../outside.png", tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyInlineImages (core transform)
// ---------------------------------------------------------------------------

describe("applyInlineImages -- strip mode", () => {
  it("strips all placeholder lines in strip mode", () => {
    const body = [
      "# Title",
      "![a](attachment://{{a.png}})",
      "Some text.",
      "![b](attachment://{{b.png}})",
    ].join("\n");
    const { body: out, result } = applyInlineImages(body, "strip", new Map());
    expect(out).not.toContain("attachment://");
    expect(out).toContain("# Title");
    expect(out).toContain("Some text.");
    expect(result.mode).toBe("strip");
    expect(result.substituted).toBe(0);
    expect(result.stripped).toEqual(["a.png", "b.png"]);
  });

  it("returns body unchanged (no placeholders) in strip mode", () => {
    const body = "# No images\n\nJust text.";
    const { body: out, result } = applyInlineImages(body, "strip", new Map());
    expect(out).toBe(body);
    expect(result.substituted).toBe(0);
    expect(result.stripped).toEqual([]);
  });
});

describe("applyInlineImages -- map mode", () => {
  it("substitutes all mapped paths", () => {
    const body = [
      "![a](attachment://{{shots/a.png}})",
      "![b](attachment://{{shots/b.png}})",
    ].join("\n");
    const map = new Map([
      ["shots/a.png", "uuid-aaa"],
      ["shots/b.png", "uuid-bbb"],
    ]);
    const { body: out, result } = applyInlineImages(body, "map", map);
    expect(out).toContain("attachment://uuid-aaa");
    expect(out).toContain("attachment://uuid-bbb");
    expect(out).not.toContain("{{");
    expect(result.substituted).toBe(2);
    expect(result.stripped).toEqual([]);
    expect(result.mode).toBe("map");
  });

  it("strips placeholder lines whose path is missing from the map", () => {
    const body = [
      "before",
      "![missing](attachment://{{missing.png}})",
      "after",
    ].join("\n");
    const { body: out, result } = applyInlineImages(body, "map", new Map());
    expect(out).not.toContain("attachment://");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(result.stripped).toContain("missing.png");
  });

  it("strips placeholders violating containment even when present in the map", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "apply-test-"));
    const body = "![x](attachment://{{../escape.png}})";
    const map = new Map([["../escape.png", "uuid-should-not-use"]]);
    const { body: out, result } = applyInlineImages(body, "map", map, tmpDir);
    expect(out).not.toContain("uuid-should-not-use");
    expect(out).not.toContain("attachment://");
    expect(result.stripped).toContain("../escape.png");
    expect(result.substituted).toBe(0);
  });

  it("strips absolute-path placeholders even when present in the map", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "apply-test-"));
    const body = "![x](attachment://{{/etc/passwd}})";
    const map = new Map([["/etc/passwd", "uuid-bad"]]);
    const { body: out, result } = applyInlineImages(body, "map", map, tmpDir);
    expect(out).not.toContain("uuid-bad");
    expect(result.stripped).toContain("/etc/passwd");
  });

  it("substitutes safe paths and strips unsafe paths in the same body", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "apply-test-"));
    const body = [
      "![safe](attachment://{{safe.png}})",
      "![bad](attachment://{{../bad.png}})",
    ].join("\n");
    const map = new Map([
      ["safe.png", "uuid-safe"],
      ["../bad.png", "uuid-bad"],
    ]);
    const { body: out, result } = applyInlineImages(body, "map", map, tmpDir);
    expect(out).toContain("uuid-safe");
    expect(out).not.toContain("uuid-bad");
    expect(out).not.toContain("../bad.png");
    expect(result.substituted).toBe(1);
    expect(result.stripped).toContain("../bad.png");
  });

  it("body with no placeholders returns unchanged body", () => {
    const body = "# No images\n\nJust text.";
    const { body: out, result } = applyInlineImages(body, "map", new Map());
    expect(out).toBe(body);
    expect(result.substituted).toBe(0);
    expect(result.stripped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// main (CLI integration)
// ---------------------------------------------------------------------------

describe("main (CLI integration)", () => {
  let tmpDir: string;

  // Re-create tmpDir per test group by using a helper function.
  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "apply-inline-cli-"));
  }

  it("errors when --body is missing", async () => {
    const code = await main(["--out", "/tmp/out.md", "--strip"]);
    expect(code).toBe(1);
  });

  it("errors when --out is missing", async () => {
    const code = await main(["--body", "/tmp/in.md", "--strip"]);
    expect(code).toBe(1);
  });

  it("errors when neither --map nor --strip is given", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    writeFileSync(bodyPath, "text");
    const code = await main(["--body", bodyPath, "--out", join(tmpDir, "out.md")]);
    expect(code).toBe(1);
  });

  it("errors when both --map and --strip are given", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    writeFileSync(bodyPath, "text");
    const mapPath = join(tmpDir, "map.json");
    writeFileSync(mapPath, "{}");
    const code = await main([
      "--body", bodyPath,
      "--out", join(tmpDir, "out.md"),
      "--map", mapPath,
      "--strip",
    ]);
    expect(code).toBe(1);
  });

  it("--strip mode: writes stripped body and exits 0", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const outPath  = join(tmpDir, "out.md");
    const body = "# Title\n\n![x](attachment://{{shots/x.png}})\n\nEnd.";
    writeFileSync(bodyPath, body, "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main(["--body", bodyPath, "--out", outPath, "--strip"]);

    console.log = origLog;

    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    const outBody = readFileSync(outPath, "utf-8");
    expect(outBody).not.toContain("attachment://");
    expect(outBody).toContain("# Title");

    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      substituted: number; stripped: string[]; mode: string;
    };
    expect(summary.mode).toBe("strip");
    expect(summary.substituted).toBe(0);
    expect(summary.stripped).toEqual(["shots/x.png"]);
  });

  it("--map mode: substitutes mapped paths and exits 0", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const mapPath  = join(tmpDir, "map.json");
    const outPath  = join(tmpDir, "out.md");
    const body = "![x](attachment://{{shots/x.png}})";
    writeFileSync(bodyPath, body, "utf-8");
    writeFileSync(mapPath, JSON.stringify({ "shots/x.png": "uuid-123" }), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--body", bodyPath,
      "--out", outPath,
      "--map", mapPath,
      "--shots-root", tmpDir,
    ]);

    console.log = origLog;

    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    const outBody = readFileSync(outPath, "utf-8");
    expect(outBody).toContain("attachment://uuid-123");
    expect(outBody).not.toContain("{{");

    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      substituted: number; stripped: string[]; mode: string;
    };
    expect(summary.mode).toBe("map");
    expect(summary.substituted).toBe(1);
    expect(summary.stripped).toEqual([]);
  });

  it("--map mode: missing path stripped; always writes --out (no exit 3 path)", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const mapPath  = join(tmpDir, "map.json");
    const outPath  = join(tmpDir, "out.md");
    const body = "before\n![m](attachment://{{missing.png}})\nafter";
    writeFileSync(bodyPath, body, "utf-8");
    writeFileSync(mapPath, JSON.stringify({}), "utf-8");

    const code = await main([
      "--body", bodyPath,
      "--out", outPath,
      "--map", mapPath,
    ]);

    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    const outBody = readFileSync(outPath, "utf-8");
    // Out file MUST be written even when all images are stripped.
    expect(outBody).toContain("before");
    expect(outBody).toContain("after");
    expect(outBody).not.toContain("attachment://");
  });

  it("--map mode with --shots-root: containment violation stripped and not substituted", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const mapPath  = join(tmpDir, "map.json");
    const outPath  = join(tmpDir, "out.md");
    const body = "![x](attachment://{{../escape.png}})";
    writeFileSync(bodyPath, body, "utf-8");
    writeFileSync(mapPath, JSON.stringify({ "../escape.png": "uuid-bad" }), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--body", bodyPath,
      "--out", outPath,
      "--map", mapPath,
      "--shots-root", tmpDir,
    ]);

    console.log = origLog;

    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    const outBody = readFileSync(outPath, "utf-8");
    expect(outBody).not.toContain("uuid-bad");
    expect(outBody).not.toContain("attachment://");

    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      substituted: number; stripped: string[];
    };
    expect(summary.substituted).toBe(0);
    expect(summary.stripped).toContain("../escape.png");
  });

  it("errors on non-existent body file", async () => {
    tmpDir = makeTmpDir();
    const code = await main([
      "--body", join(tmpDir, "does-not-exist.md"),
      "--out",  join(tmpDir, "out.md"),
      "--strip",
    ]);
    expect(code).toBe(1);
  });

  it("errors on invalid map JSON", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const mapPath  = join(tmpDir, "map.json");
    writeFileSync(bodyPath, "text");
    writeFileSync(mapPath, "not json");
    const code = await main([
      "--body", bodyPath,
      "--out",  join(tmpDir, "out.md"),
      "--map",  mapPath,
    ]);
    expect(code).toBe(1);
  });

  it("no placeholders in body: writes body unchanged and exits 0", async () => {
    tmpDir = makeTmpDir();
    const bodyPath = join(tmpDir, "in.md");
    const mapPath  = join(tmpDir, "map.json");
    const outPath  = join(tmpDir, "out.md");
    const body = "# No images\n\nJust text.";
    writeFileSync(bodyPath, body, "utf-8");
    writeFileSync(mapPath, JSON.stringify({}), "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--body", bodyPath,
      "--out",  outPath,
      "--map",  mapPath,
    ]);

    console.log = origLog;

    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outPath, "utf-8")).toBe(body);

    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      substituted: number; stripped: string[]; mode: string;
    };
    expect(summary.substituted).toBe(0);
    expect(summary.stripped).toEqual([]);
  });
});
