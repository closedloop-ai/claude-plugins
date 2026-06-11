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

    const body = readFileSync(join(pack, "ticket-body.md"), "utf-8");
    expect(body).toContain("# Implement Sessions Page from approved design");
    const afterCriteria = body.split("## Acceptance Criteria")[1]!.split("##")[0]!;
    expect(afterCriteria).toContain("(CHG-sessions-page-01)");
    expect(body).toContain("## Declined Changes — DO NOT IMPLEMENT");
    const afterDeclined = body.split("Declined Changes")[1]!;
    expect(afterDeclined).toContain("CHG-sessions-page-02");
    expect(body).toContain("| `#112233` | `--primary` |");
    expect(body).toContain("`--destructive` (d=1.0)");
    expect(body).toContain("Design-system ticket required: build `ArtifactTopbar`");
    expect(body).toContain("Icons (lucide names): hand");
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
    const body = readFileSync(join(pack, "ticket-body.md"), "utf-8");
    expect(body).toContain("Topbar yes, but keep the existing Card wrapper");
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
});
