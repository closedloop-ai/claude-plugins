/**
 * Tests for design-export-extract.ts.
 * Ported 1:1 from test_design_export_extract.py.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import {
  UnsafeArchiveError,
  buildManifest,
  classifyRegion,
  extractDocHeader,
  main,
  routeToName,
  safeExtract,
  slugify,
} from "./design-export-extract.js";

// ---------------------------------------------------------------------------
// Test content fixtures
// ---------------------------------------------------------------------------

const SESSIONS_PAGE = `
import React from "react";

export default function Sessions() {
  return (
    <div className="overflow-y-auto hover:bg-gray-100" onScroll={handleScroll}>
      <div draggable onDragStart={onDragStart} onDrop={onDrop}>
        <Tooltip content="Session" />
      </div>
    </div>
  );
}
`;

const APP_TSX = `
import { Routes, Route } from "react-router-dom";

// Designer note: comment bar restyle is exploratory, confirm before building.
export default function App() {
  return (
    <Routes>
      <Route path="/sessions" element={<Sessions />} />
      <Route path="/session-trace" element={<SessionTrace />} />
    </Routes>
  );
}
`;

const INDEX_HTML = "<html><head><title>Symphony Web</title></head><body></body></html>";
const SPEC_NOTES = "# Product spec\n\nSessions list should keep the existing comment bar.";

const UI_KIT_INDEX = `<html><head><title>ClosedLoop UI Kit</title></head><body>
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
<script src="Primitives.jsx"></script>
<script src="Sidebar.jsx"></script>
<script src="SessionsPage.jsx"></script>
<script src="SessionTraceQuiet.jsx"></script>
</body></html>`;

const PAGE_WITH_HEADER = `// ClosedLoop App: Sessions screen
//
// Layout:
//   - aggregate summary tiles across the top
//   - a 12-column table of all sessions

const { useState } = React;
function SessionsPage() { return null; }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fflate zip buffer from a name->content map. */
function makeZipBuffer(members: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(members)) {
    input[name] = new TextEncoder().encode(content);
  }
  return zipSync(input);
}

/** Create a zip file on disk and return the path. */
function makeZipFile(dir: string, name: string, members: Record<string, string>): string {
  const zipPath = join(dir, name);
  writeFileSync(zipPath, makeZipBuffer(members));
  return zipPath;
}

const DEFAULT_MEMBERS: Record<string, string> = {
  "index.html": INDEX_HTML,
  "src/App.tsx": APP_TSX,
  "src/pages/Sessions.tsx": SESSIONS_PAGE,
  "src/components/CommentBar.tsx": "export const CommentBar = () => null;\n",
  "docs/design-notes.md": SPEC_NOTES,
};

function makeExportZip(dir: string, extra?: Record<string, string>): string {
  const members = { ...DEFAULT_MEMBERS, ...extra };
  return makeZipFile(dir, "design-export.zip", members);
}

