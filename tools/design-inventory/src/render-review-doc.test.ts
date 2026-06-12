/** Tests for render-review-doc.ts */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "./render-review-doc.js";
import { validFindings } from "./test-fixtures.js";
import type { JsonObject } from "./design-findings-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A findings doc for the fixture screen with a screenshot path and explicit
 * recommendation on the first finding, plus null theme on the second.
 */
function fixtureWithScreenshot(): JsonObject {
  const doc = validFindings();
  // Add screenshot to the first finding
  const findings = doc["findings"] as JsonObject[];
  const first = findings[0] as JsonObject;
  first["screenshot"] = "screenshots/sessions-topbar.png";
  // First finding already has a recommendation in the fixture; keep it.

  // Add screenshot to the theme
  const themes = doc["themes"] as JsonObject[];
  const theme = themes[0] as JsonObject;
  theme["screenshot"] = "screenshots/artifact-table-theme.png";
  theme["description"] = "Adopt the shared artifact-table layout across the sessions screen.";

  return doc;
}

/** A findings doc for a deprecated screen with empty findings/themes arrays. */
function deprecatedDoc(): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: "scr-legacy-page",
      name: "Legacy Page",
      type: "screen",
      classification: "deprecated-do-not-implement",
      design_sources: ["LegacyPage.jsx"],
      primary_source: "LegacyPage.jsx",
      current_impl: { status: "found", route: "/legacy", paths: ["apps/app/legacy/page.tsx"] },
      feature_flag: { required: false, flag: null, notes: "" },
    },
    themes: [],
    findings: [],
    component_reuse: [],
    visual_spec: null,
  };
}

/**
 * A minimal manifest with three units:
 *   1. scr-sessions-page  (has a findings doc)
 *   2. rgn-sidebar        (no findings doc)
 *   3. scr-legacy-page    (deprecated, has an empty-findings doc)
 */
function threeUnitManifest(): object {
  return {
    units: [
      { id: "scr-sessions-page", name: "Sessions Page", type: "screen" },
      { id: "rgn-sidebar", name: "Sidebar", type: "region" },
      { id: "scr-legacy-page", name: "Legacy Page", type: "screen" },
    ],
  };
}

interface TestEnv {
  tmpPath: string;
  findingsDir: string;
  manifestPath: string;
  outPath: string;
}

