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

// Plain string-literal classNames: className="a b" or className='a b'.
const CLASS_ATTR_STRING = /class(?:Name)?\s*=\s*(["'])([^"']*)\1/g;
// Expression classNames: className={ ...anything... }. Captures the full brace
// body so we can mine every quoted string literal inside (the conditional
// modifier pattern, e.g. {"st-msg " + (cond ? "left st-hasav" : "right")}).
// Allows one level of nested braces (template-literal interpolations, nested
// objects) which covers the common cases.
const CLASS_ATTR_EXPR = /class(?:Name)?\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
// Quoted string literals inside an expression value (single, double, backtick).
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
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

// Interaction-capture bounds: the actual interaction CSS (state-style rule
// bodies, transition/animation declarations, referenced @keyframes) is inlined
// into the ticket body, so it must stay bounded. Cap both the number of rules
// and the total text recorded; when either is hit, keep the first N and flag
// truncation so the renderer can say so.
const MAX_INTERACTION_RULES = 40;
const MAX_INTERACTION_CHARS = 8192;
// Animation/transition properties whose values we surface verbatim. Matched by
// prefix so the shorthand and every longhand (transition-property,
// animation-name, ...) are captured.
const ANIMATION_PROP_PREFIXES = ["transition", "animation"] as const;
// @keyframes NAME { ... }; the body capture allows nested {} (the from/to or
// percentage frames each carry their own brace block).
const KEYFRAMES_RULE = /@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

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

export interface StateRule {
  pseudo: string;
  selector: string;
  declarations: string;
}

export interface TransitionEntry {
  selector: string;
  declaration: string;
}

export interface KeyframesEntry {
  name: string;
  body: string;
}

export interface Interactions {
  state_rules: StateRule[];
  transitions: TransitionEntry[];
  keyframes: KeyframesEntry[];
  truncated: boolean;
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
  interactions: Interactions;
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

function addClassTokens(value: string, tokens: Set<string>): void {
  const tokenRe = new RegExp(CLASS_TOKEN.source, "g");
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(value)) !== null) {
    tokens.add(tokenMatch[0]);
  }
}

export function collectClassTokens(jsxText: string): Set<string> {
  const tokens = new Set<string>();

  // Plain string-literal classNames: className="a b" / className='a b'.
  // The whole attribute value is class tokens; split on whitespace via CLASS_TOKEN.
  const stringAttrRe = new RegExp(CLASS_ATTR_STRING.source, "g");
  let stringMatch: RegExpExecArray | null;
  while ((stringMatch = stringAttrRe.exec(jsxText)) !== null) {
    addClassTokens(stringMatch[2] ?? "", tokens);
  }

  // Expression classNames: className={...}. Mine every quoted string literal
  // inside the expression body and tokenize each as class tokens. This recovers
  // the conditional modifier pattern, e.g.
  //   className={"st-msg " + (cond ? "left st-hasav" : "right")}
  // where the literals "st-msg ", "left st-hasav", and "right" all contribute
  // class tokens. Over-inclusion (a stray non-class word from a text literal) is
  // harmless for slicing: no CSS rule will match it. Under-inclusion drops real
  // rules, so we bias to inclusion.
  const exprAttrRe = new RegExp(CLASS_ATTR_EXPR.source, "g");
  let exprMatch: RegExpExecArray | null;
  while ((exprMatch = exprAttrRe.exec(jsxText)) !== null) {
    const body = exprMatch[1] ?? "";
    // String literals contribute static class names; expressions without any
    // (e.g. className={styles.foo} or className={cls}) yield nothing to recover.
    const literalRe = new RegExp(STRING_LITERAL.source, "g");
    let literalMatch: RegExpExecArray | null;
    while ((literalMatch = literalRe.exec(body)) !== null) {
      addClassTokens(literalMatch[2] ?? "", tokens);
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

function pseudoOf(selector: string): string | null {
  for (const pseudo of STATE_PSEUDOS) {
    if (selector.includes(`:${pseudo}`)) {
      return pseudo;
    }
  }
  return null;
}

/**
 * Collect the animation-name(s) a transition/animation declaration references so
 * the matching @keyframes block can be surfaced. The `animation` shorthand puts
 * the name among other tokens (duration, timing, etc.); we take every identifier
 * token as a candidate and let the @keyframes name lookup filter out the ones
 * (durations, timing keywords) that match no defined keyframes block.
 */
function animationNamesFrom(prop: string, value: string): string[] {
  if (prop !== "animation" && prop !== "animation-name") {
    return [];
  }
  const names: string[] = [];
  const tokenRe = new RegExp(CLASS_TOKEN.source, "g");
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(value)) !== null) {
    names.push(tokenMatch[0]);
  }
  return names;
}

/**
 * Capture the actual interaction CSS the designer expressed -- not just that a
 * state exists but what it does:
 *
 * - state_rules: every sliced rule whose selector carries a state pseudo
 *   (:hover/:focus/:focus-visible/:active/:disabled), with its declaration block.
 * - transitions: every `transition`/`animation` declaration (shorthand or
 *   longhand) in the slice, paired with its selector.
 * - keyframes: each @keyframes block in the slice that is referenced by an
 *   `animation`/`animation-name` declaration, with its full body.
 *
 * Bounded by MAX_INTERACTION_RULES and MAX_INTERACTION_CHARS across the combined
 * captured text; on overflow the first entries are kept and `truncated` is set.
 */
export function extractInteractions(
  rules: Array<[string, string]>,
  rawCssText: string
): Interactions {
  const stateRules: StateRule[] = [];
  const transitions: TransitionEntry[] = [];
  const referencedKeyframes = new Set<string>();
  let charBudget = MAX_INTERACTION_CHARS;
  let truncated = false;

  const tryAdd = (cost: number): boolean => {
    const total = stateRules.length + transitions.length;
    if (total >= MAX_INTERACTION_RULES || cost > charBudget) {
      truncated = true;
      return false;
    }
    charBudget -= cost;
    return true;
  };

  for (const [selector, body] of rules) {
    const pseudo = pseudoOf(selector);
    if (pseudo !== null) {
      const declarations = body.trim();
      if (tryAdd(selector.length + declarations.length)) {
        stateRules.push({ pseudo, selector, declarations });
      }
    }
    const declRe = new RegExp(CSS_DECL.source, "g");
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRe.exec(body)) !== null) {
      const prop = (declMatch[1] ?? "").toLowerCase();
      const value = (declMatch[2] ?? "").trim();
      const isAnimation = ANIMATION_PROP_PREFIXES.some((p) => prop === p || prop.startsWith(`${p}-`));
      if (!isAnimation) {
        continue;
      }
      const declaration = `${prop}: ${value}`;
      if (tryAdd(selector.length + declaration.length)) {
        transitions.push({ selector, declaration });
      }
      for (const name of animationNamesFrom(prop, value)) {
        referencedKeyframes.add(name);
      }
    }
  }

  const keyframes: KeyframesEntry[] = [];
  if (referencedKeyframes.size > 0) {
    const keyframesRe = new RegExp(KEYFRAMES_RULE.source, "g");
    let kfMatch: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((kfMatch = keyframesRe.exec(rawCssText)) !== null) {
      const name = kfMatch[1] ?? "";
      const body = (kfMatch[2] ?? "").trim();
      if (!referencedKeyframes.has(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      if (tryAdd(name.length + body.length)) {
        keyframes.push({ name, body });
      }
    }
  }

  return { state_rules: stateRules, transitions, keyframes, truncated };
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
  // Keyframes blocks are not in the sliced rules (selectors starting with "@"
  // are skipped by sliceCss), so resolve referenced @keyframes against the raw
  // CSS text of the unit's stylesheets.
  const rawCssText = cssPairs.map(([, text]) => text).join("\n");

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
    interactions: extractInteractions(sliced, rawCssText),
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
