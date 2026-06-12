/** Tests for plan-ticket-graph.ts */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildTicketGraph, main } from "./plan-ticket-graph.js";
import type { JsonObject } from "./design-findings-schema.js";
import { validFindings, validDecisions } from "./test-fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal screen findings doc with no backend-gap findings. */
function screenDoc(
  unitId: string,
  unitName: string,
  findings: JsonObject[] = [],
  componentReuse: JsonObject[] = [],
): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: unitId,
      name: unitName,
      type: "screen",
      classification: "existing-modified",
      design_sources: ["dummy.jsx"],
      primary_source: "dummy.jsx",
      current_impl: { status: "found", paths: [] },
    },
    themes: [],
    findings,
    component_reuse: componentReuse,
    visual_spec: null,
  };
}

/** A minimal region findings doc. */
function regionDoc(
  unitId: string,
  unitName: string,
  findings: JsonObject[] = [],
): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: unitId,
      name: unitName,
      type: "region",
      classification: "existing-modified",
      design_sources: ["dummy.jsx"],
      primary_source: "dummy.jsx",
      current_impl: { status: "found", paths: [] },
    },
    themes: [],
    findings,
    component_reuse: [],
    visual_spec: null,
  };
}

/** A minimal component findings doc. */
function componentDoc(
  unitId: string,
  unitName: string,
  findings: JsonObject[] = [],
): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: unitId,
      name: unitName,
      type: "component",
      classification: "existing-modified",
      design_sources: ["dummy.jsx"],
      primary_source: "dummy.jsx",
      current_impl: { status: "found", paths: [] },
    },
    themes: [],
    findings,
    component_reuse: [],
    visual_spec: null,
  };
}

function makeFinding(
  id: string,
  category: string,
  decisionState: "accepted" | "declined" | "edited" = "accepted",
  reuse?: JsonObject,
): JsonObject {
  const finding: JsonObject = {
    id,
    title: `Finding ${id}`,
    category,
    intent: "likely-intentional",
    intent_rationale: "test",
    theme: null,
    state: { summary: "current", refs: [] },
    spec: { summary: "spec", refs: [] },
    decision: { state: decisionState },
    summary: `Summary for ${id}`,
  };
  if (reuse !== undefined) {
    finding["reuse"] = reuse;
  }
  return finding;
}

function allAcceptedDecisions(): Record<string, JsonObject> {
  return {};
}

// ---------------------------------------------------------------------------
// Unit tests for buildTicketGraph
// ---------------------------------------------------------------------------

