/**
 * Tests for build-context-pack.ts (PLN-859 Revision 2 P5).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildContextPack, main } from "./build-context-pack.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const SCREEN_UNIT = {
  id: "scr-session-detail",
  name: "Session Detail",
  type: "screen",
  files: ["screens/SessionDetail.tsx", "screens/session.css"],
  primary: "screens/SessionDetail.tsx",
  evidence: ["screen_name:screens/SessionDetail.tsx"],
};

const REGION_UNIT = {
  id: "rgn-topbar",
  name: "Topbar",
  type: "region",
  files: ["components/Topbar.tsx"],
  primary: "components/Topbar.tsx",
  evidence: ["region_name:components/Topbar.tsx"],
};

const MANIFEST = {
  units: [SCREEN_UNIT, REGION_UNIT],
  interaction_signals: {
    "screens/SessionDetail.tsx": { scroll: 3, hover: 1 },
    "unrelated/Other.tsx": { keyboard: 2 },
  },
  doc_headers: {
    "screens/SessionDetail.tsx": "Renders the session detail view.\nShows session info and controls.",
    "unrelated/Other.tsx": "Unrelated component.",
  },
  spec_overlays: [
    {
      path: "screens/SessionDetail.tsx",
      line: 10,
      kind: "inline_note",
      text: "product spec: do not implement the archive button yet",
    },
    {
      path: "unrelated/Other.tsx",
      line: 5,
      kind: "inline_note",
      text: "product spec: out of scope for now",
    },
  ],
  splits: [
    {
      path: "screens/SessionDetail.tsx",
      segments: [
        { file: "/tmp/workdir/segments/screens__SessionDetail.tsx.seg000.txt", start_line: 1, end_line: 100, bytes: 4000 },
        { file: "/tmp/workdir/segments/screens__SessionDetail.tsx.seg001.txt", start_line: 101, end_line: 200, bytes: 3500 },
      ],
    },
    {
      path: "unrelated/Other.tsx",
      segments: [
        { file: "/tmp/workdir/segments/unrelated__Other.tsx.seg000.txt", start_line: 1, end_line: 50, bytes: 1000 },
      ],
    },
  ],
};

const VISUAL_SPEC = {
  schema_version: 1,
  unit_files: ["screens/SessionDetail.tsx"],
  css_files: ["screens/session.css"],
  css_slice_rules: 5,
  colors: {
    resolved: [
      { value: "#112233", token: "--primary", count: 3, locations: ["screens/SessionDetail.tsx:10"] },
    ],
    drift: [
      { value: "#e74c3c", count: 2, nearest_token: "--destructive", distance: 1.0, locations: [] },
      { value: "#aabbcc", count: 1, nearest_token: "--muted", distance: 5.0, locations: [] },
    ],
  },
  icons: ["arrow-right", "settings"],
  layout: {
    sticky: 1,
    fixed: 0,
    scroll_regions: 1,
    grid: 0,
    flex: 2,
    utility_classes: ["flex", "sticky", "overflow-y-auto"],
  },
  state_styles: {
    hover: [".btn:hover"],
    focus: [".input:focus"],
  },
  spacing: {
    padding: ["8px 14px", "4px"],
    "border-radius": ["4px"],
  },
  typography: {
    "font-size": ["12px", "14px"],
  },
  token_sources: { files: ["globals.css"], tokens: 10 },
};

const COMPONENT_INDEX = {
  commit: "abc123",
  components: [
    {
      component: "SessionCard",
      import_path: "@repo/ui/session-card",
      story: "stories/session-card.stories.tsx",
      source_path: "packages/ui/session-card.tsx",
      props: ["sessionId", "onClose"],
      variants: ["size", "tone"],
    },
    {
      component: "Button",
      import_path: "@repo/ui/button",
      story: "stories/button.stories.tsx",
      source_path: "packages/ui/button.tsx",
      props: ["variant", "onClick"],
    },
    {
      component: "UnrelatedWidget",
      import_path: "@repo/ui/widget",
      story: "stories/widget.stories.tsx",
    },
  ],
};

const ROUTE_MAP = {
  commit: "abc123",
  routes: {
    "/session/[id]": {
      paths: ["app/(main)/session/[id]/page.tsx"],
      shared_components: ["SessionCard", "Button"],
    },
    "/settings": {
      paths: ["app/(main)/settings/page.tsx"],
      shared_components: ["SettingsForm"],
    },
  },
  chrome: {
    "/": {
      paths: ["app/layout.tsx"],
      shared_components: ["Topbar", "Sidebar"],
    },
  },
};

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeFixtures(tmpBase: string): {
  manifestPath: string;
  visualSpecPath: string;
  componentIndexPath: string;
  routeMapPath: string;
} {
  mkdirSync(tmpBase, { recursive: true });

  const manifestPath = join(tmpBase, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2), "utf-8");

  const visualSpecPath = join(tmpBase, "visual-spec.json");
  writeFileSync(visualSpecPath, JSON.stringify(VISUAL_SPEC, null, 2), "utf-8");

  const componentIndexPath = join(tmpBase, "component-index.json");
  writeFileSync(componentIndexPath, JSON.stringify(COMPONENT_INDEX, null, 2), "utf-8");

  const routeMapPath = join(tmpBase, "route-map.json");
  writeFileSync(routeMapPath, JSON.stringify(ROUTE_MAP, null, 2), "utf-8");

  return { manifestPath, visualSpecPath, componentIndexPath, routeMapPath };
}

// ---------------------------------------------------------------------------
// Tests: error cases
// ---------------------------------------------------------------------------

describe("TestErrorCases", () => {
  it("unknown unit id exits 1", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const out = join(tmpBase, "out.md");
    const rc = main(["--manifest", manifestPath, "--unit-id", "scr-does-not-exist", "--out", out]);
    expect(rc).toBe(1);
  });

  it("missing required args exits 1", () => {
    const rc = main(["--manifest", "something.json"]);
    expect(rc).toBe(1);
  });

  it("buildContextPack throws for unknown unit", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    expect(() => buildContextPack(manifestPath, "scr-does-not-exist")).toThrow("unit not found");
  });
});

// ---------------------------------------------------------------------------
// Tests: screen unit full context pack
// ---------------------------------------------------------------------------

describe("TestScreenUnitPack", () => {
  it("unit header section is present", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, visualSpecPath, componentIndexPath, routeMapPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", {
      visualSpecPath,
      componentIndexPath,
      routeMapPath,
    });
    expect(md).toContain("## Unit: Session Detail");
    expect(md).toContain("scr-session-detail");
    expect(md).toContain("screens/SessionDetail.tsx");
    expect(md).toContain("screen");
  });

  it("interaction signals section is present", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail");
    expect(md).toContain("## Interaction Signals");
    expect(md).toContain("scroll");
    expect(md).toContain("hover");
    // signals from unrelated file must not appear
    expect(md).not.toContain("keyboard");
  });

  it("doc headers section is present and verbatim", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail");
    expect(md).toContain("## Doc Headers");
    expect(md).toContain("Renders the session detail view");
    // unrelated doc header must not appear
    expect(md).not.toContain("Unrelated component");
  });

  it("spec overlays section only includes unit files", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail");
    expect(md).toContain("## Spec Overlays");
    expect(md).toContain("do not implement the archive button");
    // unrelated overlay must not appear
    expect(md).not.toContain("out of scope for now");
  });

  it("splits section lists segment paths not originals", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail");
    expect(md).toContain("## Segments (read these, not the originals)");
    // segment file paths from manifest splits
    expect(md).toContain("seg000");
    expect(md).toContain("seg001");
    // should not reference the original file path as a clickable split
    expect(md).not.toContain("unrelated__Other");
  });

  it("visual spec section has drift table and icon list", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, visualSpecPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { visualSpecPath });
    expect(md).toContain("## Visual Spec Summary");
    expect(md).toContain("1 resolved");
    expect(md).toContain("2 drift");
    expect(md).toContain("### Token Drift");
    expect(md).toContain("#e74c3c");
    expect(md).toContain("--destructive");
    expect(md).toContain("arrow-right");
    expect(md).toContain("settings");
  });

  it("component catalog has all components in compact form", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, componentIndexPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { componentIndexPath });
    expect(md).toContain("## Component Reuse Catalog");
    // compact form
    expect(md).toContain("SessionCard <- @repo/ui/session-card");
    expect(md).toContain("Button <- @repo/ui/button");
    expect(md).toContain("UnrelatedWidget <- @repo/ui/widget");
  });

  it("component detail blocks filtered by name-token matching", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, componentIndexPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { componentIndexPath });
    // "session" token in unit name matches "SessionCard"
    expect(md).toContain("### Matched Component Details");
    expect(md).toContain("**SessionCard**");
    expect(md).toContain("props: sessionId, onClose");
    expect(md).toContain("variants: size, tone");
    // "Button" does not share a token with "session detail" and is not in doc headers
    // UnrelatedWidget should definitely not appear in detail blocks
    expect(md).not.toContain("**UnrelatedWidget**");
  });

  it("route map includes matching routes for screen unit", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, routeMapPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { routeMapPath });
    expect(md).toContain("## Route Map");
    // "session" token matches "/session/[id]"
    expect(md).toContain("/session/[id]");
    // "/settings" shares no token with "Session Detail"
    expect(md).not.toContain("/settings");
  });

  it("screen unit does NOT include chrome section", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, routeMapPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { routeMapPath });
    expect(md).not.toContain("Chrome (shared layouts)");
  });
});

// ---------------------------------------------------------------------------
// Tests: region unit includes chrome section
// ---------------------------------------------------------------------------

describe("TestRegionUnitPack", () => {
  it("region unit includes chrome section", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, routeMapPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "rgn-topbar", { routeMapPath });
    expect(md).toContain("## Route Map");
    expect(md).toContain("### Chrome (shared layouts)");
    expect(md).toContain("app/layout.tsx");
    expect(md).toContain("Topbar");
    expect(md).toContain("Sidebar");
  });
});

// ---------------------------------------------------------------------------
// Tests: missing optional inputs degrade gracefully
// ---------------------------------------------------------------------------

describe("TestMissingOptionalInputs", () => {
  it("no optional inputs produces valid output without error", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail");
    expect(md).toContain("## Unit: Session Detail");
    // sections requiring optional files are absent
    expect(md).not.toContain("## Visual Spec Summary");
    expect(md).not.toContain("## Component Reuse Catalog");
    expect(md).not.toContain("## Route Map");
  });

  it("nonexistent visual spec path is silently skipped", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", {
      visualSpecPath: join(tmpBase, "no-such-file.json"),
    });
    expect(md).not.toContain("## Visual Spec Summary");
  });

  it("nonexistent component index path is silently skipped", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", {
      componentIndexPath: join(tmpBase, "no-such-file.json"),
    });
    expect(md).not.toContain("## Component Reuse Catalog");
  });

  it("nonexistent route map path is silently skipped", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", {
      routeMapPath: join(tmpBase, "no-such-file.json"),
    });
    expect(md).not.toContain("## Route Map");
  });
});

// ---------------------------------------------------------------------------
// Tests: hints section
// ---------------------------------------------------------------------------

describe("TestHintsSection", () => {
  it("hints JSON is pretty-printed in output", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const hints = JSON.stringify({ implementation: "use existing useSession hook", flags: ["beta"] });
    const md = buildContextPack(manifestPath, "scr-session-detail", { hintsJson: hints });
    expect(md).toContain("## Current Implementation Hints");
    expect(md).toContain("useSession hook");
    expect(md).toContain("beta");
  });

  it("invalid hints JSON is silently skipped", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const md = buildContextPack(manifestPath, "scr-session-detail", { hintsJson: "{not valid json" });
    expect(md).not.toContain("## Current Implementation Hints");
  });
});

// ---------------------------------------------------------------------------
// Tests: CLI
// ---------------------------------------------------------------------------

describe("TestCli", () => {
  it("CLI writes output file and prints path, returns 0", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath, visualSpecPath, componentIndexPath, routeMapPath } = makeFixtures(tmpBase);
    const out = join(tmpBase, "output", "session-detail.md");

    const written: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      written.push(args.join(" "));
    };
    const rc = main([
      "--manifest", manifestPath,
      "--unit-id", "scr-session-detail",
      "--out", out,
      "--visual-spec", visualSpecPath,
      "--component-index", componentIndexPath,
      "--route-map", routeMapPath,
    ]);
    console.log = origLog;

    expect(rc).toBe(0);
    expect(written[0]).toBe(out);
    const content = readFileSync(out, "utf-8");
    expect(content).toContain("## Unit: Session Detail");
    expect(content).toContain("## Visual Spec Summary");
    expect(content).toContain("## Component Reuse Catalog");
    expect(content).toContain("## Route Map");
  });

  it("CLI creates parent directory automatically (mkdir -p behavior)", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "bcp-"));
    const { manifestPath } = makeFixtures(tmpBase);
    const out = join(tmpBase, "deep", "nested", "dir", "out.md");
    const rc = main([
      "--manifest", manifestPath,
      "--unit-id", "scr-session-detail",
      "--out", out,
    ]);
    expect(rc).toBe(0);
    const content = readFileSync(out, "utf-8");
    expect(content).toContain("Session Detail");
  });
});