function loadManifest(
  zipPath: string,
  outDir: string,
  options: { maxChunkBytes?: number } = {}
): ReturnType<typeof JSON.parse> {
  mkdirSync(outDir, { recursive: true });
  const manifestPath = buildManifest(
    zipPath,
    outDir,
    options.maxChunkBytes ?? 200_000
  );
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

/** Build a raw (crafted) zip with a single entry. Allows unsafe names. */
function makeRawZip(entryName: string, content: string): Buffer {
  const contentBuf = Buffer.from(content);
  const nameBytes = Buffer.from(entryName);

  // Local file header (uncompressed/stored, no CRC for simplicity)
  const localHeader = Buffer.alloc(30 + nameBytes.length + contentBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // compression (stored)
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc32
  localHeader.writeUInt32LE(contentBuf.length, 18); // compressed size
  localHeader.writeUInt32LE(contentBuf.length, 22); // uncompressed size
  localHeader.writeUInt16LE(nameBytes.length, 26); // filename length
  localHeader.writeUInt16LE(0, 28); // extra length
  nameBytes.copy(localHeader, 30);
  contentBuf.copy(localHeader, 30 + nameBytes.length);

  // Central directory record
  const centralDir = Buffer.alloc(46 + nameBytes.length);
  centralDir.writeUInt32LE(0x02014b50, 0);
  centralDir.writeUInt16LE(20, 4);
  centralDir.writeUInt16LE(20, 6);
  centralDir.writeUInt16LE(0, 8);
  centralDir.writeUInt16LE(0, 10);
  centralDir.writeUInt16LE(0, 12);
  centralDir.writeUInt16LE(0, 14);
  centralDir.writeUInt32LE(0, 16);
  centralDir.writeUInt32LE(contentBuf.length, 20);
  centralDir.writeUInt32LE(contentBuf.length, 24);
  centralDir.writeUInt16LE(nameBytes.length, 28);
  centralDir.writeUInt16LE(0, 30); // extra length
  centralDir.writeUInt16LE(0, 32); // comment length
  centralDir.writeUInt16LE(0, 34); // disk start
  centralDir.writeUInt16LE(0, 36); // int attributes
  centralDir.writeUInt32LE(0, 38); // ext attributes
  centralDir.writeUInt32LE(0, 42); // local header offset
  nameBytes.copy(centralDir, 46);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // total entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localHeader.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localHeader, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// TestSafeExtract
// ---------------------------------------------------------------------------

describe("TestSafeExtract", () => {
  it("rejects parent traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-safe-"));
    const evilZip = join(dir, "evil.zip");
    writeFileSync(evilZip, makeRawZip("../evil.txt", "pwned"));
    const extractDir = join(dir, "extract");
    mkdirSync(extractDir, { recursive: true });
    expect(() => safeExtract(evilZip, extractDir)).toThrow(UnsafeArchiveError);
    expect(() => safeExtract(evilZip, extractDir)).toThrow(/unsafe path/);
  });

  it("rejects absolute paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-safe-abs-"));
    const evilZip = join(dir, "evil.zip");
    writeFileSync(evilZip, makeRawZip("/tmp/evil.txt", "pwned"));
    const extractDir = join(dir, "extract");
    mkdirSync(extractDir, { recursive: true });
    expect(() => safeExtract(evilZip, extractDir)).toThrow(UnsafeArchiveError);
  });

  it("extracts nested files", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-safe-nested-"));
    const zipPath = makeExportZip(dir);
    const extractDir = join(dir, "extract");
    const extracted = safeExtract(zipPath, extractDir);
    const rels = new Set(
      extracted.map((p) => p.slice(extractDir.length + 1).replace(/\\/g, "/"))
    );
    expect(rels).toContain("src/pages/Sessions.tsx");
    expect(rels).toContain("index.html");
  });
});

// ---------------------------------------------------------------------------
// TestScreenDetection
// ---------------------------------------------------------------------------

describe("TestScreenDetection", () => {
  it("detects html route and page screens", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-screen-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const screens: Record<string, unknown> = {};
    for (const s of manifest.screens) {
      screens[s.id] = s;
    }
    expect(screens["scr-symphony-web"]).toBeDefined();
    expect(screens["scr-sessions"]).toBeDefined();
    expect(screens["scr-session-trace"]).toBeDefined();
  });

  it("merges route and directory evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-screen-merge-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const sessions = manifest.screens.find((s: { id: string }) => s.id === "scr-sessions");
    expect(sessions.evidence).toContain("route:/sessions");
    expect(sessions.evidence.some((e: string) => e.startsWith("screen_dir:"))).toBe(true);
    expect(sessions.files).toContain("src/pages/Sessions.tsx");
  });

  it("component outside screen dirs is not a screen", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-screen-nocomp-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const ids = new Set(manifest.screens.map((s: { id: string }) => s.id));
    expect(ids.has("scr-comment-bar")).toBe(false);
  });

  it("route_to_name", () => {
    expect(routeToName("/sessions/:id")).toBe("Sessions");
    expect(routeToName("/")).toBe("Home");
    expect(routeToName("/session-trace")).toBe("Session Trace");
  });
});

// ---------------------------------------------------------------------------
// TestInteractionSignals
// ---------------------------------------------------------------------------

