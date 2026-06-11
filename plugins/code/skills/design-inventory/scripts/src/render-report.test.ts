/** Tests for render-report.ts */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "./render-report.js";
import { validDecisions, validFindings } from "./test-fixtures.js";
import type { JsonObject } from "./design-findings-schema.js";

function componentDoc(): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: "cmp-chat-drawer",
      name: "Chat Drawer",
      type: "component",
      classification: "new",
      design_sources: ["ChatDrawer.jsx"],
      primary_source: "ChatDrawer.jsx",
      current_impl: { status: "not_found", route: null, paths: [] },
      feature_flag: { required: true, flag: null, notes: "" },
    },
    themes: [],
    findings: [
      {
        id: "CHG-chat-drawer-01",
        title: "Drawer reuse",
        category: "component-divergence",
        intent: "unclear",
        intent_rationale: "matches existing Drawer closely",
        theme: null,
        state: { summary: "Drawer exists", refs: [] },
        spec: { summary: "restyled drawer", refs: ["ChatDrawer.jsx:10"] },
        reuse: {
          resolution: "reuse",
          component: "Drawer",
          import_path: "@repo/design-system/components/ui/drawer",
          story: "apps/storybook/stories/drawer.stories.tsx",
        },
        decision: { state: "pending" },
        summary: "Use existing Drawer or confirm restyle",
      },
      {
        id: "CHG-chat-drawer-02",
        title: "Missing messages endpoint",
        category: "backend-gap",
        intent: "likely-intentional",
        intent_rationale: "drawer shows live messages",
        theme: null,
        state: { summary: "no endpoint", refs: [] },
        spec: { summary: "messages stream", refs: ["ChatDrawer.jsx:42"] },
        reuse: null,
        decision: { state: "pending" },
        summary: "Backend ticket for messages endpoint",
      },
    ],
    component_reuse: [],
    visual_spec: {
      colors: {
        resolved: [{ value: "#112233", token: "--primary", count: 2 }],
        drift: [{ value: "#e74c3c", count: 1 }],
      },
      icons: ["send"],
      layout: { sticky: 1, flex: 3, utility_classes: [] },
    },
  };
}

function writeInputs(tmpPath: string): string {
  const findingsDir = join(tmpPath, "findings");
  mkdirSync(findingsDir, { recursive: true });
  writeFileSync(join(findingsDir, "scr-sessions-page.json"), JSON.stringify(validFindings()), "utf-8");
  writeFileSync(join(findingsDir, "cmp-chat-drawer.json"), JSON.stringify(componentDoc()), "utf-8");
  // A decisions doc in the same directory must be skipped by directory loading.
  writeFileSync(join(findingsDir, "decisions.json"), JSON.stringify(validDecisions()), "utf-8");
  return findingsDir;
}

describe("render-report", () => {
  it("report without decisions", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rr-"));
    const findingsDir = writeInputs(tmpPath);
    const out = join(tmpPath, "report.md");
    const rc = main([
      "--findings", findingsDir,
      "--out", out,
      "--export-name", "claude_design.zip",
      "--not-analyzed", "scr-inbox-page: excluded from validation run",
    ]);
    expect(rc).toBe(0);
    const text = readFileSync(out, "utf-8");
    expect(text).toContain("# Design Inventory Report — claude_design.zip");
    expect(text).toContain("CHG-sessions-page-01");
    expect(text).toContain("CHG-chat-drawer-01");
    expect(text).toContain("**REQUIRES FEATURE FLAG:**");
    expect(text).toContain("## Decisions Needed");
    expect(text).toContain("## Backend Gaps");
    expect(text).toContain("CHG-chat-drawer-02");
    expect(text).toContain("use `Drawer` from `@repo/design-system/components/ui/drawer`");
    expect(text).toContain("ArtifactTopbar"); // new-component from finding reuse
    expect(text).toContain("## Not Analyzed");
    expect(text).toContain("scr-inbox-page");
    expect(text).toContain("### Visual Spec (token-resolved)");
    expect(text).toContain("1 resolved to tokens, 1 drifting");
  });

  it("decisions resolve marks and pending list", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rr-"));
    const findingsDir = writeInputs(tmpPath);
    const out = join(tmpPath, "report.md");
    const rc = main([
      "--findings", findingsDir,
      "--out", out,
      "--decisions", join(findingsDir, "decisions.json"),
    ]);
    expect(rc).toBe(0);
    const text = readFileSync(out, "utf-8");
    // theme accepted -> member finding rendered accepted
    expect(text).toContain("[x] Accept / [ ] Decline — CHG-sessions-page-01");
    // explicit decline
    expect(text).toContain("[ ] Accept / [x] Decline — CHG-sessions-page-02");
    // undecided chat drawer findings remain in Decisions Needed
    expect(text).toContain("CHG-chat-drawer-01: Use existing Drawer");
    // CHG-sessions-page-01 must NOT appear in the Decisions Needed section
    const decisionsNeededSection = text.split("## Decisions Needed")[1]!.split("##")[0]!;
    expect(decisionsNeededSection).not.toContain("CHG-sessions-page-01");
  });

  it("invalid findings fail", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rr-"));
    const doc = validFindings();
    (doc["unit"] as JsonObject)["type"] = "page";
    const bad = join(tmpPath, "bad.json");
    writeFileSync(bad, JSON.stringify(doc), "utf-8");
    expect(main(["--findings", bad, "--out", join(tmpPath, "r.md")])).toBe(1);
  });

  it("deprecated unit renders do not implement", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "rr-"));
    const doc = validFindings();
    (doc["unit"] as JsonObject)["id"] = "scr-loops-page";
    (doc["unit"] as JsonObject)["name"] = "Loops Page";
    (doc["unit"] as JsonObject)["classification"] = "deprecated-do-not-implement";
    doc["findings"] = [];
    doc["themes"] = [];
    doc["component_reuse"] = [];
    const path = join(tmpPath, "loops.json");
    writeFileSync(path, JSON.stringify(doc), "utf-8");
    const out = join(tmpPath, "report.md");
    expect(main(["--findings", path, "--out", out])).toBe(0);
    const text = readFileSync(out, "utf-8");
    expect(text).toContain("## Do Not Implement");
    expect(text).toContain("MUST NOT be implemented");
  });
});
