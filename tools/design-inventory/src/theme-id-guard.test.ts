/** Tests for theme-id-guard.ts */

import { describe, expect, it, vi, afterEach } from "vitest";

import { findDuplicateThemeIds, checkThemeIdUniqueness } from "./theme-id-guard.js";
import type { JsonObject } from "./design-findings-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(unitId: string, themeIds: string[]): JsonObject {
  return {
    schema_version: 1,
    unit: { id: unitId, name: unitId, type: "screen" },
    themes: themeIds.map((id) => ({ id, title: `Theme ${id}` })),
    findings: [],
    component_reuse: [],
    visual_spec: null,
  };
}

// ---------------------------------------------------------------------------
// findDuplicateThemeIds
// ---------------------------------------------------------------------------

describe("findDuplicateThemeIds", () => {
  it("returns empty array when all theme ids are unique across units", () => {
    const docs = [
      makeDoc("scr-sessions-page", ["thm-sessions-page-artifact-table", "thm-sessions-page-topbar"]),
      makeDoc("scr-branches-page", ["thm-branches-page-filters"]),
    ];
    expect(findDuplicateThemeIds(docs)).toEqual([]);
  });

  it("returns violation when two units share the same theme id", () => {
    const docs = [
      makeDoc("scr-sessions-page", ["thm-artifact-table"]),
      makeDoc("scr-branches-page", ["thm-artifact-table"]),
    ];
    const violations = findDuplicateThemeIds(docs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.themeId).toBe("thm-artifact-table");
    expect(violations[0]!.unitIds).toContain("scr-sessions-page");
    expect(violations[0]!.unitIds).toContain("scr-branches-page");
  });

  it("returns one violation per duplicated id (multiple collisions)", () => {
    const docs = [
      makeDoc("scr-a", ["thm-artifact-table", "thm-topbar"]),
      makeDoc("scr-b", ["thm-artifact-table", "thm-topbar"]),
    ];
    const violations = findDuplicateThemeIds(docs);
    expect(violations).toHaveLength(2);
    const ids = violations.map((v) => v.themeId).sort();
    expect(ids).toEqual(["thm-artifact-table", "thm-topbar"]);
  });

  it("returns empty array when only one doc has themes", () => {
    const docs = [
      makeDoc("scr-only", ["thm-artifact-table"]),
    ];
    expect(findDuplicateThemeIds(docs)).toEqual([]);
  });

  it("returns empty array when no docs have themes", () => {
    const docs = [
      makeDoc("scr-a", []),
      makeDoc("scr-b", []),
    ];
    expect(findDuplicateThemeIds(docs)).toEqual([]);
  });

  it("handles a single unit with multiple themes without violation", () => {
    const docs = [
      makeDoc("scr-x", ["thm-x-foo", "thm-x-bar"]),
    ];
    expect(findDuplicateThemeIds(docs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkThemeIdUniqueness
// ---------------------------------------------------------------------------

describe("checkThemeIdUniqueness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 and prints nothing when no violations", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const docs = [
      makeDoc("scr-sessions-page", ["thm-sessions-page-artifact-table"]),
      makeDoc("scr-branches-page", ["thm-branches-page-filter-bar"]),
    ];
    const result = checkThemeIdUniqueness(docs);
    expect(result).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 1 and prints error lines when there are violations", () => {
    const errorLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errorLines.push(String(args[0]));
    });
    const docs = [
      makeDoc("scr-sessions-page", ["thm-artifact-table"]),
      makeDoc("scr-branches-page", ["thm-artifact-table"]),
    ];
    const result = checkThemeIdUniqueness(docs);
    expect(result).toBe(1);

    // Must mention the duplicate id
    const combined = errorLines.join("\n");
    expect(combined).toContain("thm-artifact-table");
    // Must mention both unit ids
    expect(combined).toContain("scr-sessions-page");
    expect(combined).toContain("scr-branches-page");
    // Must include remediation text
    expect(combined).toContain("thm-<unit-slug>-<topic>");
    expect(combined).toContain("findings.json");
  });
});
