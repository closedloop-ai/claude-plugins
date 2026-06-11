/** Tests for render-review-html.ts */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { JsonObject } from "./design-findings-schema.js";
import { main } from "./render-review-html.js";
import { validFindings } from "./test-fixtures.js";

// ---------------------------------------------------------------------------
// Second findings doc fixture (component unit, chat drawer)
// ---------------------------------------------------------------------------

function chatDrawerFindings(): JsonObject {
  return {
    schema_version: 1,
    unit: {
      id: "cmp-chat-drawer",
      name: "Chat Drawer",
      type: "component",
      classification: "new",
      design_sources: ["components/ChatDrawer.jsx"],
      primary_source: "components/ChatDrawer.jsx",
      current_impl: {
        status: "not_found",
        paths: [],
      },
      reference_screenshots: [],
    },
    themes: [],
    findings: [
      {
        id: "CHG-chat-drawer-01",
        title: "Chat panel width is unspecified",
        category: "visual",
        intent: "unclear",
        intent_rationale: "no designer note for width constraint",
        theme: null,
        state: { summary: "No existing implementation", refs: [] },
        spec: { summary: "350px fixed panel", refs: ["components/ChatDrawer.jsx:42"] },
        reuse: null,
        decision: { state: "pending" },
        summary: "Define panel width before implementing",
      },
    ],
    component_reuse: [],
    visual_spec: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeDoc(dir: string, name: string, doc: JsonObject): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(doc), "utf-8");
  return p;
}

