/**
 * Tests for extract-visual-spec.ts (port of test_extract_visual_spec.py).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSpec,
  collectClassTokens,
  extractInteractions,
  hexToRgb,
  main,
  normalizeColor,
  sliceCss,
} from "./extract-visual-spec.js";

const UNIT_JSX = `
function SessTopbar() {
  return (
    <div className="sess-topbar sticky z-10 flex overflow-x-auto">
      <Icon name="hand" size={11} />
      <span className="sess-awaiting-chip" style={{ color: "#112233" }}>7 awaiting</span>
      <button className="pin-btn" data-lucide="pin" />
    </div>
  );
}
`;

const UNIT_CSS = `
/* topbar chrome */
.sess-topbar { position: sticky; top: 0; padding: 8px 14px; background: #112233; display: flex; }
.sess-topbar .sess-awaiting-chip { color: #e74c3c; border-radius: 999px; font-size: 12px; }
.sess-awaiting-chip:hover { background: rgba(231, 76, 60, 0.1); }
.pin-btn:focus { outline: 2px solid #112233; }
.unrelated-class { color: #00ff00; margin: 40px; }
@media (max-width: 600px) {
  .sess-topbar { padding: 4px; }
}
`;

const REPO_TOKENS_CSS = `
:root {
  --primary: #112233;
  --destructive: #e74c3d;
  --surface: rgb(250, 250, 250);
}
`;

function makeFixture(tmpPath: string): { extractDir: string; repo: string } {
  const extractDir = join(tmpPath, "extracted");
  mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
  writeFileSync(join(extractDir, "ui_kits/app/SessTopbar.jsx"), UNIT_JSX, "utf-8");
  writeFileSync(join(extractDir, "ui_kits/app/sess.css"), UNIT_CSS, "utf-8");

  const repo = join(tmpPath, "repo");
  mkdirSync(join(repo, "packages/design-system"), { recursive: true });
  writeFileSync(join(repo, "packages/design-system/globals.css"), REPO_TOKENS_CSS, "utf-8");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules/junk.css"), ":root { --evil: #00ff00; }", "utf-8");

  return { extractDir, repo };
}

function specFor(tmpPath: string): ReturnType<typeof buildSpec>["spec"] {
  const { extractDir, repo } = makeFixture(tmpPath);
  const { spec } = buildSpec(extractDir, repo, ["ui_kits/app/SessTopbar.jsx"]);
  return spec;
}

describe("TestNormalization", () => {
  it("normalize_color", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("rgba(1, 2, 3, 0.5)")).toBe("rgba(1,2,3,0.5)");
  });

  it("hex_to_rgb", () => {
    expect(hexToRgb("#112233")).toEqual([17, 34, 51]);
    expect(hexToRgb("rgb(1,2,3)")).toEqual([1, 2, 3]);
    expect(hexToRgb("oklch(0.7 0.1 200)")).toBeNull();
  });
});

describe("TestCollectClassTokens", () => {
  it("plain_string_classname_tokens", () => {
    const tokens = collectClassTokens('<div className="sess-topbar sticky flex" />');
    expect(tokens.has("sess-topbar")).toBe(true);
    expect(tokens.has("sticky")).toBe(true);
    expect(tokens.has("flex")).toBe(true);
  });

  it("expression_conditional_classname_tokens", () => {
    // Regression: the conditional modifier pattern. The old extractor stopped the
    // attribute capture at the first quote inside {...} and dropped these tokens,
    // so rules like .st-msg.left were sliced away from every ticket.
    const jsx = '<div className={"st-msg " + (x ? "left st-hasav" : "right")}>hi</div>';
    const tokens = collectClassTokens(jsx);
    expect(tokens.has("st-msg")).toBe(true);
    expect(tokens.has("left")).toBe(true);
    expect(tokens.has("right")).toBe(true);
    expect(tokens.has("st-hasav")).toBe(true);
  });

  it("expression_without_string_literals_yields_nothing", () => {
    const tokens = collectClassTokens("<div className={styles.foo} />");
    expect(tokens.size).toBe(0);
  });
});

describe("TestCssSlice", () => {
  it("slice_keeps_only_used_classes_and_roots", () => {
    const rules = sliceCss(UNIT_CSS, new Set(["sess-topbar", "sess-awaiting-chip", "pin-btn"]));
    const selectors = rules.map(([s]) => s);
    expect(selectors).toContain(".sess-topbar");
    expect(selectors).toContain(".pin-btn:focus");
    expect(selectors.every((s) => !s.includes("unrelated-class"))).toBe(true);
    // media-query inner rule survives flattening
    expect(selectors.filter((s) => s === ".sess-topbar").length).toBe(2);
  });

  it("expression_classname_keeps_conditional_modifier_rules", () => {
    // End-to-end: tokens mined from an expression className must let sliceCss keep
    // the base rule and all compound modifier rules. Without the extraction fix
    // these four rules were dropped from every slice (and thus every ticket).
    const jsx = '<div className={"st-msg " + (x ? "left st-hasav" : "right")}>hi</div>';
    const css =
      ".st-msg{display:flex}" +
      ".st-msg.left{justify-content:flex-start}" +
      ".st-msg.right{justify-content:flex-end}" +
      ".st-msg.st-hasav{gap:8px}";
    const tokens = collectClassTokens(jsx);
    const selectors = sliceCss(css, tokens).map(([s]) => s);
    expect(selectors).toContain(".st-msg");
    expect(selectors).toContain(".st-msg.left");
    expect(selectors).toContain(".st-msg.right");
    expect(selectors).toContain(".st-msg.st-hasav");
    expect(selectors.length).toBe(4);
  });
});

describe("TestSpec", () => {
  it("token_resolution_and_drift", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const spec = specFor(tmpPath);

    const resolved = new Map(spec.colors.resolved.map((c) => [c.value, c]));
    expect(resolved.get("#112233")?.token).toBe("--primary");
    expect((resolved.get("#112233")?.count ?? 0) >= 2).toBe(true); // css + jsx style

    const drift = new Map(spec.colors.drift.map((c) => [c.value, c]));
    expect(drift.has("#e74c3c")).toBe(true);
    expect(drift.get("#e74c3c")?.nearest_token).toBe("--destructive");
    expect(drift.get("#e74c3c")?.distance).toBe(1.0);

    // excluded node_modules token never resolves anything
    expect(resolved.has("#00ff00")).toBe(false);
    expect(spec.token_sources.tokens).toBe(3);
  });

  it("unrelated_css_does_not_leak_into_drift", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const spec = specFor(tmpPath);
    const driftValues = new Set(spec.colors.drift.map((c) => c.value));
    expect(driftValues.has("#00ff00")).toBe(false); // sliced away with .unrelated-class
  });

  it("icons_layout_and_state_styles", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const spec = specFor(tmpPath);
    expect(spec.icons).toEqual(["hand", "pin"]);
    expect(spec.layout.sticky >= 1).toBe(true);
    expect(spec.layout.flex >= 1).toBe(true);
    expect(spec.layout.utility_classes).toContain("sticky");
    expect(spec.layout.utility_classes).toContain("overflow-x-auto");
    expect((spec.state_styles["hover"] ?? []).some((s) => s.includes("hover"))).toBe(true);
    expect((spec.state_styles["focus"] ?? []).some((s) => s.includes("focus"))).toBe(true);
  });

  it("spacing_and_typography", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const spec = specFor(tmpPath);
    expect(spec.spacing["padding"]).toContain("8px 14px");
    expect(spec.spacing["border-radius"]).toContain("999px");
    expect(spec.typography["font-size"]).toContain("12px");
    expect((spec.spacing["margin"] ?? []).includes("40px")).toBe(false); // unrelated rule sliced away
  });
});

const INTERACTIONS_JSX = `
function Anim() {
  return (
    <div className="x y z">interactive</div>
  );
}
`;

const INTERACTIONS_CSS = `
.x:hover { background: var(--card); }
.y { transition: transform .2s ease; }
.z { animation: flash 1.1s; }
@keyframes flash { from { opacity: 0; } to { opacity: 1; } }
.unused { color: red; }
@keyframes unused-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
`;

function interactionsSpecFor(tmpPath: string): ReturnType<typeof buildSpec>["spec"] {
  const extractDir = join(tmpPath, "extracted");
  mkdirSync(join(extractDir, "ui_kits/app"), { recursive: true });
  writeFileSync(join(extractDir, "ui_kits/app/Anim.jsx"), INTERACTIONS_JSX, "utf-8");
  writeFileSync(join(extractDir, "ui_kits/app/anim.css"), INTERACTIONS_CSS, "utf-8");
  const repo = join(tmpPath, "repo");
  mkdirSync(repo, { recursive: true });
  const { spec } = buildSpec(extractDir, repo, ["ui_kits/app/Anim.jsx"]);
  return spec;
}

describe("TestInteractions", () => {
  it("captures state rule declarations, not just selectors", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-int-"));
    const spec = interactionsSpecFor(tmpPath);
    const hoverRule = spec.interactions.state_rules.find((r) => r.selector === ".x:hover");
    expect(hoverRule).toBeDefined();
    expect(hoverRule?.pseudo).toBe("hover");
    expect(hoverRule?.declarations).toContain("background: var(--card)");
  });

  it("captures transition declarations with their selector", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-int-"));
    const spec = interactionsSpecFor(tmpPath);
    const transition = spec.interactions.transitions.find((t) => t.selector === ".y");
    expect(transition).toBeDefined();
    expect(transition?.declaration).toBe("transition: transform .2s ease");
    // The animation shorthand on .z is also captured as a transition/animation decl.
    expect(spec.interactions.transitions.some((t) => t.declaration.startsWith("animation:"))).toBe(true);
  });

  it("captures a referenced @keyframes body and skips unreferenced ones", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-int-"));
    const spec = interactionsSpecFor(tmpPath);
    const flash = spec.interactions.keyframes.find((k) => k.name === "flash");
    expect(flash).toBeDefined();
    expect(flash?.body).toContain("opacity: 0");
    expect(flash?.body).toContain("opacity: 1");
    // unused-spin is not referenced by any animation declaration in the slice.
    expect(spec.interactions.keyframes.some((k) => k.name === "unused-spin")).toBe(false);
  });

  it("flags truncation when the rule cap is exceeded", () => {
    const rules: Array<[string, string]> = [];
    for (let i = 0; i < 60; i++) {
      rules.push([`.r${i}:hover`, `color: #${(i % 9) + 1}${(i % 9) + 1}${(i % 9) + 1}`]);
    }
    const interactions = extractInteractions(rules, "");
    expect(interactions.truncated).toBe(true);
    expect(interactions.state_rules.length).toBeLessThanOrEqual(40);
  });

  it("empty when the slice has no interaction CSS", () => {
    const interactions = extractInteractions([[".plain", "color: red"]], "");
    expect(interactions.state_rules).toEqual([]);
    expect(interactions.transitions).toEqual([]);
    expect(interactions.keyframes).toEqual([]);
    expect(interactions.truncated).toBe(false);
  });
});

describe("TestCli", () => {
  it("cli_writes_spec_and_slice", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const { extractDir, repo } = makeFixture(tmpPath);
    const out = join(tmpPath, "out/visual-spec.json");
    const sliceOut = join(tmpPath, "out/slice.css");

    const rc = main([
      "--extract-dir", extractDir,
      "--repo", repo,
      "--unit-file", "ui_kits/app/SessTopbar.jsx",
      "--out", out,
      "--slice-out", sliceOut,
    ]);
    expect(rc).toBe(0);

    const spec = JSON.parse(readFileSync(out, "utf-8")) as { schema_version: number };
    expect(spec.schema_version).toBe(1);

    const sliceText = readFileSync(sliceOut, "utf-8");
    expect(sliceText).toContain(".sess-topbar");
    expect(sliceText).not.toContain("unrelated-class");
  });

  it("cli_missing_unit_file_returns_1", () => {
    const tmpPath = mkdtempSync(join(tmpdir(), "evs-"));
    const { extractDir, repo } = makeFixture(tmpPath);
    const rc = main([
      "--extract-dir", extractDir,
      "--repo", repo,
      "--unit-file", "nope.jsx",
      "--out", join(tmpPath, "x.json"),
    ]);
    expect(rc).toBe(1);
  });
});
