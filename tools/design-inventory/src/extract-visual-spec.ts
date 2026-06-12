/**
 * Extract a token-resolved visual spec for one design unit (PLN-859 Phase 3).
 *
 * Tickets generated from a design must carry the actual design (colors, icons,
 * spacing, positioning, interaction styles) in implementable form. This tool
 * deterministically:
 *
 * 1. Slices the unit's CSS: only rules whose selectors reference class names the
 *    unit's JSX actually uses (plus state variants of those classes).
 * 2. Extracts style facts from the slice + JSX: color literals, spacing and
 *    typography values per property, icon names, layout outline (sticky/fixed,
 *    scroll regions, grid/flex), and state-style selectors (hover/focus/active).
 * 3. Resolves color literals against the LIVE web-ui repo design system (CSS
 *    custom properties); values that match a token are reported as that token,
 *    values that match nothing become token_drift entries with the nearest
 *    token by RGB distance. Drift is inventory signal: "did you mean to change
 *    this?" -- the implementing agent must build with tokens, not raw pixels.
 *
 * Usage:
 *     node extract-visual-spec.mjs --extract-dir DIR --repo REPO \
 *         --unit-file rel.jsx [--unit-file more.jsx] --out spec.json
 *         [--slice-out slice.css]
 *
 * Prints the spec path on success. Exit codes: 0 ok, 1 usage/input error.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { parseArgs } from "node:util";

import { runWhenMain } from "./cli.js";
import { walkFiles } from "./fs-walk.js";

export const SPEC_SCHEMA_VERSION = 1;

const CLASS_ATTR = /class(?:Name)?\s*=\s*["'{]([^"'}]*)["'}]?/g;
const CLASS_TOKEN = /[A-Za-z_][\w-]*/g;
const CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;
const CSS_CLASS_IN_SELECTOR = /\.([A-Za-z_][\w-]*)/g;
const CSS_DECL = /([\w-]+)\s*:\s*([^;]+);?/g;
const CSS_VAR_DEF = /(--[\w-]+)\s*:\s*([^;]+);/g;

const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNC_COLOR = /\b(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g;
const ICON_NAME = /\bIcon\b[^>]*?\bname=["']([a-z0-9-]+)["']|data-lucide=["']([a-z0-9-]+)["']/g;

// Single-match variants (no /g flag) for fullmatch / test usage
const HEX_COLOR_SINGLE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const FUNC_COLOR_SINGLE = /\b(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/;

const SPACING_PROPS = ["margin", "padding", "gap", "border-radius", "top", "left", "right", "bottom"] as const;
const TYPOGRAPHY_PROPS = new Set(["font-family", "font-size", "font-weight", "line-height", "letter-spacing"]);
const STATE_PSEUDOS = ["hover", "focus", "focus-visible", "active", "disabled"] as const;
const LAYOUT_CLASS_HINTS = /^(?:sticky|fixed|absolute|relative|flex|grid|overflow-|snap-|scroll-|inset-|z-\d)/;
const MAX_LIST = 40;
const MAX_LOCATIONS = 5;

export interface ColorEntry {
  value: string;
  count: number;
  locations: string[];
}

export interface ResolvedColor extends ColorEntry {
  token: string;
}

export interface DriftColor extends ColorEntry {
  nearest_token?: string;
  distance?: number;
}

export interface VisualSpec {
  schema_version: number;
  unit_files: string[];
  css_files: string[];
  css_slice_rules: number;
  colors: {
    resolved: ResolvedColor[];
    drift: DriftColor[];
  };
  spacing: Record<string, string[]>;
  typography: Record<string, string[]>;
  icons: string[];
  layout: {
    sticky: number;
    fixed: number;
    scroll_regions: number;
    grid: number;
    flex: number;
    utility_classes: string[];
  };
  state_styles: Record<string, string[]>;
  token_sources: {
    files: string[];
    tokens: number;
  };
}

export function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) {
    let digits = v.slice(1);
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.split("").map((ch) => ch + ch).join("");
    }
    return "#" + digits;
  }
  return v.replace(/\s+/g, "");
}