function run(argv: string[]): number {
  return main(argv);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderReviewHtml", () => {
  it("exit zero and file created", () => {
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc1 = validFindings();
    const doc2 = chatDrawerFindings();
    const f1 = writeDoc(dir, "sessions.json", doc1);
    const f2 = writeDoc(dir, "chat.json", doc2);
    const out = join(dir, "review.html");

    const code = run(["--findings", f1, "--findings", f2, "--out", out]);

    expect(code).toBe(0);
    // Verify file was created by reading it
    expect(() => readFileSync(out, "utf-8")).not.toThrow();
  });

  it("html contains both finding ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc1 = validFindings();
    const doc2 = chatDrawerFindings();
    const f1 = writeDoc(dir, "sessions.json", doc1);
    const f2 = writeDoc(dir, "chat.json", doc2);
    const out = join(dir, "review.html");

    run(["--findings", f1, "--findings", f2, "--out", out]);

    const html = readFileSync(out, "utf-8");
    expect(html).toContain("CHG-sessions-page-01");
    expect(html).toContain("CHG-chat-drawer-01");
  });

  it("theme card contains theme title", () => {
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc = validFindings();
    const f = writeDoc(dir, "sessions.json", doc);
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out]);

    const html = readFileSync(out, "utf-8");
    // Theme title from validFindings fixture
    expect(html).toContain("Adopt shared artifact-table layout");
  });

  it("unclear finding in findings section", () => {
    // CHG-chat-drawer-01 has intent=unclear and theme=null, so it appears in Findings.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc2 = chatDrawerFindings();
    const f2 = writeDoc(dir, "chat.json", doc2);
    const out = join(dir, "review.html");

    run(["--findings", f2, "--out", out]);

    const html = readFileSync(out, "utf-8");
    // The unclear finding should appear in the findings section (not only inside a theme)
    expect(html).toContain("CHG-chat-drawer-01");
    // Should have a radio group for the finding (not just inside a theme)
    expect(html).toContain('name="CHG-chat-drawer-01"');
  });

  it("likely-intentional inside theme details", () => {
    // CHG-sessions-page-01 has intent=likely-intentional and theme=thm-artifact-table.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc = validFindings();
    const f = writeDoc(dir, "sessions.json", doc);
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out]);

    const html = readFileSync(out, "utf-8");
    // The finding must appear inside theme-details (as a theme member card)
    expect(html).toContain("theme-member-card");
    expect(html).toContain("CHG-sessions-page-01");
  });

  it("theme member cards carry hidden override radio groups", () => {
    // The "Override per finding" checkbox reveals .override-radios per member;
    // without the radio group in the markup the checkbox would toggle nothing
    // and overridden members could never be exported.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const f = writeDoc(dir, "sessions.json", validFindings());
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out]);

    const html = readFileSync(out, "utf-8");
    const memberCard = html.slice(html.indexOf("theme-member-card"));
    expect(memberCard).toContain('<div class="override-radios">');
    // The member's radio group uses the finding id as the radio name and
    // starts Undecided (overrides are explicit; no pre-acceptance here).
    const overrideBlock = memberCard.slice(
      memberCard.indexOf('<div class="override-radios">'),
      memberCard.indexOf("</div></div>") + 12,
    );
    expect(overrideBlock).toContain('name="CHG-sessions-page-01"');
    expect(overrideBlock).toContain('value="undecided" checked');
  });

  it("screenshot embedded as base64", () => {
    // A PNG screenshot should be embedded as a data-uri.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    // Create a tiny fake PNG file (~100 arbitrary bytes)
    const pngPath = join(dir, "fake_screenshot.png");
    writeFileSync(pngPath, Buffer.from(Array.from({ length: 100 }, (_, i) => i % 256)));

    const doc = validFindings() as JsonObject & { unit: JsonObject };
    (doc["unit"] as JsonObject)["reference_screenshots"] = ["fake_screenshot.png"];
    const f = writeDoc(dir, "sessions.json", doc);
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out, "--screenshots-dir", dir]);

    const html = readFileSync(out, "utf-8");
    expect(html).toContain("data:image/png;base64,");
  });

  it("schema_version in export JS", () => {
    // The export JS must embed schema_version: 1.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc = validFindings();
    const f = writeDoc(dir, "sessions.json", doc);
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out]);

    const html = readFileSync(out, "utf-8");
    expect(html).toContain("schema_version");
  });

  it("invalid findings returns 1", () => {
    // A document that fails validateFindings must cause exit code 1.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const bad = validFindings();
    (bad["unit"] as JsonObject)["type"] = "page"; // invalid type
    const f = writeDoc(dir, "bad.json", bad);
    const out = join(dir, "review.html");

    const code = run(["--findings", f, "--out", out]);
    expect(code).toBe(1);
  });

  it("directory findings argument", () => {
    // Passing a directory as --findings should load all *.json files inside.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const subdir = join(dir, "docs");
    mkdirSync(subdir);

    const doc1 = validFindings();
    const doc2 = chatDrawerFindings();
    writeDoc(subdir, "sessions.json", doc1);
    writeDoc(subdir, "chat.json", doc2);
    const out = join(dir, "review.html");

    const code = run(["--findings", subdir, "--out", out]);

    expect(code).toBe(0);
    const html = readFileSync(out, "utf-8");
    expect(html).toContain("CHG-sessions-page-01");
    expect(html).toContain("CHG-chat-drawer-01");
  });

  it("decisions file in directory is skipped", () => {
    // A file with a top-level 'decisions' key should be silently skipped.
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const subdir = join(dir, "mixed");
    mkdirSync(subdir);

    writeDoc(subdir, "sessions.json", validFindings());
    // Decisions doc (should be skipped)
    const decisionsDoc: JsonObject = {
      schema_version: 1,
      reviewer: "someone",
      decided_at: "2026-01-01T00:00:00Z",
      decisions: { "thm-artifact-table": { state: "accepted" } },
    };
    writeDoc(subdir, "decisions.json", decisionsDoc);
    const out = join(dir, "review.html");

    const code = run(["--findings", subdir, "--out", out]);
    expect(code).toBe(0);
  });

  it("custom title appears in html", () => {
    const dir = mkdtempSync(join(tmpdir(), "rrh-"));
    const doc = validFindings();
    const f = writeDoc(dir, "sessions.json", doc);
    const out = join(dir, "review.html");

    run(["--findings", f, "--out", out, "--title", "My Custom Review"]);

    const html = readFileSync(out, "utf-8");
    expect(html).toContain("My Custom Review");
  });
});