function setupEnv(): TestEnv {
  const tmpPath = mkdtempSync(join(tmpdir(), "rrd-"));
  const findingsDir = join(tmpPath, "findings");
  mkdirSync(findingsDir, { recursive: true });

  writeFileSync(
    join(findingsDir, "scr-sessions-page.json"),
    JSON.stringify(fixtureWithScreenshot()),
    "utf-8",
  );
  writeFileSync(
    join(findingsDir, "scr-legacy-page.json"),
    JSON.stringify(deprecatedDoc()),
    "utf-8",
  );

  const manifestPath = join(tmpPath, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(threeUnitManifest()), "utf-8");

  return { tmpPath, findingsDir, manifestPath, outPath: join(tmpPath, "body.md") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("render-review-doc", () => {
  it("renders without error and writes output file", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    const rc = main([
      "--findings", findingsDir,
      "--manifest", manifestPath,
      "--out", outPath,
      "--export-name", "claude_design.zip",
    ]);
    expect(rc).toBe(0);
    const text = readFileSync(outPath, "utf-8");
    expect(text.length).toBeGreaterThan(100);
  });

  it("contains H1 with export name", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath, "--export-name", "myexport"]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("# Design Review: myexport");
  });

  it("never emits numbered lists", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // Match any line that starts with a number followed by a dot (ordered list)
    expect(text).not.toMatch(/^\s*\d+\.\s/m);
  });

  it("every manifest unit appears in the Screens considered table", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("`scr-sessions-page`");
    expect(text).toContain("`rgn-sidebar`");
    expect(text).toContain("`scr-legacy-page`");
  });

  it("unit without findings doc shows 'not analyzed' in table", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // rgn-sidebar has no findings doc
    expect(text).toContain("not analyzed");
  });

  it("deprecated unit renders bold warning text and no findings content", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("**Present in the design but deprecated. MUST NOT be implemented.**");
    // The deprecated unit section should not contain a finding id
    const legacyIdx = text.indexOf("## Legacy Page");
    expect(legacyIdx).toBeGreaterThan(-1);
    // After the legacy section heading there should be no CHG- finding
    const afterLegacy = text.slice(legacyIdx, legacyIdx + 500);
    expect(afterLegacy).not.toMatch(/CHG-legacy/);
  });

  it("theme heading carries stable id as trailing inline code", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // Theme heading pattern: ### <title> `<thm-id>`
    expect(text).toContain("### Adopt shared artifact-table layout `thm-artifact-table`");
  });

  it("finding heading carries stable id as trailing inline code", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // Finding inside a theme is H4
    expect(text).toContain("#### Topbar replaces page header `CHG-sessions-page-01`");
    // Standalone finding is H3
    expect(text).toContain("### Status badge reused `CHG-sessions-page-02`");
  });

  it("screenshot placeholder uses exact attachment:// syntax", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // Theme screenshot
    expect(text).toContain("![design region](attachment://{{screenshots/artifact-table-theme.png}})");
    // Finding screenshot
    expect(text).toContain("![design region](attachment://{{screenshots/sessions-topbar.png}})");
  });

  it("recommendation derived from intent when recommendation field is absent", () => {
    const { tmpPath, manifestPath, outPath } = setupEnv();

    // Build a doc without recommendation field on finding; intent = unclear -> Discuss
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    // Remove recommendation from first finding (it has likely-intentional intent)
    delete (findings[0] as JsonObject)["recommendation"];
    // Second finding has intent=unclear and no recommendation
    const findingsDir2 = join(tmpPath, "findings2");
    mkdirSync(findingsDir2, { recursive: true });
    writeFileSync(join(findingsDir2, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");

    // Also need the deprecated doc for the third unit in the manifest
    writeFileSync(join(findingsDir2, "scr-legacy-page.json"), JSON.stringify(deprecatedDoc()), "utf-8");

    const out2 = join(tmpPath, "body2.md");
    const rc = main(["--findings", findingsDir2, "--manifest", manifestPath, "--out", out2]);
    expect(rc).toBe(0);
    const text = readFileSync(out2, "utf-8");

    // First finding: intent=likely-intentional -> Accept
    expect(text).toContain("**Recommended: Accept**");
    // Second finding: intent=unclear -> Discuss
    expect(text).toContain("**Recommended: Discuss**");
  });

  it("recommendation used verbatim when present on finding", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // CHG-sessions-page-01 has action: "accept" in the fixture
    expect(text).toContain("**Recommended: Accept** - designer note explicitly calls for the sess-topbar");
  });

  it("reuse line present when finding has reuse", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    // CHG-sessions-page-01 has new-component reuse
    expect(text).toContain("**Reuse:** NEW COMPONENT required: `ArtifactTopbar`");
    // CHG-sessions-page-02 has reuse resolution
    expect(text).toContain("**Reuse:** use `SessionStatusBadge` from `@repo/design-system/components/ui/primitives/status-badge`");
  });

  it("decline instruction line present for each finding", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("To decline this change, delete this entire section (`CHG-sessions-page-01`).");
    expect(text).toContain("To decline this change, delete this entire section (`CHG-sessions-page-02`).");
  });

  it("unit H2 heading carries unit id as trailing inline code", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("## Sessions Page `scr-sessions-page`");
    expect(text).toContain("## Legacy Page `scr-legacy-page`");
  });

  it("missing manifest unit causes exit 1", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rrd-err-"));
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });

    // Write a findings doc whose unit id is NOT in the manifest
    const doc = validFindings();
    writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");

    // Manifest with a DIFFERENT unit id
    const manifestPath = join(tmpPath, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ units: [{ id: "scr-other-page", name: "Other", type: "screen" }] }), "utf-8");

    const rc = main([
      "--findings", findingsDir,
      "--manifest", manifestPath,
      "--out", join(tmpPath, "body.md"),
    ]);
    expect(rc).toBe(1);
  });

  it("invalid findings doc causes exit 1", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rrd-bad-"));
    const doc = validFindings();
    (doc["unit"] as JsonObject)["type"] = "page"; // invalid type
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "bad.json"), JSON.stringify(doc), "utf-8");
    const manifestPath = join(tmpPath, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ units: [{ id: "scr-sessions-page", name: "x", type: "screen" }] }), "utf-8");
    const rc = main(["--findings", findingsDir, "--manifest", manifestPath, "--out", join(tmpPath, "body.md")]);
    expect(rc).toBe(1);
  });

  it("missing --manifest flag causes exit 1", () => {
    const { findingsDir, outPath } = setupEnv();
    expect(main(["--findings", findingsDir, "--out", outPath])).toBe(1);
  });

  it("intro text explains edit-to-review semantics", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("Delete any section you do not want built");
    expect(text).toContain("Edit the **What changes** line to amend scope");
    expect(text).toContain("Everything that remains becomes tickets");
  });

  it("screens considered table note is present", () => {
    const { findingsDir, manifestPath, outPath } = setupEnv();
    main(["--findings", findingsDir, "--manifest", manifestPath, "--out", outPath]);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("not part of the decision contract");
  });

  it("backend gaps section emitted when backend-gap findings exist", () => {
    const { tmpPath, manifestPath, outPath } = setupEnv();

    // Add a backend-gap finding to the sessions-page doc
    const doc = fixtureWithScreenshot();
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

    const findingsDir3 = join(tmpPath, "findings3");
    mkdirSync(findingsDir3, { recursive: true });
    writeFileSync(join(findingsDir3, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");
    writeFileSync(join(findingsDir3, "scr-legacy-page.json"), JSON.stringify(deprecatedDoc()), "utf-8");

    const rc = main(["--findings", findingsDir3, "--manifest", manifestPath, "--out", outPath]);
    expect(rc).toBe(0);
    const text = readFileSync(outPath, "utf-8");
    expect(text).toContain("## Backend gaps");
    expect(text).toContain("`CHG-sessions-page-03`");
    expect(text).toContain("informational");
  });

  it("finding with likely-unintentional intent derives Decline recommendation", () => {
    const { tmpPath, manifestPath } = setupEnv();

    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    // Modify second finding to have likely-unintentional and no recommendation
    const second = findings[1] as JsonObject;
    second["intent"] = "likely-unintentional";
    delete second["recommendation"];

    const findingsDir4 = join(tmpPath, "findings4");
    mkdirSync(findingsDir4, { recursive: true });
    writeFileSync(join(findingsDir4, "scr-sessions-page.json"), JSON.stringify(doc), "utf-8");
    writeFileSync(join(findingsDir4, "scr-legacy-page.json"), JSON.stringify(deprecatedDoc()), "utf-8");

    const out4 = join(tmpPath, "body4.md");
    const rc = main(["--findings", findingsDir4, "--manifest", manifestPath, "--out", out4]);
    expect(rc).toBe(0);
    const text = readFileSync(out4, "utf-8");
    expect(text).toContain("**Recommended: Decline**");
  });

  // ---------------------------------------------------------------------------
  // Theme id uniqueness guard tests
  // ---------------------------------------------------------------------------

  it("exits 1 with both unit ids in error when two units share the same theme id", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rrd-thm-dup-"));
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });

    // Unit A: scr-sessions-page (from fixture, has thm-artifact-table)
    const docA = validFindings();
    writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(docA), "utf-8");

    // Unit B: a second unit that also uses thm-artifact-table (same id, different unit)
    const docB: JsonObject = {
      schema_version: 1,
      unit: {
        id: "scr-branches-page",
        name: "Branches Page",
        type: "screen",
        classification: "existing-modified",
        design_sources: ["ui_kits/app/BranchesPage.jsx"],
        primary_source: "ui_kits/app/BranchesPage.jsx",
        current_impl: { status: "found", paths: [] },
        feature_flag: { required: false, flag: null, notes: "" },
      },
      // Deliberately reuses the same theme id as docA
      themes: [{ id: "thm-artifact-table", title: "Adopt artifact table layout" }],
      findings: [],
      component_reuse: [],
      visual_spec: null,
    };
    writeFileSync(join(findingsDir, "scr-branches-page.json"), JSON.stringify(docB), "utf-8");

    const manifestPath = join(tmpPath, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        units: [
          { id: "scr-sessions-page", name: "Sessions Page", type: "screen" },
          { id: "scr-branches-page", name: "Branches Page", type: "screen" },
        ],
      }),
      "utf-8",
    );

    const errorLines: string[] = [];
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => errorLines.push(String(args[0]));
    try {
      const rc = main([
        "--findings", findingsDir,
        "--manifest", manifestPath,
        "--out", join(tmpPath, "body.md"),
      ]);
      expect(rc).toBe(1);
    } finally {
      console.error = origError;
    }

    const combined = errorLines.join("\n");
    expect(combined).toContain("thm-artifact-table");
    expect(combined).toContain("scr-sessions-page");
    expect(combined).toContain("scr-branches-page");
  });

  it("exits 0 when two units use unit-scoped theme ids (no collision)", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rrd-thm-ok-"));
    const findingsDir = join(tmpPath, "findings");
    mkdirSync(findingsDir, { recursive: true });

    // Unit A: sessions page with properly scoped theme id
    const docA = validFindings();
    // Override the theme id to be unit-scoped
    (docA["themes"] as JsonObject[])[0]!["id"] = "thm-sessions-page-artifact-table";
    // Fix the finding reference too
    (docA["findings"] as JsonObject[])[0]!["theme"] = "thm-sessions-page-artifact-table";
    writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(docA), "utf-8");

    // Unit B: different unit with its own scoped theme id
    const docB: JsonObject = {
      schema_version: 1,
      unit: {
        id: "scr-branches-page",
        name: "Branches Page",
        type: "screen",
        classification: "existing-modified",
        design_sources: ["ui_kits/app/BranchesPage.jsx"],
        primary_source: "ui_kits/app/BranchesPage.jsx",
        current_impl: { status: "found", paths: [] },
        feature_flag: { required: false, flag: null, notes: "" },
      },
      themes: [{ id: "thm-branches-page-artifact-table", title: "Adopt artifact table layout" }],
      findings: [],
      component_reuse: [],
      visual_spec: null,
    };
    writeFileSync(join(findingsDir, "scr-branches-page.json"), JSON.stringify(docB), "utf-8");

    const manifestPath = join(tmpPath, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        units: [
          { id: "scr-sessions-page", name: "Sessions Page", type: "screen" },
          { id: "scr-branches-page", name: "Branches Page", type: "screen" },
        ],
      }),
      "utf-8",
    );

    const rc = main([
      "--findings", findingsDir,
      "--manifest", manifestPath,
      "--out", join(tmpPath, "body.md"),
    ]);
    expect(rc).toBe(0);
  });
});
