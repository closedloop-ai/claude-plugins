/**
 * Bounded end-to-end CLI flow test through the COMMITTED dist bundles.
 *
 * Exercises the full Stage A rendering + Stage C decision/ticket/pack pipeline
 * using execFileSync against the pre-built .mjs bundles in:
 *   plugins/code/skills/design-inventory/scripts/dist/
 *
 * The suite is SKIPPED when the dist directory does not exist (run
 * `npm run build` in tools/design-inventory to enable it).
 *
 * Run with: npx vitest run src/cli-flow.test.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validFindings } from "./test-fixtures.js";
import type { JsonObject } from "./design-findings-schema.js";

// ---------------------------------------------------------------------------
// Resolve dist dir relative to THIS file's location.
// src/cli-flow.test.ts -> ../../../plugins/code/skills/design-inventory/scripts/dist
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(
  __dirname,
  "../../../plugins/code/skills/design-inventory/scripts/dist",
);

const DIST_EXISTS = existsSync(DIST_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function distMjs(name: string): string {
  return join(DIST_DIR, `${name}.mjs`);
}

function run(mjs: string, args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync("node", [mjs, ...args], { encoding: "utf-8" });
    return { stdout, stderr: "", code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.status ?? 1,
    };
  }
}

/** Write JSON to path, creating parent dirs as needed. */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Build a fixture findings doc using validFindings() with a unit-scoped theme
 * id (thm-sessions-page-artifact-table) so the plan-ticket-graph cross-unit
 * guard is satisfied, and fix the member finding's theme field to match.
 */
function fixtureFindings(): JsonObject {
  const doc = validFindings();
  const THEME_ID = "thm-sessions-page-artifact-table";

  // Override theme id to unit-scoped format
  const themes = doc["themes"] as JsonObject[];
  themes[0] = { ...(themes[0] as JsonObject), id: THEME_ID };

  // Fix member finding's theme reference to match
  const findings = doc["findings"] as JsonObject[];
  findings[0] = { ...(findings[0] as JsonObject), theme: THEME_ID };

  return doc;
}

/** Minimal manifest for a single screen unit. */
function minimalManifest(): object {
  return {
    units: [{ id: "scr-sessions-page", name: "Sessions Page", type: "screen" }],
  };
}

/**
 * Remove all lines belonging to the theme H3 block (the H3 heading line and
 * the H4 finding lines under it), simulating a reviewer declining the theme.
 *
 * The block is delimited by the theme's H3 heading line (`### ... \`thm-...\``)
 * and extends until the next heading of level <= 3 or end of file.
 */
