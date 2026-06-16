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

/** A minimal flow findings doc. */
function flowDoc(
  unitId: string,
  unitName: string,
  findings: JsonObject[] = [],
): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: unitId,
      name: unitName,
      type: "flow",
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

/**
 * A backend-gap finding carrying a data_flow at the given gap layer. capture and
 * ingestion layers drive a separate data-source ticket; serving and model do not.
 */
function makeBackendGap(
  id: string,
  gapLayer: "capture" | "ingestion" | "model" | "serving" | "unknown",
  decisionState: "accepted" | "declined" | "edited" = "accepted",
): JsonObject {
  const upstreamMissing = gapLayer === "capture" || gapLayer === "ingestion";
  const finding = makeFinding(id, "backend-gap", decisionState);
  finding["data_flow"] = {
    gap_layer: gapLayer,
    origin: "apps/desktop agent harness session telemetry",
    captured_today: !upstreamMissing,
    ingested_today: !upstreamMissing,
    refs: ["apps/desktop/src/server/operations/run-session.ts"],
  };
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

  it("produces one UI ticket for a component unit with accepted findings", () => {
    const finding = makeFinding("CHG-cmp-btn-01", "visual");
    const doc = componentDoc("cmp-btn", "Button", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["cmp-btn"]);

    expect(plan.tickets).toHaveLength(1);
    const t = plan.tickets[0]!;
    expect(t.kind).toBe("ui");
    expect(t.id).toBe("ui:cmp-btn");
    expect(t.title).toBe("Implement Button component from approved design");
    expect(t.criteria).toEqual(["CHG-cmp-btn-01"]);
    expect(plan.blocks).toHaveLength(0);
  });

  it("produces one UI ticket for a flow unit with accepted findings", () => {
    const finding = makeFinding("CHG-flw-checkout-01", "behavioral");
    const doc = flowDoc("flw-checkout", "Checkout Flow", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["flw-checkout"]);

    expect(plan.tickets).toHaveLength(1);
    const t = plan.tickets[0]!;
    expect(t.kind).toBe("ui");
    expect(t.id).toBe("ui:flw-checkout");
    expect(t.title).toBe("Implement Checkout Flow flow from approved design");
    expect(t.criteria).toEqual(["CHG-flw-checkout-01"]);
  });

  it("component unit produces zero tickets when all findings are declined", () => {
    const finding = makeFinding("CHG-cmp-btn-02", "visual", "declined");
    const doc = componentDoc("cmp-btn", "Button", [finding]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["cmp-btn"]);

    expect(plan.tickets).toHaveLength(0);
    expect(plan.blocks).toHaveLength(0);
  });

  it("component unit is the primary builder when it is first in manifest order", () => {
    const reuse: JsonObject = { resolution: "new-component", proposed_name: "ChatDialog" };
    const cmpFinding = makeFinding("CHG-cmp-chat-01", "visual", "accepted", reuse);
    const scrFinding = makeFinding("CHG-scr-inbox-01", "visual", "accepted", reuse);
    const cmpDocument = componentDoc("cmp-chat", "Chat Dialog", [cmpFinding]);
    const scrDocument = screenDoc("scr-inbox", "Inbox", [scrFinding]);

    // cmp-chat comes first in manifest order
    const plan = buildTicketGraph([cmpDocument, scrDocument], allAcceptedDecisions(), [
      "cmp-chat",
      "scr-inbox",
    ]);

    const cmpTicket = plan.tickets.find((t) => t.id === "ui:cmp-chat") as import("./plan-ticket-graph.js").UiTicket | undefined;
    const scrTicket = plan.tickets.find((t) => t.id === "ui:scr-inbox") as import("./plan-ticket-graph.js").UiTicket | undefined;
    expect(cmpTicket).toBeDefined();
    expect(scrTicket).toBeDefined();
    // Component unit is the primary builder
    expect(cmpTicket!.builds).toEqual(["ChatDialog"]);
    expect(scrTicket!.uses).toEqual([{ component: "ChatDialog", built_by: "ui:cmp-chat" }]);
    // Primary (component) blocks consumer (screen)
    const block = plan.blocks.find((b) => b.from === "ui:cmp-chat" && b.to === "ui:scr-inbox");
    expect(block).toBeDefined();
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

  it("API ticket RELATES_TO UI ticket when both exist", () => {
    const visual = makeFinding("CHG-scr-b-01", "visual");
    const backend = makeBackendGap("CHG-scr-b-02", "serving");
    const doc = screenDoc("scr-b", "B", [visual, backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-b"]);

    // serving-layer gap: api -> ui only, no data ticket. The api -> ui adjacency
    // is a parallelizable RELATES_TO edge, not a hard block.
    expect(plan.tickets.find((t) => t.kind === "data")).toBeUndefined();
    expect(plan.blocks).toHaveLength(0);
    expect(plan.relates).toHaveLength(1);
    expect(plan.relates[0]).toMatchObject({ from: "api:scr-b", to: "ui:scr-b" });
  });

  it("emits a data ticket for a capture-layer backend gap with data->api->ui RELATES_TO edges", () => {
    const visual = makeFinding("CHG-scr-cap-01", "visual");
    const backend = makeBackendGap("CHG-scr-cap-02", "capture");
    const doc = screenDoc("scr-cap", "Capture Screen", [visual, backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-cap"]);

    const data = plan.tickets.find((t) => t.kind === "data");
    const api = plan.tickets.find((t) => t.kind === "api");
    const ui = plan.tickets.find((t) => t.kind === "ui");
    expect(data).toBeDefined();
    expect(data!.id).toBe("data:scr-cap");
    expect(data!.unit_id).toBe("scr-cap");
    expect(data!.title).toBe("Capture and sync data for Capture Screen");
    expect(data!.criteria).toEqual(["CHG-scr-cap-02"]);
    expect(api).toBeDefined();
    expect(ui).toBeDefined();

    // The pipeline adjacencies data -> api -> ui are parallelizable RELATES_TO
    // edges, not hard blocks. No BLOCKS edge here (no shared component).
    expect(plan.relates).toContainEqual(
      expect.objectContaining({ from: "data:scr-cap", to: "api:scr-cap" }),
    );
    expect(plan.relates).toContainEqual(
      expect.objectContaining({ from: "api:scr-cap", to: "ui:scr-cap" }),
    );
    expect(plan.blocks).toHaveLength(0);
  });

  it("emits a data ticket for an ingestion-layer backend gap", () => {
    const backend = makeBackendGap("CHG-scr-ing-01", "ingestion");
    const doc = screenDoc("scr-ing", "Ingest Screen", [backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-ing"]);

    expect(plan.tickets.find((t) => t.kind === "data")).toBeDefined();
    // No UI ticket (only a backend gap), so the only edge is data -> api (RELATES_TO).
    expect(plan.tickets.find((t) => t.kind === "ui")).toBeUndefined();
    expect(plan.relates).toContainEqual(
      expect.objectContaining({ from: "data:scr-ing", to: "api:scr-ing" }),
    );
    expect(plan.relates.some((e) => e.to.startsWith("ui:"))).toBe(false);
    expect(plan.blocks).toHaveLength(0);
  });

  it("does NOT emit a data ticket when the only backend gap is serving-layer", () => {
    const backend = makeBackendGap("CHG-scr-srv-01", "serving");
    const doc = screenDoc("scr-srv", "Serving Screen", [backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-srv"]);

    expect(plan.tickets.find((t) => t.kind === "api")).toBeDefined();
    expect(plan.tickets.find((t) => t.kind === "data")).toBeUndefined();
    expect(plan.relates.some((e) => e.from.startsWith("data:"))).toBe(false);
    expect(plan.blocks.some((b) => b.from.startsWith("data:"))).toBe(false);
  });

  it("does NOT emit a data ticket when the only backend gap is model-layer", () => {
    const backend = makeBackendGap("CHG-scr-mdl-01", "model");
    const doc = screenDoc("scr-mdl", "Model Screen", [backend]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-mdl"]);

    expect(plan.tickets.find((t) => t.kind === "data")).toBeUndefined();
  });

  it("emits a data ticket once when capture and serving gaps coexist in one unit", () => {
    const capture = makeBackendGap("CHG-scr-mix-01", "capture");
    const serving = makeBackendGap("CHG-scr-mix-02", "serving");
    const doc = screenDoc("scr-mix", "Mixed Screen", [capture, serving]);
    const plan = buildTicketGraph([doc], allAcceptedDecisions(), ["scr-mix"]);

    const dataTickets = plan.tickets.filter((t) => t.kind === "data");
    expect(dataTickets).toHaveLength(1);
    // Only the capture-layer finding is the data ticket's criterion.
    expect(dataTickets[0]!.criteria).toEqual(["CHG-scr-mix-01"]);
    // The API ticket still carries BOTH backend gaps.
    const api = plan.tickets.find((t) => t.kind === "api");
    expect(api!.criteria).toEqual(["CHG-scr-mix-01", "CHG-scr-mix-02"]);
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

// ---------------------------------------------------------------------------
// Theme id uniqueness guard tests (plan-ticket-graph CLI)
// ---------------------------------------------------------------------------

describe("theme id uniqueness guard (plan-ticket-graph CLI)", () => {
  function writeTmp(dir: string, name: string, obj: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj), "utf-8");
    return p;
  }

  function makeManifest(unitIds: string[]): JsonObject {
    return { units: unitIds.map((id) => ({ id })) };
  }

  const decisionsDoc = {
    schema_version: 1,
    reviewer: "test",
    decided_at: "2026-01-01T00:00:00Z",
    decisions: {},
  };

  it("exits 1 with both unit ids when two units share the same theme id", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptg-thm-dup-"));

    // Unit A: scr-sessions-page with thm-artifact-table (from fixture)
    const docA = validFindings();
    const fpA = join(tmp, "scr-sessions-page.json");
    writeFileSync(fpA, JSON.stringify(docA), "utf-8");

    // Unit B: different unit that also declares thm-artifact-table
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
      themes: [{ id: "thm-artifact-table", title: "Adopt artifact table" }],
      findings: [],
      component_reuse: [],
      visual_spec: null,
    };
    const fpB = join(tmp, "scr-branches-page.json");
    writeFileSync(fpB, JSON.stringify(docB), "utf-8");

    const dp = writeTmp(tmp, "decisions.json", decisionsDoc);
    const mp = writeTmp(tmp, "manifest.json", makeManifest(["scr-sessions-page", "scr-branches-page"]));
    const outPath = join(tmp, "out.json");

    const errorLines: string[] = [];
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => errorLines.push(String(args[0]));
    let rc: number;
    try {
      rc = main(["--findings", fpA, "--findings", fpB, "--decisions", dp, "--manifest", mp, "--out", outPath]);
    } finally {
      console.error = origError;
    }

    expect(rc!).toBe(1);
    const combined = errorLines.join("\n");
    expect(combined).toContain("thm-artifact-table");
    expect(combined).toContain("scr-sessions-page");
    expect(combined).toContain("scr-branches-page");
  });

  it("exits 0 when two units use unit-scoped theme ids (no collision)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptg-thm-ok-"));

    // Unit A: sessions page with unit-scoped theme id
    const docA = validFindings();
    (docA["themes"] as JsonObject[])[0]!["id"] = "thm-sessions-page-artifact-table";
    (docA["findings"] as JsonObject[])[0]!["theme"] = "thm-sessions-page-artifact-table";
    const fpA = join(tmp, "scr-sessions-page.json");
    writeFileSync(fpA, JSON.stringify(docA), "utf-8");

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
      themes: [{ id: "thm-branches-page-artifact-table", title: "Adopt artifact table" }],
      findings: [],
      component_reuse: [],
      visual_spec: null,
    };
    const fpB = join(tmp, "scr-branches-page.json");
    writeFileSync(fpB, JSON.stringify(docB), "utf-8");

    const dp = writeTmp(tmp, "decisions.json", decisionsDoc);
    const mp = writeTmp(tmp, "manifest.json", makeManifest(["scr-sessions-page", "scr-branches-page"]));
    const outPath = join(tmp, "out.json");

    const rc = main(["--findings", fpA, "--findings", fpB, "--decisions", dp, "--manifest", mp, "--out", outPath]);
    expect(rc).toBe(0);
  });
});