export function hexToRgb(value: string): [number, number, number] | null {
  const v = normalizeColor(value);
  const hexMatch = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (hexMatch) {
    const h = hexMatch[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgbMatch = /^rgba?\((\d+),(\d+),(\d+)(?:,[\d.]+)?\)$/.exec(v);
  if (rgbMatch) {
    return [parseInt(rgbMatch[1]!, 10), parseInt(rgbMatch[2]!, 10), parseInt(rgbMatch[3]!, 10)];
  }
  return null;
}

function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

export function collectClassTokens(jsxText: string): Set<string> {
  const tokens = new Set<string>();
  let attrMatch: RegExpExecArray | null;
  const attrRe = new RegExp(CLASS_ATTR.source, "g");
  while ((attrMatch = attrRe.exec(jsxText)) !== null) {
    const attr = attrMatch[1] ?? "";
    const tokenRe = new RegExp(CLASS_TOKEN.source, "g");
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRe.exec(attr)) !== null) {
      tokens.add(tokenMatch[0]);
    }
  }
  // Template-literal classes: best effort, pick string fragments too.
  const fragmentRe = /["'`]([^"'`]*)["'`]/g;
  let fragMatch: RegExpExecArray | null;
  while ((fragMatch = fragmentRe.exec(jsxText)) !== null) {
    const fragment = fragMatch[1] ?? "";
    if (!fragment.includes(" ") && new RegExp(`^${CLASS_TOKEN.source}$`).test(fragment) && fragment.includes("-")) {
      tokens.add(fragment);
    }
  }
  return tokens;
}

export function sliceCss(cssText: string, usedClasses: Set<string>): Array<[string, string]> {
  const rules: Array<[string, string]> = [];
  let flattened = cssText.replace(/@media[^{]*\{/g, ""); // keep inner rules
  flattened = flattened.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = new RegExp(CSS_RULE.source, "g");
  let ruleMatch: RegExpExecArray | null;
  while ((ruleMatch = ruleRe.exec(flattened)) !== null) {
    const selector = (ruleMatch[1] ?? "").trim();
    const body = (ruleMatch[2] ?? "").trim();
    if (!selector || selector.startsWith("@")) continue;
    const classRe = new RegExp(CSS_CLASS_IN_SELECTOR.source, "g");
    const classes = new Set<string>();
    let clsMatch: RegExpExecArray | null;
    while ((clsMatch = classRe.exec(selector)) !== null) {
      classes.add(clsMatch[1]!);
    }
    const isBareRoot = selector === ":root" || selector === "html" || selector === "body";
    const intersects = classes.size > 0 && [...classes].some((c) => usedClasses.has(c));
    if (isBareRoot || intersects) {
      rules.push([selector, body]);
    }
  }
  return rules;
}

export function collectColorLocations(
  paths: Array<[string, string]>
): Map<string, ColorEntry> {
  const colors = new Map<string, ColorEntry>();
  for (const [rel, text] of paths) {
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? "";
      const lineNo = lineIdx + 1;
      // Collect all hex + func color matches
      const hexRe = new RegExp(HEX_COLOR.source, "g");
      const funcRe = new RegExp(FUNC_COLOR.source, "g");
      const allMatches: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = hexRe.exec(line)) !== null) allMatches.push(m[0]);
      while ((m = funcRe.exec(line)) !== null) allMatches.push(m[0]);
      for (const raw of allMatches) {
        const norm = normalizeColor(raw);
        let entry = colors.get(norm);
        if (!entry) {
          entry = { value: norm, count: 0, locations: [] };
          colors.set(norm, entry);
        }
        entry.count++;
        if (entry.locations.length < MAX_LOCATIONS) {
          entry.locations.push(`${rel}:${lineNo}`);
        }
      }
    }
  }
  return colors;
}

export function loadRepoTokens(repo: string): { tokens: Map<string, string>; files: string[] } {
  const tokens = new Map<string, string>();
  const files: string[] = [];
  const cssFiles = walkFiles(repo).filter((f) => f.endsWith(".css")).sort();
  for (const css of cssFiles) {
    let text: string;
    try {
      text = readFileSync(css, "utf-8");
    } catch {
      continue;
    }
    const varDefRe = new RegExp(CSS_VAR_DEF.source, "g");
    let defMatch: RegExpExecArray | null;
    const defs: Array<[string, string]> = [];
    while ((defMatch = varDefRe.exec(text)) !== null) {
      defs.push([defMatch[1]!, defMatch[2]!]);
    }
    if (defs.length === 0) continue;
    const relPath = relative(repo, css).replace(/\\/g, "/");
    files.push(relPath);
    for (const [name, raw] of defs) {
      const value = raw.trim();
      if (HEX_COLOR_SINGLE.test(value) || FUNC_COLOR_SINGLE.test(value)) {
        const norm = normalizeColor(value);
        if (!tokens.has(norm)) {
          tokens.set(norm, name);
        }
      }
    }
  }
  return { tokens, files };
}

export function resolveColors(
  colors: Map<string, ColorEntry>,
  tokens: Map<string, string>
): { resolved: ResolvedColor[]; drift: DriftColor[] } {
  const resolved: ResolvedColor[] = [];
  const drift: DriftColor[] = [];

  const tokenRgb: Array<[[number, number, number], string]> = [];
  for (const [value, name] of tokens) {
    const rgb = hexToRgb(value);
    if (rgb !== null) {
      tokenRgb.push([rgb, name]);
    }
  }

  const sortedNorms = [...colors.keys()].sort();
  for (const norm of sortedNorms) {
    const entry = colors.get(norm)!;
    const tokenName = tokens.get(norm);
    if (tokenName !== undefined) {
      resolved.push({ ...entry, token: tokenName });
      continue;
    }
    const rgb = hexToRgb(norm);
    const nearestData: { nearest_token?: string; distance?: number } = {};
    if (rgb !== null && tokenRgb.length > 0) {
      let minDist = Infinity;
      let minName = "";
      for (const [trgb, tname] of tokenRgb) {
        const d = rgbDistance(rgb, trgb);
        if (d < minDist) {
          minDist = d;
          minName = tname;
        }
      }
      nearestData.nearest_token = minName;
      nearestData.distance = Math.round(minDist * 10) / 10;
    }
    drift.push({ ...entry, ...nearestData });
  }
  return { resolved, drift };
}

export function extractDeclarations(
  rules: Array<[string, string]>
): { spacing: Record<string, string[]>; typography: Record<string, string[]> } {
  const spacingMap = new Map<string, Set<string>>();
  const typographyMap = new Map<string, Set<string>>();

  for (const [, body] of rules) {
    const declRe = new RegExp(CSS_DECL.source, "g");
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRe.exec(body)) !== null) {
      const prop = (declMatch[1] ?? "").toLowerCase();
      const value = (declMatch[2] ?? "").trim();
      const isSpacing = SPACING_PROPS.some((sp) => prop.startsWith(sp));
      if (isSpacing) {
        let set = spacingMap.get(prop);
        if (!set) { set = new Set(); spacingMap.set(prop, set); }
        set.add(value);
      } else if (TYPOGRAPHY_PROPS.has(prop)) {
        let set = typographyMap.get(prop);
        if (!set) { set = new Set(); typographyMap.set(prop, set); }
        set.add(value);
      }
    }
  }

  const spacing: Record<string, string[]> = {};
  for (const [k, v] of [...spacingMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    spacing[k] = [...v].sort().slice(0, MAX_LIST);
  }
  const typography: Record<string, string[]> = {};
  for (const [k, v] of [...typographyMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    typography[k] = [...v].sort().slice(0, MAX_LIST);
  }
  return { spacing, typography };
}

export function extractLayout(
  rules: Array<[string, string]>,
  classTokens: Set<string>
): VisualSpec["layout"] {
  const counts = { sticky: 0, fixed: 0, scroll_regions: 0, grid: 0, flex: 0 };
  for (const [, body] of rules) {
    const declRe = new RegExp(CSS_DECL.source, "g");
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRe.exec(body)) !== null) {
      const prop = (declMatch[1] ?? "").toLowerCase();
      const value = (declMatch[2] ?? "").trim().toLowerCase();
      if (prop === "position" && (value === "sticky" || value === "fixed")) {
        counts[value]++;
      } else if (prop.startsWith("overflow") && (value === "auto" || value === "scroll")) {
        counts.scroll_regions++;
      } else if (prop === "display" && (value === "grid" || value === "flex" || value === "inline-flex")) {
        counts[value === "grid" ? "grid" : "flex"]++;
      }
    }
  }
  const hints = [...classTokens]
    .filter((t) => LAYOUT_CLASS_HINTS.test(t))
    .sort()
    .slice(0, MAX_LIST);
  return { ...counts, utility_classes: hints };
}

export function extractStateStyles(rules: Array<[string, string]>): Record<string, string[]> {
  const states: Record<string, string[]> = {};
  for (const [selector] of rules) {
    for (const pseudo of STATE_PSEUDOS) {
      if (selector.includes(`:${pseudo}`)) {
        let bucket = states[pseudo];
        if (!bucket) { bucket = []; states[pseudo] = bucket; }
        if (bucket.length < MAX_LIST && !bucket.includes(selector)) {
          bucket.push(selector);
        }
      }
    }
  }
  return states;
}

export function extractIcons(jsxTexts: string[]): string[] {
  const icons = new Set<string>();
  for (const text of jsxTexts) {
    const iconRe = new RegExp(ICON_NAME.source, "g");
    let m: RegExpExecArray | null;
    while ((m = iconRe.exec(text)) !== null) {
      const name = m[1] ?? m[2] ?? "";
      if (name) icons.add(name);
    }
  }
  return [...icons].sort();
}

export function buildSpec(
  extractDir: string,
  repo: string,
  unitFiles: string[]
): { spec: VisualSpec; sliceText: string } {
  const jsxPairs: Array<[string, string]> = [];
  for (const rel of unitFiles) {
    const path = join(extractDir, rel);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`unit file not found in extract dir: ${rel}`);
    }
    jsxPairs.push([rel, readFileSync(path, "utf-8")]);
  }

  const classTokens = new Set<string>();
  for (const [, text] of jsxPairs) {
    for (const t of collectClassTokens(text)) {
      classTokens.add(t);
    }
  }

  const cssPairs: Array<[string, string]> = [];
  const seenCss = new Set<string>();
  for (const [rel] of jsxPairs) {
    const parentDir = dirname(join(extractDir, rel));
    let cssEntries: string[];
    try {
      cssEntries = readdirSync(parentDir).filter((e) => e.endsWith(".css")).sort();
    } catch {
      cssEntries = [];
    }
    for (const entry of cssEntries) {
      const full = join(parentDir, entry);
      if (seenCss.has(full)) continue;
      seenCss.add(full);
      const relCss = relative(extractDir, full).replace(/\\/g, "/");
      cssPairs.push([relCss, readFileSync(full, "utf-8")]);
    }
  }

  const sliced: Array<[string, string]> = [];
  const sliceLines: string[] = [];
  for (const [rel, text] of cssPairs) {
    const rules = sliceCss(text, classTokens);
    if (rules.length > 0) {
      sliceLines.push(`/* from ${rel} */`);
      for (const [selector, body] of rules) {
        sliced.push([selector, body]);
        sliceLines.push(`${selector} { ${body} }`);
      }
    }
  }
  const sliceText = sliceLines.join("\n") + (sliceLines.length > 0 ? "\n" : "");

  const colorSources: Array<[string, string]> = [
    ["css-slice", sliced.map(([, b]) => b).join("\n")],
    ...jsxPairs,
  ];
  const colors = collectColorLocations(colorSources);
  const { tokens, files: tokenFiles } = loadRepoTokens(repo);
  const { resolved, drift } = resolveColors(colors, tokens);
  const declarations = extractDeclarations(sliced);

  const spec: VisualSpec = {
    schema_version: SPEC_SCHEMA_VERSION,
    unit_files: unitFiles,
    css_files: cssPairs.map(([rel]) => rel),
    css_slice_rules: sliced.length,
    colors: { resolved, drift },
    spacing: declarations.spacing,
    typography: declarations.typography,
    icons: extractIcons(jsxPairs.map(([, t]) => t)),
    layout: extractLayout(sliced, classTokens),
    state_styles: extractStateStyles(sliced),
    token_sources: { files: tokenFiles, tokens: tokens.size },
  };
  return { spec, sliceText };
}

export function main(argv: string[]): number {
  let values: {
    "extract-dir"?: string;
    repo?: string;
    "unit-file"?: string[];
    out?: string;
    "slice-out"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "extract-dir": { type: "string" },
        repo: { type: "string" },
        "unit-file": { type: "string", multiple: true },
        out: { type: "string" },
        "slice-out": { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const extractDirArg = values["extract-dir"];
  const repoArg = values["repo"];
  const unitFilesArg = values["unit-file"];
  const outArg = values["out"];
  const sliceOutArg = values["slice-out"];

  if (!extractDirArg || !repoArg || !unitFilesArg || unitFilesArg.length === 0 || !outArg) {
    console.error(
      "error: --extract-dir, --repo, --unit-file (at least one), and --out are required"
    );
    return 1;
  }

  if (
    !existsSync(extractDirArg) ||
    !statSync(extractDirArg).isDirectory() ||
    !existsSync(repoArg) ||
    !statSync(repoArg).isDirectory()
  ) {
    console.error("error: --extract-dir and --repo must be directories");
    return 1;
  }

  let spec: VisualSpec;
  let sliceText: string;
  try {
    ({ spec, sliceText } = buildSpec(extractDirArg, repoArg, unitFilesArg));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  mkdirSync(dirname(outArg), { recursive: true });
  writeFileSync(outArg, JSON.stringify(spec, null, 1), "utf-8");

  if (sliceOutArg) {
    mkdirSync(dirname(sliceOutArg), { recursive: true });
    writeFileSync(sliceOutArg, sliceText, "utf-8");
  }

  console.log(outArg);
  return 0;
}

runWhenMain(import.meta.url, main);
