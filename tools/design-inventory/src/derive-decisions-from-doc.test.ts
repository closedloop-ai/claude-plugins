/**
 * Tests for derive-decisions-from-doc.ts (PLN-859 P4a).
 *
 * Integration tests build a real review body by invoking render-review-doc's
 * main() with fixture findings + a minimal manifest, then exercise the
 * decision derivation logic against that body.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main as renderMain } from "./render-review-doc.js";
import { main as deriveMain, extractSurvivingIds, sectionFor, deriveDecisions } from "./derive-decisions-from-doc.js";
import { validFindings } from "./test-fixtures.js";
import type { JsonObject } from "./design-findings-schema.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** A minimal manifest wrapping the sessions-page fixture unit. */
function minimalManifest(): object {
  return {
    units: [{ id: "scr-sessions-page", name: "Sessions Page", type: "screen" }],
  };
}

interface TestEnv {
  tmpPath: string;
  findingsDir: string;
  manifestPath: string;
  bodyPath: string;
  outPath: string;
  doc: JsonObject;
}

/**
 * Set up a temp directory with a single findings doc (validFindings()), a
 * minimal manifest, and a rendered review body.
 * Returns paths and the findings document.
 */
function setupEnv(overrideDoc?: Partial<JsonObject>): TestEnv {
  const tmpPath = mkdtempSync(join(tmpdir(), "ddd-"));
  const findingsDir = join(tmpPath, "findings");
  mkdirSync(findingsDir, { recursive: true });

  const doc = { ...validFindings(), ...overrideDoc };
  writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");

  const manifestPath = join(tmpPath, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(minimalManifest()), "utf-8");

  const bodyPath = join(tmpPath, "body.md");
  const rc = renderMain([
    "--findings", findingsDir,
    "--manifest", manifestPath,
    "--out", bodyPath,
  ]);
  if (rc !== 0) throw new Error("renderMain failed in setupEnv");

  return {
    tmpPath,
    findingsDir,
    manifestPath,
    bodyPath,
    outPath: join(tmpPath, "decisions.json"),
    doc,
  };
}

// ---------------------------------------------------------------------------
// Helper unit tests: extractSurvivingIds
// ---------------------------------------------------------------------------

