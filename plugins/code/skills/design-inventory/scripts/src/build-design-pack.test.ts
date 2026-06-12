/** Tests for build-design-pack.ts */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "./build-design-pack.js";
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
    expect(existsSync(join(pack, "design-source/SessionsPage.jsx"))).toBe(true);
    expect(existsSync(join(pack, "screenshots/real-sessions.png"))).toBe(true);
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
    expect(uiBody).toContain("design-inventory Stage A");
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
});