describe("TestInteractionSignals", () => {
  it("detects behavioral signals", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-signals-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const signals = manifest.interaction_signals["src/pages/Sessions.tsx"];
    expect(signals.scroll).toBeGreaterThanOrEqual(2);
    expect(signals.hover).toBeGreaterThanOrEqual(1);
    expect(signals.drag_drop).toBeGreaterThanOrEqual(3);
    expect(signals.tooltip_popover).toBeGreaterThanOrEqual(1);
  });

  it("files without signals are omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-signals-omit-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    expect(manifest.interaction_signals["src/components/CommentBar.tsx"]).toBeUndefined();
  });

  it("detects scroll sync and pointer drag", () => {
    const scrubber =
      "const scrollToRow = (i) => { sc.scrollTop += delta; };\n" +
      "<div onPointerDown={startScrub} />\n" +
      "<div onScroll={onTraceScroll} />\n";
    const extra = { "ui_kits/app/TraceQuiet.jsx": scrubber };
    const dir = mkdtempSync(join(tmpdir(), "dee-signals-drag-"));
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    const signals = manifest.interaction_signals["ui_kits/app/TraceQuiet.jsx"];
    expect(signals.scroll).toBeGreaterThanOrEqual(3);
    expect(signals.pointer_drag).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TestSpecOverlays
// ---------------------------------------------------------------------------

describe("TestSpecOverlays", () => {
  it("detects overlay file and inline note", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-overlays-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const overlays: Array<{ path: string; kind: string; text: string }> = manifest.spec_overlays;
    const kinds = new Set(overlays.map((o) => `${o.path}|${o.kind}`));
    expect(kinds.has("docs/design-notes.md|overlay_file")).toBe(true);
    expect(kinds.has("src/App.tsx|inline_note")).toBe(true);
    const inline = overlays.find((o) => o.kind === "inline_note");
    expect(inline?.text).toContain("Designer note");
  });
});

// ---------------------------------------------------------------------------
// TestSplitting
// ---------------------------------------------------------------------------

describe("TestSplitting", () => {
  it("splits large file at boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-split-"));
    const big = Array.from({ length: 50 }, (_, i) =>
      `export function Component${i}() {\n  return null; // ${"x".repeat(80)}\n}\n`
    ).join("");

    const zipPath = makeExportZip(dir, { "src/big-bundle.tsx": big });
    const workdir = join(dir, "out");
    const manifestPath = buildManifest(zipPath, workdir, 1_000);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const split = manifest.splits.find(
      (s: { path: string }) => s.path === "src/big-bundle.tsx"
    );
    expect(split).toBeDefined();
    expect(split.segments.length).toBeGreaterThan(1);

    const reassembled = split.segments
      .map((seg: { file: string }) => readFileSync(seg.file, "utf-8"))
      .join("");
    expect(reassembled).toBe(big);

    for (const seg of split.segments) {
      expect((seg as { bytes: number }).bytes).toBeLessThanOrEqual(2_000);
    }
  });

  it("small files are not split", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-nosplit-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    expect(manifest.splits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TestCli
// ---------------------------------------------------------------------------

describe("TestCli", () => {
  it("cli writes manifest and prints path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-cli-"));
    const zipPath = makeExportZip(dir);
    const workdir = join(dir, "cli-out");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logs.push(msg); };
    const code = main([zipPath, "--workdir", workdir]);
    console.log = origLog;
    expect(code).toBe(0);
    expect(logs.length).toBe(1);
    const printed = (logs[0] ?? "").trim();
    expect(printed).toBe(join(workdir, "manifest.json"));
    expect(() => readFileSync(printed)).not.toThrow();
  });

  it("cli missing zip returns 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-cli-miss-"));
    const origErr = console.error;
    console.error = () => {};
    const code = main([join(dir, "nope.zip")]);
    console.error = origErr;
    expect(code).toBe(1);
  });

  it("cli not a zip returns 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-cli-notzip-"));
    const bogus = join(dir, "bogus.zip");
    writeFileSync(bogus, "not a zip", "utf-8");
    const origErr = console.error;
    console.error = () => {};
    const code = main([bogus]);
    console.error = origErr;
    expect(code).toBe(1);
  });

  it("cli unsafe zip returns 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-cli-evil-"));
    const evilZip = join(dir, "evil.zip");
    writeFileSync(evilZip, makeRawZip("../evil.txt", "pwned"));
    const origErr = console.error;
    console.error = () => {};
    const code = main([evilZip, "--workdir", join(dir, "out")]);
    console.error = origErr;
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TestRegions
// ---------------------------------------------------------------------------

