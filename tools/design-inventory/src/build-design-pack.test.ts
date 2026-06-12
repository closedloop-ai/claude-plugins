/** Tests for build-design-pack.ts */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main, validateManifestPath } from "./build-design-pack.js";
import { applyInlineImages } from "./apply-inline-images.js";
import { validDecisions, validFindings } from "./test-fixtures.js";
import type { JsonObject } from "./design-findings-schema.js";

function makeExtractDir(tmpPath: string): string {
  const extractDir = join(tmpPath, "extracted");
  mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
  writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), "jsx", "utf-8");
  writeFileSync(join(extractDir, "SessionsPage.jsx"), "old jsx", "utf-8");
  mkdirSync(join(extractDir, "screenshots"), { recursive: true });
  writeFileSync(join(extractDir, "screenshots/real-sessions.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x20, 0x66, 0x61, 0x6b, 0x65]));
  return extractDir;
}

function runPack(
  tmpPath: string,
  decisions: JsonObject,
  visualSpec?: JsonObject,
): { rc: number; pack: string } {
  const extractDir = makeExtractDir(tmpPath);
  const findingsPath = join(tmpPath, "unit.json");
  writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
  const decisionsPath = join(tmpPath, "decisions.json");
  writeFileSync(decisionsPath, JSON.stringify(decisions), "utf-8");
  const outDir = join(tmpPath, "packs");
  const argv = [
    "--findings", findingsPath,
    "--decisions", decisionsPath,
    "--extract-dir", extractDir,
    "--out-dir", outDir,
  ];
  if (visualSpec !== undefined) {
    const specPath = join(tmpPath, "visual-spec.json");
    writeFileSync(specPath, JSON.stringify(visualSpec), "utf-8");
    argv.push("--visual-spec", specPath);
  }
  const rc = main(argv);
  return { rc, pack: join(outDir, "scr-sessions-page") };
}

describe("build-design-pack", () => {
  it("UI body is self-contained: embeds design source, no 'attached pack' wording", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-selfcontained-"));
    const cssPath = join(tmpPath, "slice.css");
    writeFileSync(cssPath, ".sd { color: red }", "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
      "--css-slice", cssPath,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");
    // The ticket embeds the design source so it is implementable from the ticket alone.
    expect(uiBody).toContain("## Design Source (embedded)");
    expect(uiBody).toContain("### `ui_kits/app/SessionsPage.jsx`");
    expect(uiBody).toContain("old jsx"); // actual source content embedded, not just a fence label
    expect(uiBody).toContain("### Sliced CSS (`design-slice.css`)");
    expect(uiBody).toContain(".sd { color: red }");
    // Four-backtick fences guard against in-source code fences breaking out.
    expect(uiBody).toContain("````jsx");
    expect(uiBody).toContain("````css");
    // It must never point at an artifact the skill guarantees never to deliver.
    expect(uiBody).not.toContain("attached design pack");
    expect(uiBody).not.toContain("attached design source");
  });

  it("pack structure and ticket body", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const visual: JsonObject = {
      colors: {
        resolved: [{ value: "#112233", token: "--primary", count: 3 }],
        drift: [{ value: "#e74c3c", count: 1, nearest_token: "--destructive", distance: 1.0 }],
      },
      icons: ["hand"],
      layout: { sticky: 1, flex: 2, utility_classes: ["sticky"] },
      state_styles: { hover: [".x:hover"] },
      spacing: { padding: ["8px 14px"] },
      typography: { "font-size": ["12px"] },
    };
    const { rc, pack } = runPack(tmpPath, validDecisions(), visual);
    expect(rc).toBe(0);
    // Source files land at their relative path under design-source/
    expect(existsSync(join(pack, "design-source/ui_kits/app/SessionsPage.jsx"))).toBe(true);
    expect(existsSync(join(pack, "design-source/SessionsPage.jsx"))).toBe(true);
    // Screenshots land at their relative path under screenshots/
    expect(existsSync(join(pack, "screenshots/screenshots/real-sessions.png"))).toBe(true);
    expect(existsSync(join(pack, "visual-spec.json"))).toBe(true);

    const resolved = JSON.parse(readFileSync(join(pack, "findings.json"), "utf-8")) as JsonObject;
    const states: Record<string, string> = {};
    for (const f of resolved["findings"] as JsonObject[]) {
      states[String(f["id"])] = String((f["decision"] as JsonObject)["state"]);
    }
    expect(states).toEqual({
      "CHG-sessions-page-01": "accepted", // via accepted theme
      "CHG-sessions-page-02": "declined", // explicit decline
    });

    // UI body exists and has the right content
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    expect(uiBody).toContain("# Implement Sessions Page from approved design");
    const afterCriteria = uiBody.split("## Acceptance Criteria")[1]!.split("##")[0]!;
    expect(afterCriteria).toContain("(CHG-sessions-page-01)");
    expect(uiBody).toContain("## Declined Changes — DO NOT IMPLEMENT");
    const afterDeclined = uiBody.split("Declined Changes")[1]!;
    expect(afterDeclined).toContain("CHG-sessions-page-02");
    expect(uiBody).toContain("| `#112233` | `--primary` |");
    expect(uiBody).toContain("`--destructive` (d=1.0)");
    expect(uiBody).toContain("Design-system ticket required: build `ArtifactTopbar`");
    expect(uiBody).toContain("Icons (lucide names): hand");
  });

  it("edited decision overrides summary", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const decisions = validDecisions();
    (decisions["decisions"] as JsonObject)["CHG-sessions-page-01"] = {
      state: "edited",
      edited_summary: "Topbar yes, but keep the existing Card wrapper",
    };
    const { rc, pack } = runPack(tmpPath, decisions);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    expect(uiBody).toContain("Topbar yes, but keep the existing Card wrapper");
  });

  it("nothing accepted writes no pack", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const decisions = validDecisions();
    (decisions as JsonObject)["decisions"] = {
      "thm-artifact-table": { state: "declined" },
      "CHG-sessions-page-02": { state: "declined" },
    };
    const { rc, pack } = runPack(tmpPath, decisions);
    expect(rc).toBe(3);
    expect(existsSync(pack)).toBe(false);
  });

  it("invalid inputs return 1", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const extractDir = makeExtractDir(tmpPath);
    const findingsPath = join(tmpPath, "unit.json");
    const doc = validFindings();
    (doc["unit"] as JsonObject)["type"] = "page";
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", join(tmpPath, "packs"),
    ]);
    expect(rc).toBe(1);
  });

  it("UI body uses bullet criteria (no numbered list)", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const { rc, pack } = runPack(tmpPath, validDecisions());
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    // No numbered list lines like "1. ..." in acceptance criteria
    const criteriaSection = uiBody.split("## Acceptance Criteria")[1]!.split("##")[0]!;
    expect(/^\d+\. /m.test(criteriaSection)).toBe(false);
    // But bullet lines exist
    expect(/^- /m.test(criteriaSection)).toBe(true);
  });

  it("UI body does not contain backend-gap criterion", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    // Add a backend-gap finding that gets accepted
    const findingsPath = join(tmpPath, "unit.json");
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint", refs: [] },
      spec: { summary: "POST /api/sessions", refs: [] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    // Backend-gap finding id must not appear in UI body criteria
    expect(uiBody).not.toContain("CHG-sessions-page-03");
    // UI body must not contain the backend-gap criterion text
    expect(uiBody).not.toContain("POST /api/sessions");
  });

  it("API body created when accepted backend-gap findings exist", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const findingsPath = join(tmpPath, "unit.json");
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint exists", refs: [] },
      spec: { summary: "POST /api/sessions", refs: [] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    const pack = join(outDir, "scr-sessions-page");
    expect(existsSync(join(pack, "ticket-body-api.md"))).toBe(true);
    const apiBody = readFileSync(join(pack, "ticket-body-api.md"), "utf-8");
    expect(apiBody).toContain("# Backend for Sessions Page");
    expect(apiBody).toContain("CHG-sessions-page-03");
    expect(apiBody).toContain("POST /api/sessions");
    expect(apiBody).toContain("No endpoint exists");
  });

  it("API body NOT created when no accepted backend-gap findings", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const { rc, pack } = runPack(tmpPath, validDecisions());
    expect(rc).toBe(0);
    // validFindings has no backend-gap findings
    expect(existsSync(join(pack, "ticket-body-api.md"))).toBe(false);
  });

  it("neither body contains .closedloop-ai/design-packs path", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const { rc, pack } = runPack(tmpPath, validDecisions());
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    expect(uiBody).not.toContain(".closedloop-ai/design-packs");
    expect(uiBody).not.toContain("commit");
  });

  it("API body criteria list does not contain non-backend-gap findings", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const findingsPath = join(tmpPath, "unit.json");
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint", refs: [] },
      spec: { summary: "POST /api/sessions", refs: [] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    const pack = join(outDir, "scr-sessions-page");
    const apiBody = readFileSync(join(pack, "ticket-body-api.md"), "utf-8");
    // Non-backend-gap finding id must not appear in API body criteria
    expect(apiBody).not.toContain("CHG-sessions-page-01");
  });

  it("UI body contains Provenance section (no repo paths)", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const { rc, pack } = runPack(tmpPath, validDecisions());
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    expect(uiBody).toContain("## Provenance");
    expect(uiBody).toContain("design-inventory Stage C");
    expect(uiBody).toContain("this ticket is self-contained");
    expect(uiBody).toContain("regenerable convenience, not a dependency");
    // Old Design Pack section should not be present
    expect(uiBody).not.toContain("## Design Pack");
  });

  it("export-zip-name appears in Provenance section", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const extractDir = makeExtractDir(tmpPath);
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
      "--export-zip-name", "my-design-export-v3.zip",
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    expect(uiBody).toContain("my-design-export-v3.zip");
  });

  it("collision: two design_sources with identical basenames land at distinct nested paths", () => {
    // Both ui_kits/app/index.jsx and ui_kits/admin/index.jsx share basename "index.jsx".
    // The old basename-only copy would let the second clobber the first.
    // The fix preserves directory structure so both survive.
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    mkdirSync(join(extractDir, "ui_kits/admin"), { recursive: true });
    writeFileSync(join(extractDir, "ui_kits/app/index.jsx"), "app content", "utf-8");
    writeFileSync(join(extractDir, "ui_kits/admin/index.jsx"), "admin content", "utf-8");

    const doc = validFindings();
    (doc["unit"] as JsonObject)["design_sources"] = [
      "ui_kits/app/index.jsx",
      "ui_kits/admin/index.jsx",
    ];
    (doc["unit"] as JsonObject)["primary_source"] = "ui_kits/app/index.jsx";

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    // Both files must be present at their source-relative paths
    expect(readFileSync(join(pack, "design-source/ui_kits/app/index.jsx"), "utf-8")).toBe("app content");
    expect(readFileSync(join(pack, "design-source/ui_kits/admin/index.jsx"), "utf-8")).toBe("admin content");
  });

  it("pending findings appear in Undecided section and summary JSON, not in criteria", () => {
    // validDecisions accepts thm-artifact-table (covers CHG-sessions-page-01) and
    // declines CHG-sessions-page-02. Both findings start pending; theme acceptance
    // resolves -01 to accepted. -02 is explicitly declined.
    // Add a third finding with no decision (truly pending).
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-"));
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "Color tweak",
      category: "visual",
      intent: "unclear",
      intent_rationale: "not sure",
      theme: null,
      state: { summary: "Uses old brand color", refs: [] },
      spec: { summary: "Uses new brand token", refs: [] },
      decision: { state: "pending" },
      summary: "Update brand color token",
    });

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    const logOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    logSpy.mockRestore();

    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");

    // Pending finding must appear in Undecided section
    expect(uiBody).toContain("## Undecided Findings");
    expect(uiBody).toContain("CHG-sessions-page-03");
    expect(uiBody).toContain("Update brand color token");

    // Pending finding must NOT appear in Acceptance Criteria
    const criteriaSection = uiBody.split("## Acceptance Criteria")[1]!.split("##")[0]!;
    expect(criteriaSection).not.toContain("CHG-sessions-page-03");

    // Summary JSON must include pending count and ids
    const summary = JSON.parse(logOutput) as { pending: number; pending_ids: string[] };
    expect(summary["pending"]).toBe(1);
    expect(summary["pending_ids"]).toEqual(["CHG-sessions-page-03"]);
  });

  // -------------------------------------------------------------------------
  // Finding A: path-traversal validator (unit tests for the exported function)
  // -------------------------------------------------------------------------
  describe("validateManifestPath", () => {
    it("accepts normal relative paths", () => {
      expect(validateManifestPath("ui_kits/app/SessionsPage.jsx")).toBe(true);
      expect(validateManifestPath("screenshots/real-sessions.png")).toBe(true);
      expect(validateManifestPath("foo.jsx")).toBe(true);
    });

    it("rejects absolute paths", () => {
      expect(validateManifestPath("/etc/passwd")).toBe(false);
      expect(validateManifestPath("/tmp/evil.jsx")).toBe(false);
    });

    it("rejects paths starting with ../", () => {
      expect(validateManifestPath("../outside.jsx")).toBe(false);
      expect(validateManifestPath("../../etc/passwd")).toBe(false);
    });

    it("rejects paths with embedded .. segments", () => {
      expect(validateManifestPath("foo/../../etc/passwd")).toBe(false);
    });

    it("accepts paths that include 'dotdot' as literal text but not .. traversal", () => {
      expect(validateManifestPath("dotdot/file.jsx")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Finding A: integration - unsafe manifest paths skipped with stderr warning
  // -------------------------------------------------------------------------
  it("traversal paths in design_sources and reference_screenshots are skipped with warning", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-traversal-"));
    // Set up an "outside" file that a traversal could reach
    writeFileSync(join(tmpPath, "secret.txt"), "should-not-be-copied", "utf-8");

    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), "jsx", "utf-8");
    mkdirSync(join(extractDir, "screenshots"), { recursive: true });
    writeFileSync(join(extractDir, "screenshots/real-sessions.png"), "png", "utf-8");

    const doc = validFindings();
    // Inject unsafe entries alongside a safe one
    (doc["unit"] as JsonObject)["design_sources"] = [
      "ui_kits/app/SessionsPage.jsx",   // safe
      "../secret.txt",                   // traversal - must be skipped
      "/etc/passwd",                     // absolute - must be skipped
    ];
    (doc["unit"] as JsonObject)["reference_screenshots"] = [
      "screenshots/real-sessions.png",  // safe
      "../secret.txt",                   // traversal - must be skipped
    ];
    (doc["unit"] as JsonObject)["primary_source"] = "ui_kits/app/SessionsPage.jsx";

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderrLines.push(String(s));
      return true;
    });
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    stderrSpy.mockRestore();

    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");

    // Safe source file was copied; unsafe ones were not
    expect(existsSync(join(pack, "design-source/ui_kits/app/SessionsPage.jsx"))).toBe(true);
    // No escaped write - the traversal path must not appear anywhere under the pack
    expect(existsSync(join(pack, "design-source/../secret.txt"))).toBe(false);
    expect(existsSync(join(pack, "design-source/secret.txt"))).toBe(false);

    // Safe screenshot was copied; unsafe traversal was not
    expect(existsSync(join(pack, "screenshots/screenshots/real-sessions.png"))).toBe(true);

    // Warnings were emitted for each unsafe path
    const warnings = stderrLines.join("\n");
    expect(warnings).toContain("../secret.txt");
    expect(warnings).toContain("/etc/passwd");
  });

  // -------------------------------------------------------------------------
  // Finding B: declined/pending reuse excluded from Dependencies and main table
  // -------------------------------------------------------------------------
  it("declined finding's new-component reuse absent from Dependencies and main table", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-reuse-"));
    const doc = validFindings();
    // Add a declined finding that has new-component reuse
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-04",
      title: "New filter panel",
      category: "visual",
      intent: "likely-intentional",
      intent_rationale: "designer added",
      theme: null,
      state: { summary: "No filter panel", refs: [] },
      spec: { summary: "Filter panel with AdvancedFilter component", refs: [] },
      reuse: {
        resolution: "new-component",
        proposed_name: "AdvancedFilter",
        closest_existing: null,
      },
      decision: { state: "pending" },
      summary: "Add filter panel with AdvancedFilter",
    });
    // Override decisions: decline the new finding
    const decisions = validDecisions();
    (decisions["decisions"] as JsonObject)["CHG-sessions-page-04"] = { state: "declined" };

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(decisions), "utf-8");
    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), "jsx", "utf-8");
    writeFileSync(join(extractDir, "SessionsPage.jsx"), "jsx", "utf-8");
    mkdirSync(join(extractDir, "screenshots"), { recursive: true });
    writeFileSync(join(extractDir, "screenshots/real-sessions.png"), "png", "utf-8");
    const outDir = join(tmpPath, "packs");

    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");

    // The unit-level catalog table (Status badge) must NOT appear in Dependencies
    // (unit-level catalog rows are never decision-tracked)
    expect(uiBody).not.toContain("Design-system ticket required: build `Status badge`");

    // Declined finding's new-component must NOT appear in Dependencies
    expect(uiBody).not.toContain("Design-system ticket required: build `AdvancedFilter`");

    // The accepted finding's new-component (ArtifactTopbar) IS in Dependencies
    expect(uiBody).toContain("Design-system ticket required: build `ArtifactTopbar`");

    // Declined reuse must not appear in the main Component Reuse table header rows
    // (the main table only contains accepted findings' reuse blocks)
    const reuseSection = uiBody.split("## Component Reuse")[1]?.split("## ")[0] ?? "";
    // The main table rows (before the catalog subsection) must not mention AdvancedFilter
    const mainTablePart = reuseSection.split("### Catalog")[0] ?? reuseSection;
    expect(mainTablePart).not.toContain("AdvancedFilter");
  });

  it("unit-level catalog reuse in informational subsection only, not in Dependencies", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-catalog-"));
    // validFindings has component_reuse with "Status badge" / resolution: reuse
    // Add a unit-level catalog entry with new-component to verify it never enters Dependencies
    const doc = validFindings();
    (doc["component_reuse"] as JsonObject[]).push({
      element: "FilterBar",
      resolution: "new-component",
      proposed_name: "FilterBar",
    });

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), "jsx", "utf-8");
    writeFileSync(join(extractDir, "SessionsPage.jsx"), "jsx", "utf-8");
    mkdirSync(join(extractDir, "screenshots"), { recursive: true });
    writeFileSync(join(extractDir, "screenshots/real-sessions.png"), "png", "utf-8");
    const outDir = join(tmpPath, "packs");

    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");

    // Unit-level catalog new-component must NOT be in Dependencies
    expect(uiBody).not.toContain("Design-system ticket required: build `FilterBar`");

    // Catalog subsection header must be present
    expect(uiBody).toContain("Catalog (informational, not decision-tracked)");

    // FilterBar appears under the catalog subsection
    const catalogSection = uiBody.split("Catalog (informational, not decision-tracked)")[1] ?? "";
    expect(catalogSection).toContain("FilterBar");
  });

  // -------------------------------------------------------------------------
  // Finding C: replay removes stale outputs
  // -------------------------------------------------------------------------
  it("exit-3 run removes a pre-existing pack dir", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-exit3-"));
    const outDir = join(tmpPath, "packs");
    const pack = join(outDir, "scr-sessions-page");

    // First run: accepted -> creates pack
    const { rc: rc1 } = runPack(tmpPath, validDecisions());
    expect(rc1).toBe(0);
    expect(existsSync(pack)).toBe(true);

    // Second run: decline everything -> exit 3, pack dir must be removed
    const decisions2 = validDecisions();
    (decisions2 as JsonObject)["decisions"] = {
      "thm-artifact-table": { state: "declined" },
      "CHG-sessions-page-02": { state: "declined" },
    };
    // Reuse same tmpPath so outDir is the same packs/ dir
    const extractDir = join(tmpPath, "extracted");
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(decisions2), "utf-8");
    const rc2 = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc2).toBe(3);
    expect(existsSync(pack)).toBe(false);
  });

  it("replay: accepted-then-declined backend gap leaves no ticket-body-api.md and no stale screenshots", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-replay-"));
    const outDir = join(tmpPath, "packs");
    const pack = join(outDir, "scr-sessions-page");

    // Build a findings doc with an accepted backend-gap finding
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint", refs: [] },
      spec: { summary: "POST /api/sessions", refs: [] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });

    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), "jsx-v1", "utf-8");
    writeFileSync(join(extractDir, "SessionsPage.jsx"), "old jsx", "utf-8");
    mkdirSync(join(extractDir, "screenshots"), { recursive: true });
    writeFileSync(join(extractDir, "screenshots/real-sessions.png"), "png-data", "utf-8");

    const findingsPath = join(tmpPath, "unit.json");
    const decisionsPath = join(tmpPath, "decisions.json");

    // Run 1: backend-gap finding is accepted
    const decisions1 = validDecisions();
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    writeFileSync(decisionsPath, JSON.stringify(decisions1), "utf-8");
    const rc1 = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc1).toBe(0);
    expect(existsSync(join(pack, "ticket-body-api.md"))).toBe(true);
    expect(existsSync(join(pack, "screenshots/screenshots/real-sessions.png"))).toBe(true);

    // Run 2: now decline the backend-gap finding (but keep the UI finding accepted)
    const decisions2 = validDecisions();
    (decisions2["decisions"] as JsonObject)["CHG-sessions-page-03"] = { state: "declined" };
    writeFileSync(decisionsPath, JSON.stringify(decisions2), "utf-8");
    const rc2 = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc2).toBe(0);

    // ticket-body-api.md must be gone (no accepted backend-gap findings)
    expect(existsSync(join(pack, "ticket-body-api.md"))).toBe(false);

    // Pack dir itself still exists (UI findings are accepted)
    expect(existsSync(pack)).toBe(true);
    expect(existsSync(join(pack, "ticket-body-ui.md"))).toBe(true);
  });

  it("exit-3 message distinguishes all-declined from pending-remain", () => {
    // Case A: everything is explicitly declined, no pending
    const tmpPathA = mkdtempSync(join(tmpdir(), "bdp-"));
    const decisionsA = validDecisions();
    (decisionsA as JsonObject)["decisions"] = {
      "thm-artifact-table": { state: "declined" },
      "CHG-sessions-page-02": { state: "declined" },
    };
    const errSpyA = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rcA = runPack(tmpPathA, decisionsA).rc;
    const errMsgA = errSpyA.mock.calls.map((c) => String(c[0])).join("\n");
    errSpyA.mockRestore();

    expect(rcA).toBe(3);
    expect(errMsgA).toContain("declined");
    expect(errMsgA).not.toContain("pending");

    // Case B: one finding pending (no explicit decision, no theme decision)
    const tmpPathB = mkdtempSync(join(tmpdir(), "bdp-"));
    const decisionsB = validDecisions();
    // Override so CHG-sessions-page-01 has no theme or explicit decision (pending),
    // and CHG-sessions-page-02 is declined
    (decisionsB as JsonObject)["decisions"] = {
      "CHG-sessions-page-02": { state: "declined" },
    };
    const errSpyB = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rcB = runPack(tmpPathB, decisionsB).rc;
    const errMsgB = errSpyB.mock.calls.map((c) => String(c[0])).join("\n");
    errSpyB.mockRestore();

    expect(rcB).toBe(3);
    expect(errMsgB).toContain("pending");
  });

  // -------------------------------------------------------------------------
  // FEA-1793: self-contained ticket bodies
  // -------------------------------------------------------------------------

  it("UI body criteria carry State/Spec/Refs sub-bullets", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-substate-"));
    const { rc, pack } = runPack(tmpPath, validDecisions());
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    const criteria = uiBody.split("## Acceptance Criteria")[1]!.split("\n## ")[0]!;
    // CHG-sessions-page-01 is accepted via its theme. Its state/spec/refs come
    // straight from the findings fixture.
    expect(criteria).toContain("(CHG-sessions-page-01)");
    expect(criteria).toContain("- State: Header + Card shell");
    expect(criteria).toContain("- Spec: sticky sess-topbar");
    // Refs join state.refs + spec.refs (file:line into the design source).
    expect(criteria).toContain("- Refs:");
    expect(criteria).toContain("apps/app/.../page.tsx:86");
    expect(criteria).toContain("ui_kits/app/SessionsPage.jsx:1430");
  });

  it("API body criteria carry State/Spec/Refs sub-bullets", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-apisub-"));
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint exists", refs: ["apps/api/routes/sessions.ts:12"] },
      spec: { summary: "POST /api/sessions returns rows", refs: ["ui_kits/app/SessionsPage.jsx:900"] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const apiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-api.md"), "utf-8");
    expect(apiBody).toContain("- State: No endpoint exists");
    expect(apiBody).toContain("- Spec: POST /api/sessions returns rows");
    expect(apiBody).toContain("- Refs:");
    expect(apiBody).toContain("apps/api/routes/sessions.ts:12");
    expect(apiBody).toContain("ui_kits/app/SessionsPage.jsx:900");
  });

  it("findings with a screenshot get an inline image placeholder; those without do not", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-shots-"));
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    // CHG-sessions-page-01 gets a captured screenshot; -02 (declined) has none.
    findings[0]!["screenshot"] = "shots/CHG-sessions-page-01.png";
    // Add an accepted standalone visual finding with NO screenshot.
    findings.push({
      id: "CHG-sessions-page-05",
      title: "Spacing tweak",
      category: "visual",
      intent: "likely-intentional",
      intent_rationale: "designer note",
      theme: null,
      state: { summary: "8px gap", refs: [] },
      spec: { summary: "12px gap", refs: [] },
      decision: { state: "pending" },
      summary: "Increase row gap to 12px",
    });
    const decisions = validDecisions();
    (decisions["decisions"] as JsonObject)["CHG-sessions-page-05"] = { state: "accepted" };

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(decisions), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");
    // Placeholder uses EXACTLY apply-inline-images' attachment://{{path}} syntax.
    expect(uiBody).toContain("attachment://{{shots/CHG-sessions-page-01.png}}");
    // The screenshot-less accepted finding emits a criterion but no placeholder line for it.
    expect(uiBody).toContain("(CHG-sessions-page-05)");
    expect(uiBody).not.toContain("attachment://{{shots/CHG-sessions-page-05");
  });

  it("unit base/theme shot placeholder appears near the top of the UI body", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-baseshot-"));
    const doc = validFindings();
    // The capture step propagates the unit base shot onto theme.screenshot.
    (doc["themes"] as JsonObject[])[0]!["screenshot"] = "shots/scr-sessions-page-base.png";
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");
    const beforeCriteria = uiBody.split("## Acceptance Criteria")[0]!;
    // The base shot placeholder is above the Acceptance Criteria heading.
    expect(beforeCriteria).toContain("attachment://{{shots/scr-sessions-page-base.png}}");
  });

  it("embedded design source section uses fenced blocks with real content", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-embed-"));
    const cssPath = join(tmpPath, "slice.css");
    writeFileSync(cssPath, ".topbar { position: sticky }", "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
      "--css-slice", cssPath,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");
    expect(uiBody).toContain("## Design Source (embedded)");
    expect(uiBody).toContain("````jsx");
    expect(uiBody).toContain("old jsx"); // SessionsPage.jsx content from makeExtractDir
    expect(uiBody).toContain("````css");
    expect(uiBody).toContain(".topbar { position: sticky }");
  });

  it("embedded source over the budget is truncated with a visible marker", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-trunc-"));
    const extractDir = join(tmpPath, "extracted");
    mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
    // Generate > 90,000 chars across many lines so the budget truncates it.
    const bigLine = "const x = 1; // padding to exceed the embed budget line";
    const big = Array.from({ length: 3000 }, (_, i) => `${bigLine} ${i}`).join("\n");
    expect(big.length).toBeGreaterThan(90_000);
    writeFileSync(join(extractDir, "ui_kits/app/SessionsPage.jsx"), big, "utf-8");
    writeFileSync(join(extractDir, "SessionsPage.jsx"), "tiny", "utf-8");
    mkdirSync(join(extractDir, "screenshots"), { recursive: true });
    writeFileSync(join(extractDir, "screenshots/real-sessions.png"), "png", "utf-8");

    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(validFindings()), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");
    // The truncation marker reports dropped lines and characters.
    expect(uiBody).toMatch(/\[truncated: \d+ more lines, \d+ more characters\]/);
    // The whole big source is NOT embedded verbatim: the budget caps the section.
    const embedded = uiBody.split("## Design Source (embedded)")[1] ?? "";
    expect(embedded.length).toBeLessThan(big.length);
  });

  it("no generated body contains the phrase 'attached design pack'", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-nophrase-"));
    const doc = validFindings();
    const findings = doc["findings"] as JsonObject[];
    findings.push({
      id: "CHG-sessions-page-03",
      title: "API endpoint needed",
      category: "backend-gap",
      intent: "likely-intentional",
      intent_rationale: "backend needed",
      theme: null,
      state: { summary: "No endpoint", refs: [] },
      spec: { summary: "POST /api/sessions", refs: [] },
      decision: { state: "accepted" },
      summary: "Add POST /api/sessions endpoint",
    });
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const pack = join(outDir, "scr-sessions-page");
    const uiBody = readFileSync(join(pack, "ticket-body-ui.md"), "utf-8");
    const apiBody = readFileSync(join(pack, "ticket-body-api.md"), "utf-8");
    expect(uiBody).not.toContain("attached design pack");
    expect(apiBody).not.toContain("attached design pack");
  });

  it("generated placeholders are consumable by applyInlineImages (map substitutes, strip removes)", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "bdp-applyimg-"));
    const doc = validFindings();
    (doc["findings"] as JsonObject[])[0]!["screenshot"] = "shots/CHG-sessions-page-01.png";
    const findingsPath = join(tmpPath, "unit.json");
    writeFileSync(findingsPath, JSON.stringify(doc), "utf-8");
    const decisionsPath = join(tmpPath, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(validDecisions()), "utf-8");
    const extractDir = makeExtractDir(tmpPath);
    const outDir = join(tmpPath, "packs");
    const rc = main([
      "--findings", findingsPath,
      "--decisions", decisionsPath,
      "--extract-dir", extractDir,
      "--out-dir", outDir,
    ]);
    expect(rc).toBe(0);
    const uiBody = readFileSync(join(outDir, "scr-sessions-page", "ticket-body-ui.md"), "utf-8");

    // Map mode: the placeholder path resolves to its attachment id.
    const map = new Map<string, string>([["shots/CHG-sessions-page-01.png", "att-uuid-123"]]);
    const mapped = applyInlineImages(uiBody, "map", map);
    expect(mapped.result.substituted).toBe(1);
    expect(mapped.body).toContain("attachment://att-uuid-123");
    expect(mapped.body).not.toContain("attachment://{{shots/CHG-sessions-page-01.png}}");

    // Strip mode: the placeholder line is removed entirely.
    const stripped = applyInlineImages(uiBody, "strip", new Map());
    expect(stripped.result.stripped).toContain("shots/CHG-sessions-page-01.png");
    expect(stripped.body).not.toContain("attachment://");
  });
});
