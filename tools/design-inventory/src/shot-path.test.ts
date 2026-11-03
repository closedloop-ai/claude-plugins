/** Tests for shot-path.ts */

import { describe, expect, it } from "vitest";

import { normalizeShotPath } from "./shot-path.js";

describe("normalizeShotPath", () => {
  it("relative paths pass through unchanged", () => {
    expect(normalizeShotPath("shots/CHG-x-01.png")).toBe("shots/CHG-x-01.png");
    expect(normalizeShotPath("screenshots/real.png")).toBe("screenshots/real.png");
    expect(normalizeShotPath("shots/CHG-x-01.png", "/workdir")).toBe("shots/CHG-x-01.png");
  });

  it("absolute path under shotsRoot is relativized to shotsRoot", () => {
    expect(normalizeShotPath("/workdir/shots/CHG-x-01.png", "/workdir")).toBe("shots/CHG-x-01.png");
    expect(
      normalizeShotPath("/a/b/run-1/shots/nested/thm-y.png", "/a/b/run-1"),
    ).toBe("shots/nested/thm-y.png");
  });

  it("absolute path outside shotsRoot falls back to the shots/ tail", () => {
    expect(normalizeShotPath("/elsewhere/shots/CHG-x-01.png", "/workdir")).toBe("shots/CHG-x-01.png");
  });

  it("absolute path with no shotsRoot falls back to the shots/ tail", () => {
    expect(normalizeShotPath("/some/run/shots/CHG-x-01.png")).toBe("shots/CHG-x-01.png");
  });

  it("returns null when absolute path has no shots segment to fall back to", () => {
    expect(normalizeShotPath("/elsewhere/captures/CHG-x-01.png", "/workdir")).toBeNull();
    expect(normalizeShotPath("/elsewhere/captures/CHG-x-01.png")).toBeNull();
  });

  it("'screenshots' segment does not count as a 'shots' segment", () => {
    // Segment matching is exact: a path under screenshots/ outside the root has
    // no shots/ tail and must be omitted rather than mangled.
    expect(normalizeShotPath("/elsewhere/screenshots/real.png", "/workdir")).toBeNull();
  });

  it("relative path with .. segments is never returned verbatim", () => {
    // ".." would be rejected by apply-inline-images; fall back to the shots tail.
    expect(normalizeShotPath("../run/shots/CHG-x-01.png")).toBe("shots/CHG-x-01.png");
    expect(normalizeShotPath("../escape/CHG-x-01.png")).toBeNull();
  });

  it("uses the LAST shots segment when several exist", () => {
    expect(normalizeShotPath("/a/shots/old/shots/CHG-x.png")).toBe("shots/CHG-x.png");
  });
});
