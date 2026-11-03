/** Shared test fixtures for the design-inventory script suites. */

import type { JsonObject } from "./design-findings-schema.js";

export function validFindings(): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: "scr-sessions-page",
      name: "Sessions Page",
      type: "screen",
      classification: "existing-modified",
      design_sources: ["ui_kits/app/SessionsPage.jsx", "SessionsPage.jsx"],
      primary_source: "ui_kits/app/SessionsPage.jsx",
      current_impl: {
        status: "found",
        route: "/[orgSlug]/sessions",
        paths: ["apps/app/app/(authenticated)/[orgSlug]/sessions/page.tsx"],
      },
      feature_flag: { required: false, flag: null, notes: "" },
      reference_screenshots: ["screenshots/real-sessions.png"],
      spec_overlay_notes: null,
      duplication_note: "root copy is an earlier draft",
    },
    themes: [{ id: "thm-artifact-table", title: "Adopt shared artifact-table layout" }],
    findings: [
      {
        id: "CHG-sessions-page-01",
        title: "Topbar replaces page header",
        category: "visual",
        intent: "likely-intentional",
        intent_rationale: "designer note calls for sess-topbar",
        theme: "thm-artifact-table",
        state: { summary: "Header + Card shell", refs: ["apps/app/.../page.tsx:86"] },
        spec: { summary: "sticky sess-topbar", refs: ["ui_kits/app/SessionsPage.jsx:1430"] },
        reuse: {
          resolution: "new-component",
          proposed_name: "ArtifactTopbar",
          closest_existing: "TableViewMenu",
        },
        decision: { state: "pending" },
        summary: "Replace page header with sticky topbar",
        recommendation: {
          action: "accept",
          rationale: "designer note explicitly calls for the sess-topbar",
        },
      },
      {
        id: "CHG-sessions-page-02",
        title: "Status badge reused",
        category: "component-divergence",
        intent: "unclear",
        intent_rationale: "restyle may be unintentional",
        theme: null,
        state: { summary: "SessionStatusBadge", refs: [] },
        spec: { summary: "custom chip", refs: ["ui_kits/app/SessionsPage.jsx:1329"] },
        reuse: {
          resolution: "reuse",
          component: "SessionStatusBadge",
          import_path: "@repo/design-system/components/ui/primitives/status-badge",
          story: "apps/storybook/stories/agent-status-badges.stories.tsx",
        },
        decision: { state: "pending" },
        summary: "Use existing SessionStatusBadge",
      },
    ],
    component_reuse: [
      {
        element: "Status badge",
        resolution: "reuse",
        component: "SessionStatusBadge",
        import_path: "@repo/design-system/components/ui/primitives/status-badge",
      },
    ],
    visual_spec: null,
  };
}

/**
 * A backend-gap finding carrying a valid `data_flow` provenance block. Every
 * backend-gap finding in the fixtures MUST set `data_flow` (the schema requires
 * it), so tests build them through this helper. `gapLayer` selects the branch:
 * "capture"/"ingestion" gaps set captured/ingested false and drive a separate
 * data-source ticket; "serving"/"model" gaps leave the data already captured and
 * ingested so no data-source ticket is emitted.
 */
export function backendGapFinding(
  id: string,
  gapLayer: "capture" | "ingestion" | "model" | "serving" | "unknown",
  overrides: Partial<JsonObject> = {},
): JsonObject {
  const upstreamMissing = gapLayer === "capture" || gapLayer === "ingestion";
  return {
    id,
    title: `Backend gap ${id}`,
    category: "backend-gap",
    intent: "likely-intentional",
    intent_rationale: "the UI reads data the backend does not serve today",
    theme: null,
    state: { summary: "No endpoint serves this data", refs: [] },
    spec: { summary: "UI reads a per-session token-cost figure", refs: [] },
    data_flow: {
      gap_layer: gapLayer,
      origin: "apps/desktop agent harness session telemetry",
      // capture/ingestion gaps: the raw data is not produced/synced yet.
      captured_today: !upstreamMissing,
      ingested_today: !upstreamMissing,
      refs: ["apps/desktop/src/server/operations/run-session.ts"],
    },
    decision: { state: "pending" },
    summary: `Capture and serve data for ${id}`,
    recommendation: {
      action: "accept",
      rationale: "the design depends on data the platform does not provide yet",
    },
    ...overrides,
  };
}

/**
 * A findings doc that carries BOTH a capture-layer backend-gap (captured_today
 * false, drives a data-source ticket) and a serving-layer backend-gap
 * (captured_today/ingested_today true, no data-source ticket) so downstream
 * tests can exercise both provenance branches. The base `validFindings()`
 * fixture deliberately has no backend-gap findings so the many tests asserting
 * its exact two-finding shape stay green.
 */
export function validFindingsWithBackendGaps(): JsonObject {
  const doc = validFindings();
  (doc["unit"] as JsonObject)["id"] = "scr-cost-page";
  (doc["unit"] as JsonObject)["name"] = "Cost Page";
  const findings = doc["findings"] as JsonObject[];
  // Re-id the existing visual/component findings to match the new unit slug.
  findings[0]!["id"] = "CHG-cost-page-01";
  findings[1]!["id"] = "CHG-cost-page-02";
  // Capture-layer gap: the raw figure is not produced at the source yet.
  findings.push(backendGapFinding("CHG-cost-page-03", "capture"));
  // Serving-layer gap: the data is captured and ingested; only an endpoint is missing.
  findings.push(backendGapFinding("CHG-cost-page-04", "serving"));
  return doc;
}

export function validDecisions(): JsonObject {
  return {
    schema_version: 1,
    reviewer: "daniel.ochoa@closedloop.ai",
    decided_at: "2026-06-10T22:00:00Z",
    decisions: {
      "thm-artifact-table": { state: "accepted" },
      "CHG-sessions-page-02": { state: "declined", note: "keep existing styling" },
    },
  };
}
