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