describe("TestRegions", () => {
  it("classify_region", () => {
    expect(classifyRegion("_ds/bundle/_ds_bundle.js")).toBe("design_system");
    expect(classifyRegion("screenshots/real-sessions.png")).toBe("reference_images");
    expect(classifyRegion("uploads/ref.png")).toBe("reference_images");
    expect(classifyRegion("fonts/Geist-Bold.otf")).toBe("assets");
    expect(classifyRegion("ui_kits/app/SessionsPage.jsx")).toBe("source");
    expect(classifyRegion("nested/screenshots/x.png")).toBe("reference_images");
  });

  it("design system excluded from signals and headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-regions-ds-"));
    const extra = {
      "_ds/bundle.js": "// design system\nel.onMouseEnter = hover; // :hover\n",
      "fonts/Geist-Bold.otf": "binary\x00data",
    };
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    expect(manifest.interaction_signals["_ds/bundle.js"]).toBeUndefined();
    expect(manifest.doc_headers["_ds/bundle.js"]).toBeUndefined();

    const byRegion = manifest.totals.by_region;
    expect(byRegion.design_system).toBe(1);
    expect(byRegion.assets).toBe(1);

    const regions: Record<string, string> = {};
    for (const f of manifest.files) {
      regions[f.path] = f.region;
    }
    expect(regions["_ds/bundle.js"]).toBe("design_system");
    expect(regions["src/App.tsx"]).toBe("source");
  });
});

// ---------------------------------------------------------------------------
// TestScriptTagRegistry
// ---------------------------------------------------------------------------

describe("TestScriptTagRegistry", () => {
  it("registry html yields screen components not itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-registry-"));
    const extra = {
      "ui_kits/app/index.html": UI_KIT_INDEX,
      "ui_kits/app/Primitives.jsx": "const P = 1;\n",
      "ui_kits/app/Sidebar.jsx": "const S = 1;\n",
      "ui_kits/app/SessionsPage.jsx": PAGE_WITH_HEADER,
      "ui_kits/app/SessionTraceQuiet.jsx": "function SessionTraceQuiet() {}\n",
    };
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    const screens: Record<string, unknown> = {};
    for (const s of manifest.screens) {
      screens[s.id] = s;
    }
    // Registry page is not a screen itself
    expect(screens["scr-closedloop-ui-kit"]).toBeUndefined();
    const sessionsPage = screens["scr-sessions-page"] as {
      evidence: string[];
      files: string[];
    };
    expect(sessionsPage).toBeDefined();
    expect(sessionsPage.evidence).toContain("script_tag:ui_kits/app/index.html");
    expect(sessionsPage.files).toContain("ui_kits/app/SessionsPage.jsx");
    expect(screens["scr-session-trace-quiet"]).toBeDefined();
    expect(screens["scr-primitives"]).toBeUndefined();
    expect(screens["scr-sidebar"]).toBeUndefined();
  });

  it("top level screen named component detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-registry-toplevel-"));
    const extra = { "BranchesPage.jsx": "function BranchesPage() {}\n" };
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    const branches = manifest.screens.find(
      (s: { id: string }) => s.id === "scr-branches-page"
    );
    expect(branches).toBeDefined();
    expect(branches.evidence).toContain("screen_name:BranchesPage.jsx");
  });

  it("primary is largest copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-registry-primary-"));
    const extra = {
      "BranchesPage.jsx": "function BranchesPage() {}\n",
      "ui_kits/app/BranchesPage.jsx":
        "function BranchesPage() {}\n" + "// pad\n".repeat(50),
    };
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    const branches = manifest.screens.find(
      (s: { id: string }) => s.id === "scr-branches-page"
    );
    expect(branches).toBeDefined();
    expect(branches.files.length).toBe(2);
    expect(branches.primary).toBe("ui_kits/app/BranchesPage.jsx");
  });
});

// ---------------------------------------------------------------------------
// TestDocHeaders
// ---------------------------------------------------------------------------

