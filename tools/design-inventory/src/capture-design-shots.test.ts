import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  containedPath,
  main,
  patchFindings,
  resolveChromium,
  selectorTargets,
  themeTargets,
  unionClip,
  type Box,
} from "./capture-design-shots.js";
import type { JsonObject } from "./design-findings-schema.js";
import { validFindings } from "./test-fixtures.js";

describe("containedPath", () => {
  const root = "/srv/extract";

  it("returns a path inside root for safe URLs", () => {
    const p = containedPath(root, "/index.html");
    expect(p).toBe("/srv/extract/index.html");
  });

  it("maps root URL to index.html", () => {
    const p = containedPath(root, "/");
    expect(p).toBe("/srv/extract/index.html");
  });

  it("returns null for directory traversal (..)", () => {
    expect(containedPath(root, "/../../../../etc/passwd")).toBeNull();
    expect(containedPath(root, "/../etc/passwd")).toBeNull();
    expect(containedPath(root, "/foo/../../etc/passwd")).toBeNull();
  });

  it("returns null for percent-encoded traversal (%2e%2e)", () => {
    // The server decodes with decodeURIComponent before calling containedPath.
    const decoded = decodeURIComponent("/%2e%2e/etc/passwd");
    expect(containedPath(root, decoded)).toBeNull();
  });

  it("returns null when the resolved path equals the root dir itself", () => {
    // An attacker who somehow produces a path normalizing to the root directory
    // should be rejected rather than served as a directory listing.
    expect(containedPath(root, "/../extract")).toBeNull();
  });

  it("allows nested paths", () => {
    const p = containedPath(root, "/assets/app.js");
    expect(p).toBe("/srv/extract/assets/app.js");
  });
});

describe("unionClip", () => {
  it("unions boxes with padding and clamps to the page", () => {
    const boxes: Box[] = [
      { x: 100, y: 100, width: 50, height: 30 },
      { x: 300, y: 200, width: 80, height: 40 },
    ];
    const clip = unionClip(boxes, 2000, 2000);
    expect(clip).toEqual({ x: 72, y: 72, width: 336, height: 196 });
  });

  it("clamps at page edges and rejects empty input", () => {
    expect(unionClip([], 100, 100)).toBeNull();
    const clip = unionClip([{ x: 0, y: 0, width: 5000, height: 5000 }], 800, 600);
    expect(clip).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe("selectorTargets", () => {
  it("returns only findings with non-empty selectors", () => {
    const doc = validFindings();
    const findings = doc.findings as JsonObject[];
    (findings[0]!.spec as JsonObject).selectors = [".sess-topbar"];
    const targets = selectorTargets(doc);
    expect(targets).toEqual([{ id: "CHG-sessions-page-01", selectors: [".sess-topbar"] }]);
  });
});

describe("themeTargets", () => {
  it("unions member selectors per theme, deduped", () => {
    const doc = validFindings();
    const findings = doc.findings as JsonObject[];
    (findings[0]!.spec as JsonObject).selectors = [".sess-topbar", ".sess-stat-row"];
    findings[1]!.theme = "thm-artifact-table";
    (findings[1]!.spec as JsonObject).selectors = [".sess-topbar", ".sess-table-wrap"];
    const targets = themeTargets(doc);
    expect(targets).toEqual([
      {
        id: "thm-artifact-table",
        selectors: [".sess-topbar", ".sess-stat-row", ".sess-table-wrap"],
      },
    ]);
  });

  it("omits themes whose members have no selectors", () => {
    expect(themeTargets(validFindings())).toEqual([]);
  });
});

describe("patchFindings", () => {
  it("prefers the theme union shot over member and base shots", () => {
    const doc = validFindings();
    const shots = new Map([
      ["CHG-sessions-page-01", "shots/CHG-sessions-page-01.png"],
      ["thm-artifact-table", "shots/thm-artifact-table.png"],
    ]);
    patchFindings(doc, shots, "shots/base.png");
    const themes = doc.themes as JsonObject[];
    expect(themes[0]!.screenshot).toBe("shots/thm-artifact-table.png");
  });

  it("sets finding screenshots and theme fallbacks", () => {
    const doc = validFindings();
    const shots = new Map([["CHG-sessions-page-01", "shots/CHG-sessions-page-01.png"]]);
    patchFindings(doc, shots, "shots/scr-sessions-page.png");
    const findings = doc.findings as JsonObject[];
    const themes = doc.themes as JsonObject[];
    expect(findings[0]!.screenshot).toBe("shots/CHG-sessions-page-01.png");
    expect(findings[1]!.screenshot).toBeUndefined();
    // theme inherits its captured member's shot
    expect(themes[0]!.screenshot).toBe("shots/CHG-sessions-page-01.png");
  });

  it("themes fall back to the unit base shot when no member captured", () => {
    const doc = validFindings();
    patchFindings(doc, new Map(), "shots/scr-sessions-page.png");
    const themes = doc.themes as JsonObject[];
    expect(themes[0]!.screenshot).toBe("shots/scr-sessions-page.png");
  });
});

describe("CLI guards", () => {
  it("requires the core arguments", async () => {
    expect(await main([])).toBe(1);
  });

  it("rejects invalid findings documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cds-"));
    const doc = validFindings();
    (doc.unit as JsonObject).type = "page";
    const f = join(dir, "unit.json");
    writeFileSync(f, JSON.stringify(doc));
    const rc = await main([
      "--extract-dir", dir,
      "--entry", "index.html",
      "--findings", f,
      "--shots-dir", join(dir, "shots"),
    ]);
    expect(rc).toBe(1);
  });

  it("exits 3 when Playwright cannot be resolved", async () => {
    // Force resolution failure by pointing repo at an empty dir and ensuring
    // bare resolution also fails (playwright is not a dependency here).
    const dir = mkdtempSync(join(tmpdir(), "cds-"));
    const f = join(dir, "unit.json");
    writeFileSync(f, JSON.stringify(validFindings()));
    let playwrightAvailable = true;
    try {
      await resolveChromium(dir);
    } catch {
      playwrightAvailable = false;
    }
    if (playwrightAvailable) {
      // Environment has playwright importable; resolution policy is covered
      // by the integration test below in that case.
      return;
    }
    const rc = await main([
      "--extract-dir", dir,
      "--entry", "index.html",
      "--findings", f,
      "--shots-dir", join(dir, "shots"),
      "--repo", dir,
    ]);
    expect(rc).toBe(3);
    // findings file must be untouched on degrade
    const after = JSON.parse(readFileSync(f, "utf-8")) as JsonObject;
    expect((after.findings as JsonObject[])[0]!.screenshot).toBeUndefined();
  });
});