describe("buildTicketGraph", () => {
  it("produces one UI ticket per qualifying screen", () => {
    const finding = makeFinding("CHG-scr-home-01", "visual");
    const doc = screenDoc("scr-home", "Home", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-home"]);

    expect(plan.tickets).toHaveLength(1);
    const t = plan.tickets[0]!;
    expect(t.kind).toBe("ui");
    expect(t.id).toBe("ui:scr-home");
    expect(t.unit_id).toBe("scr-home");
    expect(t.title).toBe("Implement Home UI from approved design");
    expect(t.criteria).toEqual(["CHG-scr-home-01"]);
    expect(plan.blocks).toHaveLength(0);
  });

  it("produces one UI ticket per qualifying region", () => {
    const finding = makeFinding("CHG-rgn-nav-01", "visual");
    const doc = regionDoc("rgn-nav", "Nav", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["rgn-nav"]);

    expect(plan.tickets).toHaveLength(1);
    expect(plan.tickets[0]!.kind).toBe("ui");
    expect(plan.tickets[0]!.id).toBe("ui:rgn-nav");
  });

  it("produces ZERO tickets for component units", () => {
    const finding = makeFinding("CHG-cmp-btn-01", "visual");
    const doc = componentDoc("cmp-btn", "Button", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["cmp-btn"]);

    expect(plan.tickets).toHaveLength(0);
    expect(plan.blocks).toHaveLength(0);
  });

  it("produces no ticket for units with zero accepted findings", () => {
    const finding = makeFinding("CHG-scr-empty-01", "visual", "declined");
    const doc = screenDoc("scr-empty", "Empty", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-empty"]);

    expect(plan.tickets).toHaveLength(0);
  });

  it("backend-gap findings go to API ticket, not UI ticket criteria", () => {
    const visual = makeFinding("CHG-scr-dash-01", "visual");
    const backend = makeFinding("CHG-scr-dash-02", "backend-gap");
    const doc = screenDoc("scr-dash", "Dashboard", [visual, backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-dash"]);

    const ui = plan.tickets.find((t) => t.kind === "ui");
    const api = plan.tickets.find((t) => t.kind === "api");
    expect(ui).toBeDefined();
    expect(api).toBeDefined();
    expect(ui!.criteria).toContain("CHG-scr-dash-01");
    expect(ui!.criteria).not.toContain("CHG-scr-dash-02");
    expect(api!.criteria).toContain("CHG-scr-dash-02");
    expect(api!.criteria).not.toContain("CHG-scr-dash-01");
  });

  it("API ticket is absent when no backend-gap findings", () => {
    const finding = makeFinding("CHG-scr-a-01", "visual");
    const doc = screenDoc("scr-a", "A", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-a"]);

    expect(plan.tickets.every((t) => t.kind !== "api")).toBe(true);
  });

  it("UI ticket is absent when all accepted findings are backend-gap", () => {
    const backend = makeFinding("CHG-scr-api-only-01", "backend-gap");
    const doc = screenDoc("scr-api-only", "ApiOnly", [backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-api-only"]);

    expect(plan.tickets.find((t) => t.kind === "ui")).toBeUndefined();
    expect(plan.tickets.find((t) => t.kind === "api")).toBeDefined();
    // No blocks because no UI ticket to block
    expect(plan.blocks).toHaveLength(0);
  });

  it("API ticket BLOCKS UI ticket when both exist", () => {
    const visual = makeFinding("CHG-scr-b-01", "visual");
    const backend = makeFinding("CHG-scr-b-02", "backend-gap");
    const doc = screenDoc("scr-b", "B", [visual, backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-b"]);

    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({ from: "api:scr-b", to: "ui:scr-b" });
  });

  it("net-new component assigned to PRIMARY (first in manifest order) unit", () => {
    const newCompReuse: JsonObject = {
      resolution: "new-component",
      proposed_name: "SharedWidget",
    };
    const f1 = makeFinding("CHG-scr-first-01", "visual", "accepted", newCompReuse);
    const f2 = makeFinding("CHG-scr-second-01", "visual", "accepted", newCompReuse);
    const doc1 = screenDoc("scr-first", "First", [f1]);
    const doc2 = screenDoc("scr-second", "Second", [f2]);

    // scr-first comes first in manifest
    const plan = buildTicketGraph([doc1, doc2], allAcceptedDecisions(), [
      "scr-first",
      "scr-second",
    ]);

    const ui1 = plan.tickets.find((t) => t.id === "ui:scr-first") as import("./plan-ticket-graph.js").UiTicket | undefined;
    const ui2 = plan.tickets.find((t) => t.id === "ui:scr-second") as import("./plan-ticket-graph.js").UiTicket | undefined;
    expect(ui1).toBeDefined();
    expect(ui2).toBeDefined();
    expect(ui1!.builds).toEqual(["SharedWidget"]);
    expect(ui2!.builds).toBeUndefined();
    expect(ui2!.uses).toEqual([{ component: "SharedWidget", built_by: "ui:scr-first" }]);
  });

  it("primary UI ticket BLOCKS consumer UI ticket for shared component", () => {
    const newCompReuse: JsonObject = {
      resolution: "new-component",
      proposed_name: "SharedBtn",
    };
    const f1 = makeFinding("CHG-scr-p-01", "visual", "accepted", newCompReuse);
    const f2 = makeFinding("CHG-scr-c-01", "visual", "accepted", newCompReuse);
    const doc1 = screenDoc("scr-p", "Primary", [f1]);
    const doc2 = screenDoc("scr-c", "Consumer", [f2]);
    const plan = buildTicketGraph([doc1, doc2], allAcceptedDecisions(), ["scr-p", "scr-c"]);

    const block = plan.blocks.find(
      (b) => b.from === "ui:scr-p" && b.to === "ui:scr-c",
    );
    expect(block).toBeDefined();
  });

  it("no self-block edge when a unit is primary and sole user", () => {
    const newCompReuse: JsonObject = {
      resolution: "new-component",
      proposed_name: "OnlyUsedHere",
    };
    const f = makeFinding("CHG-scr-solo-01", "visual", "accepted", newCompReuse);
    const doc = screenDoc("scr-solo", "Solo", [f]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-solo"]);

    expect(plan.blocks.some((b) => b.from === b.to)).toBe(false);
  });

  it("component_reuse table entries with new-component are collected", () => {
    const finding = makeFinding("CHG-scr-tbl-01", "visual");
    const tableEntry: JsonObject = {
      element: "Fancy Table",
      resolution: "new-component",
      proposed_name: "FancyTable",
    };
    const doc = screenDoc("scr-tbl", "Table", [finding], [tableEntry]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-tbl"]);

    const ui = plan.tickets.find((t) => t.kind === "ui") as import("./plan-ticket-graph.js").UiTicket | undefined;
    expect(ui?.builds).toContain("FancyTable");
  });

  it("blocks are deduplicated when shared component referenced twice", () => {
    const reuse: JsonObject = { resolution: "new-component", proposed_name: "Dup" };
    const f1 = makeFinding("CHG-scr-dup-01", "visual", "accepted", reuse);
    const f2 = makeFinding("CHG-scr-dup-02", "visual", "accepted", reuse);
    const consumer1 = makeFinding("CHG-scr-con-01", "visual", "accepted", reuse);
    const docP = screenDoc("scr-dup", "DupPrimary", [f1, f2]);
    const docC = screenDoc("scr-con", "Consumer", [consumer1]);
    const plan = buildTicketGraph([docP, docC], allAcceptedDecisions(), ["scr-dup", "scr-con"]);

    const blockCount = plan.blocks.filter(
      (b) => b.from === "ui:scr-dup" && b.to === "ui:scr-con",
    ).length;
    expect(blockCount).toBe(1);
  });

  it("manifest order determines processing sequence", () => {
    const f1 = makeFinding("CHG-scr-last-01", "visual");
    const f2 = makeFinding("CHG-scr-first-01", "visual");
    const docLast = screenDoc("scr-last", "Last", [f1]);
    const docFirst = screenDoc("scr-first", "First", [f2]);

    const plan = buildTicketGraph(
      [docLast, docFirst],
      allAcceptedDecisions(),
      ["scr-first", "scr-last"],
    );

    const ids = plan.tickets.map((t) => t.id);
    expect(ids.indexOf("ui:scr-first")).toBeLessThan(ids.indexOf("ui:scr-last"));
  });

  it("uses validFindings fixture: CHG-sessions-page-01 accepted, CHG-sessions-page-02 declined", () => {
    const doc = validFindings();
    const decisions = (validDecisions()["decisions"] as Record<string, JsonObject>);
    const plan = buildTicketGraph([doc], decisions, ["scr-sessions-page"]);

    const ui = plan.tickets.find((t) => t.kind === "ui");
    expect(ui).toBeDefined();
    expect(ui!.criteria).toContain("CHG-sessions-page-01");
    expect(ui!.criteria).not.toContain("CHG-sessions-page-02");
    // CHG-sessions-page-01 has new-component reuse
    expect((ui as import("./plan-ticket-graph.js").UiTicket).builds).toContain("ArtifactTopbar");
  });

  it("schema_version is 1", () => {
    const finding = makeFinding("CHG-scr-sv-01", "visual");
    const doc = screenDoc("scr-sv", "SV", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-sv"]);
    expect(plan.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

describe("plan-ticket-graph CLI", () => {
  function writeTmp(dir: string, name: string, obj: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj), "utf-8");
    return p;
  }

  function makeManifest(unitIds: string[]): JsonObject {
    return { units: unitIds.map((id) => ({ id })) };
  }

  it("returns 0 and writes ticket-plan.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptg-"));
    const finding = makeFinding("CHG-scr-cli-01", "visual");
    const doc = screenDoc("scr-cli", "CLI Screen", [finding]);
    const decisionsDoc = {
      schema_version: 1,
      reviewer: "test",
      decided_at: "2026-01-01T00:00:00Z",
      decisions: {},
    };
    const fp = writeTmp(tmp, "unit.json", doc);
    const dp = writeTmp(tmp, "decisions.json", decisionsDoc);
    const mp = writeTmp(tmp, "manifest.json", makeManifest(["scr-cli"]));
    const outPath = join(tmp, "ticket-plan.json");

    const rc = main(["--findings", fp, "--decisions", dp, "--manifest", mp, "--out", outPath]);
    expect(rc).toBe(0);

    const plan = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(plan.schema_version).toBe(1);
    expect(plan.tickets).toHaveLength(1);
    expect(plan.tickets[0].id).toBe("ui:scr-cli");
  });

  it("returns 1 on missing required args", () => {
    const rc = main(["--decisions", "x.json", "--manifest", "y.json"]);
    expect(rc).toBe(1);
  });

  it("returns 1 on invalid findings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptg-"));
    const bad = { schema_version: 1 }; // missing unit, findings, etc.
    const fp = writeTmp(tmp, "bad.json", bad);
    const dp = writeTmp(tmp, "decisions.json", {
      schema_version: 1,
      reviewer: "t",
      decided_at: "2026-01-01T00:00:00Z",
      decisions: {},
    });
    const mp = writeTmp(tmp, "manifest.json", makeManifest([]));
    const outPath = join(tmp, "out.json");
    const rc = main(["--findings", fp, "--decisions", dp, "--manifest", mp, "--out", outPath]);
    expect(rc).toBe(1);
  });

  it("accepts findings directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptg-"));
    const finding = makeFinding("CHG-scr-dir-01", "visual");
    const doc = screenDoc("scr-dir", "Dir Screen", [finding]);
    const decisionsDoc = {
      schema_version: 1,
      reviewer: "test",
      decided_at: "2026-01-01T00:00:00Z",
      decisions: {},
    };

    // Write findings into a sub-directory
    const findingsDir = join(tmp, "findings");
    mkdirSync(findingsDir);
    writeFileSync(join(findingsDir, "unit.json"), JSON.stringify(doc), "utf-8");

    const dp = writeTmp(tmp, "decisions.json", decisionsDoc);
    const mp = writeTmp(tmp, "manifest.json", makeManifest(["scr-dir"]));
    const outPath = join(tmp, "out.json");

    const rc = main([
      "--findings", findingsDir,
      "--decisions", dp,
      "--manifest", mp,
      "--out", outPath,
    ]);
    expect(rc).toBe(0);
  });
});