describe("TestDocHeaders", () => {
  it("extract doc header line comments", () => {
    const header = extractDocHeader(PAGE_WITH_HEADER);
    expect(header).not.toBeNull();
    expect(header).toContain("Sessions screen");
    expect(header).toContain("12-column table");
    expect(header).not.toContain("useState");
  });

  it("extract doc header block comment", () => {
    const header = extractDocHeader(
      "/* Branches overview\n * with drag/drop */\ncode();\n"
    );
    expect(header).toBe("Branches overview\nwith drag/drop");
  });

  it("no header returns null", () => {
    expect(extractDocHeader("const x = 1;\n// trailing comment\n")).toBeNull();
  });

  it("manifest includes doc headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-headers-"));
    const extra = { "ui_kits/app/SessionsPage.jsx": PAGE_WITH_HEADER };
    const manifest = loadManifest(makeExportZip(dir, extra), join(dir, "out"));
    expect(manifest.doc_headers["ui_kits/app/SessionsPage.jsx"]).toContain("Sessions screen");
  });
});

// ---------------------------------------------------------------------------
// TestUnitTyping
// ---------------------------------------------------------------------------

describe("TestUnitTyping", () => {
  function makeCustomZip(dir: string, members: Record<string, string>): string {
    return makeZipFile(dir, "design-export.zip", members);
  }

  it("full export units include typed screens and components", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-units-full-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const units: Record<string, { type: string; primary: string; evidence: string[] }> = {};
    for (const u of manifest.units) {
      units[u.id] = u;
    }
    expect(units["scr-sessions"]?.type).toBe("screen");
    expect(units["scr-sessions"]?.primary).toBeDefined();
    expect(units["cmp-comment-bar"]?.type).toBe("component");
    expect(units["cmp-comment-bar"]?.evidence).toContain(
      "component:src/components/CommentBar.tsx"
    );
    // screens key is screen-typed subset
    const screenIds = new Set(manifest.screens.map((s: { id: string }) => s.id));
    const unitScreenIds = new Set(
      manifest.units
        .filter((u: { type: string }) => u.type === "screen")
        .map((u: { id: string }) => u.id)
    );
    expect(screenIds).toEqual(unitScreenIds);
  });

  it("nav bar only export yields region unit", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-units-nav-"));
    const zipPath = makeCustomZip(dir, {
      "Sidebar.jsx": "function Sidebar() { return null; }\n",
    });
    const manifest = loadManifest(zipPath, join(dir, "out"));
    expect(manifest.screens).toEqual([]);
    expect(manifest.units.length).toBe(1);
    const unit = manifest.units[0];
    expect(unit.id).toBe("rgn-sidebar");
    expect(unit.type).toBe("region");
    expect(unit.primary).toBe("Sidebar.jsx");
  });

  it("component only export yields component unit", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-units-cmp-"));
    const zipPath = makeCustomZip(dir, {
      "ChatDrawer.jsx": "function ChatDrawer() { return null; }\n",
    });
    const manifest = loadManifest(zipPath, join(dir, "out"));
    expect(manifest.screens).toEqual([]);
    expect(manifest.units.length).toBe(1);
    const unit = manifest.units[0];
    expect(unit.id).toBe("cmp-chat-drawer");
    expect(unit.type).toBe("component");
  });

  it("data and lowercase modules are not units", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-units-data-"));
    const zipPath = makeCustomZip(dir, {
      "AgentsData.jsx": "const AG = {};\n",
      "doc-sample-data.js": "const d = {};\n",
      "ChatDrawer.jsx": "function ChatDrawer() {}\n",
    });
    const manifest = loadManifest(zipPath, join(dir, "out"));
    const ids = new Set(manifest.units.map((u: { id: string }) => u.id));
    expect(ids).toEqual(new Set(["cmp-chat-drawer"]));
  });

  it("screen files are not double claimed as components", () => {
    const dir = mkdtempSync(join(tmpdir(), "dee-units-nodbl-"));
    const manifest = loadManifest(makeExportZip(dir), join(dir, "out"));
    const ids = new Set(manifest.units.map((u: { id: string }) => u.id));
    expect(ids.has("cmp-app")).toBe(false);
    expect(ids.has("cmp-sessions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestSlugify
// ---------------------------------------------------------------------------

describe("TestSlugify", () => {
  it("slugify normalizes", () => {
    expect(slugify("Session Trace")).toBe("session-trace");
    expect(slugify("  ")).toBe("screen");
  });
});