function deleteThemeBlock(body: string, themeId: string): string {
  const lines = body.split("\n");
  let inBlock = false;
  const kept: string[] = [];

  for (const line of lines) {
    if (line.match(/^### .+`thm-sessions-page-artifact-table`/)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // End block on next H3 or shallower heading (but not H4/H5 which are findings)
      if (line.match(/^#{1,3}\s/)) {
        inBlock = false;
        kept.push(line);
      }
      // while in block, skip (declining)
      continue;
    }
    kept.push(line);
  }

  void themeId; // referenced in regex above
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Suite - skipped when dist does not exist
// ---------------------------------------------------------------------------

describe.skipIf(!DIST_EXISTS)("cli-flow (dist bundles)", () => {
  it("dist bundles exist and are readable", () => {
    for (const name of [
      "render-review-doc",
      "derive-decisions-from-doc",
      "plan-ticket-graph",
      "build-design-pack",
      "apply-inline-images",
    ]) {
      expect(existsSync(distMjs(name)), `${name}.mjs missing`).toBe(true);
    }
  });

  it("render-review-doc produces a review body with expected content", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clf-rrd-"));
    const findingsDir = join(tmp, "findings");
    mkdirSync(findingsDir);
    writeJson(join(findingsDir, "scr-sessions-page.json"), fixtureFindings());
    writeJson(join(tmp, "manifest.json"), minimalManifest());

    const outPath = join(tmp, "body.md");
    const result = run(distMjs("render-review-doc"), [
      "--findings", findingsDir,
      "--manifest", join(tmp, "manifest.json"),
      "--out", outPath,
      "--export-name", "test-export.zip",
    ]);
    expect(result.code, result.stderr).toBe(0);

    const body = readFileSync(outPath, "utf-8");
    expect(body).toContain("# Design Review");
    expect(body).toContain("thm-sessions-page-artifact-table");
    expect(body).toContain("CHG-sessions-page-01");
  });

  it("derive-decisions-from-doc correctly counts declined/accepted from an edited body", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clf-ddd-"));
    const findingsDir = join(tmp, "findings");
    mkdirSync(findingsDir);
    writeJson(join(findingsDir, "scr-sessions-page.json"), fixtureFindings());
    writeJson(join(tmp, "manifest.json"), minimalManifest());

    // Step 1: render full review body
    const fullBodyPath = join(tmp, "body-full.md");
    const renderResult = run(distMjs("render-review-doc"), [
      "--findings", findingsDir,
      "--manifest", join(tmp, "manifest.json"),
      "--out", fullBodyPath,
    ]);
    expect(renderResult.code, renderResult.stderr).toBe(0);

    // Step 2: simulate review edit - delete the theme block (decline the theme)
    const fullBody = readFileSync(fullBodyPath, "utf-8");
    const editedBody = deleteThemeBlock(fullBody, "thm-sessions-page-artifact-table");
    const editedBodyPath = join(tmp, "body-edited.md");
    writeFileSync(editedBodyPath, editedBody, "utf-8");

    // Step 3: derive decisions
    const decisionsPath = join(tmp, "decisions.json");
    const deriveResult = run(distMjs("derive-decisions-from-doc"), [
      "--doc", editedBodyPath,
      "--findings", findingsDir,
      "--out", decisionsPath,
      "--reviewer", "test@example.com",
    ]);
    expect(deriveResult.code, deriveResult.stderr).toBe(0);

    const decisions = JSON.parse(readFileSync(decisionsPath, "utf-8")) as JsonObject;
    expect(decisions).toHaveProperty("decisions");

    // The theme and its member findings should be declined
    const decisionsMap = decisions["decisions"] as Record<string, JsonObject>;
    const themeDecision = decisionsMap["thm-sessions-page-artifact-table"];
    // Either the theme id is directly declined, or the member findings are declined
    // (derive-decisions uses heading-anchor survival; the theme was deleted)
    const hasDecline = Object.values(decisionsMap).some(
      (d) => (d as JsonObject)["state"] === "declined",
    );
    expect(hasDecline || themeDecision?.["state"] === "declined").toBe(true);

    // CHG-sessions-page-02 has no theme, check it has a decision entry
    // (it survives since its standalone H3/H4 wasn't deleted)
    const finding02 = decisionsMap["CHG-sessions-page-02"];
    if (finding02) {
      expect(["accepted", "declined", "edited", "pending"]).toContain(finding02["state"]);
    }
  });

  it("plan-ticket-graph produces a ticket plan with tickets for the screen unit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clf-ptg-"));
    const findingsDir = join(tmp, "findings");
    mkdirSync(findingsDir);
    writeJson(join(findingsDir, "scr-sessions-page.json"), fixtureFindings());
    writeJson(join(tmp, "manifest.json"), minimalManifest());

    // Build decisions that accept the standalone finding and decline the theme
    // CHG-sessions-page-01 is under thm-sessions-page-artifact-table -> declined via theme
    // CHG-sessions-page-02 is standalone -> accepted
    const decisionsDoc = {
      schema_version: 1,
      reviewer: "test@example.com",
      decided_at: new Date().toISOString(),
      decisions: {
        "thm-sessions-page-artifact-table": { state: "declined" },
        "CHG-sessions-page-02": { state: "accepted" },
      },
    };
    writeJson(join(tmp, "decisions.json"), decisionsDoc);

    const ticketPlanPath = join(tmp, "ticket-plan.json");
    const result = run(distMjs("plan-ticket-graph"), [
      "--findings", findingsDir,
      "--decisions", join(tmp, "decisions.json"),
      "--manifest", join(tmp, "manifest.json"),
      "--out", ticketPlanPath,
    ]);
    expect(result.code, result.stderr).toBe(0);

    const plan = JSON.parse(readFileSync(ticketPlanPath, "utf-8")) as JsonObject;
    expect(plan).toHaveProperty("tickets");
    const tickets = plan["tickets"] as JsonObject[];
    expect(tickets.length).toBeGreaterThan(0);
    // There must be at least one UI ticket for the sessions-page unit
    const uiTicket = tickets.find((t) => (t["unit_id"] === "scr-sessions-page") && t["kind"] === "ui");
    expect(uiTicket).toBeDefined();
  });

  it("build-design-pack produces ticket-body-ui.md for accepted findings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clf-bdp-"));
    const findingsDir = join(tmp, "findings");
    mkdirSync(findingsDir);
    writeJson(join(findingsDir, "scr-sessions-page.json"), fixtureFindings());

    // Accept CHG-sessions-page-02 (standalone), decline theme
    const decisionsDoc = {
      schema_version: 1,
      reviewer: "test@example.com",
      decided_at: new Date().toISOString(),
      decisions: {
        "thm-sessions-page-artifact-table": { state: "declined" },
        "CHG-sessions-page-02": { state: "accepted" },
      },
    };
    writeJson(join(tmp, "decisions.json"), decisionsDoc);

    // Create a minimal extract dir (build-design-pack copies design-source files)
    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir);
    writeFileSync(join(extractDir, "placeholder.txt"), "empty extract\n", "utf-8");

    const packsDir = join(tmp, "packs");
    const result = run(distMjs("build-design-pack"), [
      "--findings", join(findingsDir, "scr-sessions-page.json"),
      "--decisions", join(tmp, "decisions.json"),
      "--extract-dir", extractDir,
      "--out-dir", packsDir,
    ]);
    expect(result.code, result.stderr).toBe(0);

    const ticketBodyUi = join(packsDir, "scr-sessions-page", "ticket-body-ui.md");
    expect(existsSync(ticketBodyUi), "ticket-body-ui.md not found").toBe(true);
  });

  it("apply-inline-images --strip removes attachment placeholders from body", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clf-aii-"));

    // Create a body with attachment placeholders
    const bodyWithPlaceholders = [
      "# Design Review: Test",
      "",
      "Some content here.",
      "",
      "![screenshot](attachment://{{shots/CHG-sessions-page-01.png}})",
      "",
      "More content after.",
    ].join("\n");
    const bodyPath = join(tmp, "body.md");
    writeFileSync(bodyPath, bodyWithPlaceholders, "utf-8");

    const outPath = join(tmp, "body-stripped.md");
    const result = run(distMjs("apply-inline-images"), [
      "--body", bodyPath,
      "--out", outPath,
      "--strip",
    ]);
    expect(result.code, result.stderr).toBe(0);

    const stripped = readFileSync(outPath, "utf-8");
    expect(existsSync(outPath), "output file was not written").toBe(true);
    // Stripped body must not contain attachment:// placeholders
    expect(stripped).not.toContain("attachment://");
    // Non-placeholder content should be preserved
    expect(stripped).toContain("# Design Review: Test");
    expect(stripped).toContain("Some content here");
    expect(stripped).toContain("More content after");
  });
});