describe("extractSurvivingIds", () => {
  it("extracts FINDING_ID and THEME_ID from heading lines", () => {
    const body = [
      "# Top level heading",
      "## Sessions Page `scr-sessions-page`",
      "### My Theme `thm-artifact-table`",
      "#### Topbar replaces header `CHG-sessions-page-01`",
      "### Standalone finding `CHG-sessions-page-02`",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    // unit ids (scr-) are not FINDING_ID or THEME_ID so should be excluded
    expect(ids.has("scr-sessions-page")).toBe(false);
    expect(ids.has("thm-artifact-table")).toBe(true);
    expect(ids.has("CHG-sessions-page-01")).toBe(true);
    expect(ids.has("CHG-sessions-page-02")).toBe(true);
  });

  it("ignores ids in table rows", () => {
    const body = [
      "## Screens considered",
      "| ID | Name |",
      "|---|---|",
      "| `scr-sessions-page` | Sessions Page |",
      "| `CHG-sessions-page-01` | Some finding |",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.has("CHG-sessions-page-01")).toBe(false);
  });

  it("ignores ids in bullet lines", () => {
    const body = [
      "## Some section",
      "- `CHG-sessions-page-01` Backend ticket for sessions stream endpoint (Sessions Page)",
      "- To decline this change, delete this entire section (`CHG-sessions-page-02`).",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.has("CHG-sessions-page-01")).toBe(false);
    expect(ids.has("CHG-sessions-page-02")).toBe(false);
  });

  it("ignores ids in the Backend gaps rollup bullets", () => {
    const body = [
      "## Backend gaps",
      "",
      "These are informational. The per-screen sections above remain the decision surface.",
      "",
      "- `CHG-sessions-page-03` Backend ticket for sessions stream endpoint (Sessions Page)",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.has("CHG-sessions-page-03")).toBe(false);
  });

  it("does not match ids in H1 lines (only H2-H4)", () => {
    const body = [
      "# Design Review `CHG-sessions-page-99`",
      "## Real section `CHG-sessions-page-01`",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.has("CHG-sessions-page-99")).toBe(false);
    expect(ids.has("CHG-sessions-page-01")).toBe(true);
  });

  it("does not match H5+ lines", () => {
    const body = [
      "##### Deep heading `CHG-sessions-page-01`",
      "## Good section `CHG-sessions-page-02`",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.has("CHG-sessions-page-01")).toBe(false);
    expect(ids.has("CHG-sessions-page-02")).toBe(true);
  });

  it("returns empty set for body with no heading ids", () => {
    const body = [
      "## Screens considered",
      "| `scr-sessions-page` | Sessions Page | screen | existing-modified |",
      "- Some bullet point",
    ].join("\n");
    const ids = extractSurvivingIds(body);
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helper unit tests: sectionFor
// ---------------------------------------------------------------------------

describe("sectionFor", () => {
  it("returns null when id not found on any heading", () => {
    const body = [
      "## Some section",
      "Content here",
    ].join("\n");
    expect(sectionFor(body, "CHG-sessions-page-01")).toBeNull();
  });

  it("returns the section from heading until next same-level heading", () => {
    const body = [
      "## Unit section `scr-sessions-page`",
      "Some content",
      "### Theme `thm-artifact-table`",
      "Theme content",
      "#### Finding one `CHG-sessions-page-01`",
      "- **What changes:** Replace page header with sticky topbar",
      "#### Finding two `CHG-sessions-page-02`",
      "- **What changes:** Use existing badge",
      "## Next unit",
      "Other content",
    ].join("\n");

    const section = sectionFor(body, "CHG-sessions-page-01");
    expect(section).not.toBeNull();
    expect(section).toContain("#### Finding one `CHG-sessions-page-01`");
    expect(section).toContain("Replace page header with sticky topbar");
    // Should not include the next H4 section
    expect(section).not.toContain("CHG-sessions-page-02");
    expect(section).not.toContain("Next unit");
  });

  it("theme section includes its member findings", () => {
    const body = [
      "### Theme `thm-artifact-table`",
      "Theme description",
      "#### Finding one `CHG-sessions-page-01`",
      "- **What changes:** Replace page header",
      "### Standalone `CHG-sessions-page-02`",
      "- **What changes:** Use badge",
    ].join("\n");

    const section = sectionFor(body, "thm-artifact-table");
    expect(section).toContain("thm-artifact-table");
    expect(section).toContain("CHG-sessions-page-01");
    expect(section).not.toContain("CHG-sessions-page-02");
  });

  it("id in table row does not match as heading", () => {
    const body = [
      "## Screens considered",
      "| `CHG-sessions-page-01` | some finding |",
      "## Real section `CHG-sessions-page-02`",
      "content",
    ].join("\n");
    // The id in the table row should not be found as a heading
    expect(sectionFor(body, "CHG-sessions-page-01")).toBeNull();
    expect(sectionFor(body, "CHG-sessions-page-02")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests using real rendered bodies
// ---------------------------------------------------------------------------

describe("integration: untouched body -> all accepted", () => {
  it("all themes and findings are accepted when body is unmodified", () => {
    const { findingsDir, bodyPath } = setupEnv();
    const body = readFileSync(bodyPath, "utf-8");
    const doc = validFindings();
    const output = deriveDecisions([doc], body, "tester@example.com", "2026-06-12T00:00:00Z");

    const decisions = output["decisions"] as Record<string, JsonObject>;

    // Theme from validFindings
    expect(decisions["thm-artifact-table"]).toEqual({ state: "accepted" });
    // Both findings from validFindings
    expect(decisions["CHG-sessions-page-01"]).toEqual({ state: "accepted" });
    expect(decisions["CHG-sessions-page-02"]).toEqual({ state: "accepted" });

    // All entries are accepted
    for (const [key, val] of Object.entries(decisions)) {
      expect(val["state"], `decision for ${key}`).toBe("accepted");
    }

    // findingsDir arg not actually used in deriveDecisions but verify counts
    expect(Object.keys(decisions)).toHaveLength(3); // 1 theme + 2 findings
    void findingsDir;
  });
});

describe("integration: delete theme block -> theme and members declined", () => {
  it("deleting the entire H3 theme block declines theme and its member findings", () => {
    const { bodyPath } = setupEnv();
    let body = readFileSync(bodyPath, "utf-8");

    // Find the theme H3 and remove it plus everything until the next H3 or H2
    // Theme: "### Adopt shared artifact-table layout `thm-artifact-table`"
    // Its member is CHG-sessions-page-01 (H4)
    // The standalone finding CHG-sessions-page-02 is H3

    // Identify boundaries
    const lines = body.split("\n");
    let themeStart = -1;
    let themeEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^###\s.*`thm-artifact-table`/.test(line)) {
        themeStart = i;
        continue;
      }
      if (themeStart !== -1 && i > themeStart) {
        // Next H3 or H2 or H1 closes the block
        if (/^#{2,3}\s/.test(line)) {
          themeEnd = i;
          break;
        }
      }
    }
    expect(themeStart).toBeGreaterThan(-1);

    // Delete the theme block (from themeStart up to but not including themeEnd)
    const trimmed = [...lines.slice(0, themeStart), ...lines.slice(themeEnd)];
    body = trimmed.join("\n");

    const doc = validFindings();
    const output = deriveDecisions([doc], body, "tester@example.com", "2026-06-12T00:00:00Z");
    const decisions = output["decisions"] as Record<string, JsonObject>;

    // Theme declined
    expect(decisions["thm-artifact-table"]).toEqual({ state: "declined" });
    // Member finding declined (its H4 heading was inside the deleted block)
    expect(decisions["CHG-sessions-page-01"]).toEqual({ state: "declined" });
    // Standalone finding (H3) is still present and accepted
    expect(decisions["CHG-sessions-page-02"]).toEqual({ state: "accepted" });
  });
});

describe("integration: edit What changes text -> edited state", () => {
  it("editing a surviving finding's What changes text yields edited state", () => {
    const { bodyPath } = setupEnv();
    let body = readFileSync(bodyPath, "utf-8");

    const originalSummary = "Replace page header with sticky topbar";
    const editedSummary = "Replace page header with a collapsible topbar (reduced height)";

    // Edit the What changes line for CHG-sessions-page-01
    body = body.replace(
      `- **What changes:** ${originalSummary}`,
      `- **What changes:** ${editedSummary}`,
    );
    // Ensure we actually edited something
    expect(body).toContain(editedSummary);

    const doc = validFindings();
    const output = deriveDecisions([doc], body, "tester@example.com", "2026-06-12T00:00:00Z");
    const decisions = output["decisions"] as Record<string, JsonObject>;

    expect(decisions["CHG-sessions-page-01"]).toEqual({
      state: "edited",
      edited_summary: editedSummary,
    });
    // Unchanged finding still accepted
    expect(decisions["CHG-sessions-page-02"]).toEqual({ state: "accepted" });
  });
});

describe("integration: id in backend gaps rollup only -> still declined", () => {
  it("a finding whose section was deleted but id remains in Backend gaps rollup is declined", () => {
    // Build a doc with a backend-gap finding so the Backend gaps rollup is rendered
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "Missing sessions endpoint",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "new endpoint required",
      theme: null,
      state: { summary: "no endpoint", refs: [] },
      spec: { summary: "GET /sessions stream", refs: [] },
      reuse: null,
      decision: { state: "pending" },
      summary: "Backend ticket for sessions stream endpoint",
    });

    const tmpPath = mkdtempSync(join(tmpdir(), "ddd-bg-"));
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");

    const manifestPath = join(tmpPath, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(minimalManifest()), "utf-8");

    const bodyPath = join(tmpPath, "body.md");
    renderMain(["--findings", findingsDir, "--manifest", manifestPath, "--out", bodyPath]);

    let body = readFileSync(bodyPath, "utf-8");

    // Verify the Backend gaps rollup contains the finding id
    expect(body).toContain("`CHG-sessions-page-03`");
    // Verify the id appears in a bullet line in Backend gaps (not a heading)
    const hasInBullet = body.split("\n").some((line) =>
      !line.startsWith("#") && line.includes("`CHG-sessions-page-03`"),
    );
    expect(hasInBullet).toBe(true);

    // Delete the H3 section for CHG-sessions-page-03 (the finding's own heading)
    const lines = body.split("\n");
    let sectStart = -1;
    let sectEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^###\s.*`CHG-sessions-page-03`/.test(line)) {
        sectStart = i;
        continue;
      }
      if (sectStart !== -1 && i > sectStart) {
        if (/^#{2,3}\s/.test(line)) {
          sectEnd = i;
          break;
        }
      }
    }
    expect(sectStart).toBeGreaterThan(-1);

    const trimmed = [...lines.slice(0, sectStart), ...lines.slice(sectEnd)];
    body = trimmed.join("\n");

    // The id still appears in Backend gaps rollup bullet but NOT on a heading
    expect(body).toContain("`CHG-sessions-page-03`");
    const stillInHeading = body
      .split("\n")
      .some((line) => /^#{2,4}\s/.test(line) && line.includes("`CHG-sessions-page-03`"));
    expect(stillInHeading).toBe(false);

    const output = deriveDecisions([doc], body, "tester@example.com", "2026-06-12T00:00:00Z");
    const decisions = output["decisions"] as Record<string, JsonObject>;

    // Must be declined even though id appears in the rollup
    expect(decisions["CHG-sessions-page-03"]).toEqual({ state: "declined" });
  });
});

// ---------------------------------------------------------------------------
// CLI main() integration tests
// ---------------------------------------------------------------------------

describe("CLI main()", () => {
  it("exit 0 and writes valid decisions.json from unmodified body", () => {
    const { findingsDir, bodyPath, outPath } = setupEnv();
    const rc = deriveMain([
      "--doc", bodyPath,
      "--findings", findingsDir,
      "--out", outPath,
      "--reviewer", "tester@example.com",
    ]);
    expect(rc).toBe(0);

    const raw = readFileSync(outPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({
      schema_version: 1,
      reviewer: "tester@example.com",
    });
    const decisions = (parsed as JsonObject)["decisions"] as Record<string, JsonObject>;
    expect(decisions["thm-artifact-table"]?.["state"]).toBe("accepted");
    expect(decisions["CHG-sessions-page-01"]?.["state"]).toBe("accepted");
    expect(decisions["CHG-sessions-page-02"]?.["state"]).toBe("accepted");
  });

  it("exit 1 when --doc is missing", () => {
    const { findingsDir, outPath } = setupEnv();
    const rc = deriveMain([
      "--findings", findingsDir,
      "--out", outPath,
      "--reviewer", "tester@example.com",
    ]);
    expect(rc).toBe(1);
  });

  it("exit 1 when --findings is missing", () => {
    const { bodyPath, outPath } = setupEnv();
    const rc = deriveMain([
      "--doc", bodyPath,
      "--out", outPath,
      "--reviewer", "tester@example.com",
    ]);
    expect(rc).toBe(1);
  });

  it("exit 1 when --out is missing", () => {
    const { findingsDir, bodyPath } = setupEnv();
    const rc = deriveMain([
      "--doc", bodyPath,
      "--findings", findingsDir,
      "--reviewer", "tester@example.com",
    ]);
    expect(rc).toBe(1);
  });

  it("exit 1 when --reviewer is missing", () => {
    const { findingsDir, bodyPath, outPath } = setupEnv();
    const rc = deriveMain([
      "--doc", bodyPath,
      "--findings", findingsDir,
      "--out", outPath,
    ]);
    expect(rc).toBe(1);
  });

  it("exit 1 when findings doc is invalid", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "ddd-bad-"));
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });
    const bad = validFindings();
    (bad["unit"] as JsonObject)["type"] = "invalid-type";
    writeFileSync(join(findingsDir, "bad.json"), JSON.stringify(bad), "utf-8");

    // Need a body file too
    const bodyPath = join(tmpPath, "body.md");
    writeFileSync(bodyPath, "## Some heading `thm-foo`\n", "utf-8");
    const outPath = join(tmpPath, "decisions.json");

    const rc = deriveMain([
      "--doc", bodyPath,
      "--findings", findingsDir,
      "--out", outPath,
      "--reviewer", "tester@example.com",
    ]);
    expect(rc).toBe(1);
  });

  it("skips findings docs that have a top-level decisions key", () => {
    const { findingsDir, bodyPath, outPath } = setupEnv();

    // Write a decisions.json next to the findings (should be skipped)
    writeFileSync(
      join(findingsDir, "decisions.json"),
      JSON.stringify({ schema_version: 1, decisions: {}, reviewer: "x", decided_at: "x" }),
      "utf-8",
    );

    const rc = deriveMain([
      "--doc", bodyPath,
      "--findings", findingsDir,
      "--out", outPath,
      "--reviewer", "tester@example.com",
    ]);
    // Should still succeed (decisions doc is silently skipped)
    expect(rc).toBe(0);
  });
});
