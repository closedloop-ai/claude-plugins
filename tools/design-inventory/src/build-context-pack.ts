/**
 * Build a single-file context pack for one design unit (PLN-859 Revision 2 P5).
 *
 * Analysts currently spend 10-20 turns extracting their unit's context from large
 * shared files. This tool pre-assembles ONE markdown file per unit so the analyst
 * reads a single file. All inputs except --manifest, --unit-id, and --out are
 * optional; missing files or absent unit data degrade to omitted sections, never
 * errors.
 *
 * Sections produced (in order):
 *   1. Unit header (id, name, type, files, primary, evidence)
 *   2. Interaction signals for the unit's files
 *   3. Doc headers for the unit's files (verbatim, fenced)
 *   4. Spec overlays whose path is one of the unit's files
 *   5. Splits (segment file paths for the unit's files)
 *   6. Current implementation hints (from --hints JSON)
 *   7. Visual spec summary (from --visual-spec JSON)
 *   8. Component reuse catalog (from --component-index JSON)
 *   9. Route map entries (from --route-map JSON)
 *
 * Usage:
 *     node build-context-pack.mjs --manifest <manifest.json> --unit-id <id> \
 *         --out <file.md> [--visual-spec <spec.json>] \
 *         [--route-map <route-map.json>] \
 *         [--component-index <component-index.json>] \
 *         [--hints <inline JSON string>]
 *
 * Prints the output path on success. Exit codes: 0 ok, 1 error.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { runWhenMain } from "./cli.js";

// ---------------------------------------------------------------------------
// Types (wire-format shapes read from JSON)
// ---------------------------------------------------------------------------

interface DesignUnit {
  id: string;
  name: string;
  type: string;
  files: string[];
  primary: string;
  evidence: string[];
}

interface Manifest {
  units: DesignUnit[];
  interaction_signals: Record<string, Record<string, number>>;
  doc_headers: Record<string, string>;
  spec_overlays: Array<{ path: string; line: number; kind: string; text: string }>;
  splits: Array<{ path: string; segments: Array<{ file: string }> }>;
}

interface VisualSpec {
  colors: {
    resolved: Array<{ value: string; token: string; count: number }>;
    drift: Array<{ value: string; uses?: number; count?: number; nearest_token?: string }>;
  };
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
  spacing: Record<string, string[]>;
  typography: Record<string, string[]>;
}

interface ComponentEntry {
  component: string;
  import_path: string;
  story: string;
  source_path?: string;
  props?: string[];
  variants?: string[];
}

interface ComponentIndex {
  components: ComponentEntry[];
}

interface RouteEntry {
  paths: string[];
  shared_components: string[];
}

interface RouteMap {
  routes: Record<string, RouteEntry>;
  chrome: Record<string, RouteEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_DRIFT_ROWS = 30;
const MAX_DETAIL_BLOCKS = 15;

/** Safely parse a JSON file; returns null on any failure. */
function tryReadJson(filePath: string | undefined): unknown {
  if (!filePath) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Extract word tokens (lowercase, 3+ chars) from a string.
 * Splits on camelCase boundaries, hyphens, underscores, spaces, and slashes
 * before collecting tokens, so "SessionCard" yields both "session" and "card".
 */
function wordTokens(str: string): Set<string> {
  // Insert a separator before each uppercase letter that follows a lowercase letter (camelCase split)
  const spaced = str.replace(/([a-z])([A-Z])/g, "$1 $2");
  const tokens = new Set<string>();
  for (const m of spaced.matchAll(/[a-zA-Z]{3,}/g)) {
    tokens.add(m[0]!.toLowerCase());
  }
  return tokens;
}

/** Return true if any token in `aTokens` appears in `bTokens`. */
function sharesToken(aTokens: Set<string>, bTokens: Set<string>): boolean {
  for (const t of aTokens) {
    if (bTokens.has(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildUnitHeaderSection(unit: DesignUnit): string {
  const lines: string[] = [
    `## Unit: ${unit.name}`,
    "",
    `- **id**: ${unit.id}`,
    `- **type**: ${unit.type}`,
    `- **primary**: ${unit.primary || "(none)"}`,
    `- **files**:`,
  ];
  for (const f of unit.files) {
    lines.push(`  - ${f}`);
  }
  lines.push(`- **evidence**:`);
  for (const e of unit.evidence) {
    lines.push(`  - ${e}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildSignalsSection(
  unit: DesignUnit,
  signals: Record<string, Record<string, number>>,
): string | null {
  const unitFiles = new Set(unit.files);
  const relevant: Array<[string, Record<string, number>]> = [];
  for (const [path, sig] of Object.entries(signals)) {
    if (unitFiles.has(path) && Object.keys(sig).length > 0) {
      relevant.push([path, sig]);
    }
  }
  if (relevant.length === 0) return null;

  const lines: string[] = ["## Interaction Signals", ""];
  for (const [path, sig] of relevant) {
    lines.push(`**${path}**`);
    for (const [name, count] of Object.entries(sig)) {
      lines.push(`- ${name}: ${count}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildDocHeadersSection(
  unit: DesignUnit,
  docHeaders: Record<string, string>,
): string | null {
  const unitFiles = new Set(unit.files);
  const relevant: Array<[string, string]> = [];
  for (const [path, header] of Object.entries(docHeaders)) {
    if (unitFiles.has(path)) {
      relevant.push([path, header]);
    }
  }
  if (relevant.length === 0) return null;

  const lines: string[] = ["## Doc Headers", ""];
  for (const [path, header] of relevant) {
    lines.push(`**${path}**`);
    lines.push("```");
    lines.push(header);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function buildOverlaysSection(
  unit: DesignUnit,
  overlays: Array<{ path: string; line: number; kind: string; text: string }>,
): string | null {
  const unitFiles = new Set(unit.files);
  const relevant = overlays.filter((o) => unitFiles.has(o.path));
  if (relevant.length === 0) return null;

  const lines: string[] = ["## Spec Overlays", ""];
  for (const o of relevant) {
    lines.push(`- **${o.path}** (line ${o.line}, kind: ${o.kind})`);
    lines.push(`  > ${o.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildSplitsSection(
  unit: DesignUnit,
  splits: Array<{ path: string; segments: Array<{ file: string }> }>,
): string | null {
  const unitFiles = new Set(unit.files);
  const relevant = splits.filter((s) => unitFiles.has(s.path));
  if (relevant.length === 0) return null;

  const lines: string[] = ["## Segments (read these, not the originals)", ""];
  for (const s of relevant) {
    lines.push(`**${s.path}**`);
    for (const seg of s.segments) {
      lines.push(`- ${seg.file}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildHintsSection(hintsJson: string | undefined): string | null {
  if (!hintsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(hintsJson) as unknown;
  } catch {
    return null;
  }
  const pretty = JSON.stringify(parsed, null, 2);
  return ["## Current Implementation Hints", "", "```json", pretty, "```", ""].join("\n");
}

function buildVisualSpecSection(spec: VisualSpec): string {
  const lines: string[] = ["## Visual Spec Summary", ""];

  // Color counts
  const resolvedCount = spec.colors.resolved.length;
  const driftCount = spec.colors.drift.length;
  lines.push(`**Colors**: ${resolvedCount} resolved, ${driftCount} drift`);
  lines.push("");

  // Drift table (cap 30 rows)
  if (driftCount > 0) {
    lines.push("### Token Drift");
    lines.push("");
    lines.push("| value | uses | nearest token |");
    lines.push("| --- | --- | --- |");
    const rows = spec.colors.drift.slice(0, MAX_DRIFT_ROWS);
    for (const d of rows) {
      const uses = d.uses ?? d.count ?? 0;
      const nearest = d.nearest_token ?? "(none)";
      lines.push(`| ${d.value} | ${uses} | ${nearest} |`);
    }
    lines.push("");
  }

  // Icons
  if (spec.icons.length > 0) {
    lines.push(`**Icons**: ${spec.icons.join(", ")}`);
    lines.push("");
  }

  // Layout
  const lo = spec.layout;
  const layoutFacts = [
    `sticky=${lo.sticky}`,
    `fixed=${lo.fixed}`,
    `scroll_regions=${lo.scroll_regions}`,
    `grid=${lo.grid}`,
    `flex=${lo.flex}`,
  ].join(", ");
  lines.push(`**Layout**: ${layoutFacts}`);
  if (lo.utility_classes.length > 0) {
    lines.push(`**Utility classes**: ${lo.utility_classes.join(", ")}`);
  }
  lines.push("");

  // State styles
  const stateKeys = Object.keys(spec.state_styles);
  if (stateKeys.length > 0) {
    lines.push(`**State styles**: ${stateKeys.map((k) => `${k} (${(spec.state_styles[k] ?? []).length})`).join(", ")}`);
    lines.push("");
  }

  // Spacing
  const spacingKeys = Object.keys(spec.spacing);
  if (spacingKeys.length > 0) {
    lines.push(`**Spacing**: ${spacingKeys.map((k) => `${k}: ${(spec.spacing[k] ?? []).join(", ")}`).join("; ")}`);
    lines.push("");
  }

  // Typography
  const typographyKeys = Object.keys(spec.typography);
  if (typographyKeys.length > 0) {
    lines.push(`**Typography**: ${typographyKeys.map((k) => `${k}: ${(spec.typography[k] ?? []).join(", ")}`).join("; ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildComponentSection(
  unit: DesignUnit,
  index: ComponentIndex,
  unitDocHeaders: string[],
): string {
  const components = index.components;

  // Compact catalog: all components as "Name <- import_path" (no story paths)
  const lines: string[] = ["## Component Reuse Catalog", ""];
  lines.push("### All Components");
  lines.push("");
  for (const c of components) {
    lines.push(`${c.component} <- ${c.import_path}`);
  }
  lines.push("");

  // Detail blocks: only components whose lowercase name shares a word-token
  // with the unit name OR appears as a substring in any unit doc_header.
  const unitNameTokens = wordTokens(unit.name);
  const allDocHeaderText = unitDocHeaders.join(" ").toLowerCase();

  const matchedComponents: ComponentEntry[] = [];
  for (const c of components) {
    const componentNameTokens = wordTokens(c.component);
    const nameMatches = sharesToken(unitNameTokens, componentNameTokens);
    const substringMatches = allDocHeaderText.includes(c.component.toLowerCase());
    if (nameMatches || substringMatches) {
      matchedComponents.push(c);
    }
    if (matchedComponents.length >= MAX_DETAIL_BLOCKS) break;
  }

  if (matchedComponents.length > 0) {
    lines.push("### Matched Component Details");
    lines.push("");
    for (const c of matchedComponents) {
      lines.push(`**${c.component}**`);
      lines.push(`- import: \`${c.import_path}\``);
      lines.push(`- story: ${c.story}`);
      if (c.source_path !== undefined) {
        lines.push(`- source: ${c.source_path}`);
      }
      if (c.props !== undefined && c.props.length > 0) {
        lines.push(`- props: ${c.props.join(", ")}`);
      }
      if (c.variants !== undefined && c.variants.length > 0) {
        lines.push(`- variants: ${c.variants.join(", ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildRouteMapSection(
  unit: DesignUnit,
  routeMap: RouteMap,
): string {
  const unitNameTokens = wordTokens(unit.name);

  // Keep route entries whose path or paths mention any word-token of the unit name
  const matchedRoutes: Array<[string, RouteEntry]> = [];
  for (const [routeKey, entry] of Object.entries(routeMap.routes)) {
    const allPaths = [routeKey, ...entry.paths].join(" ").toLowerCase();
    const allPathTokens = wordTokens(allPaths);
    if (sharesToken(unitNameTokens, allPathTokens)) {
      matchedRoutes.push([routeKey, entry]);
    }
  }

  // Include the entire chrome section when unit type is "region"
  const includeChrome = unit.type === "region";

  if (matchedRoutes.length === 0 && !includeChrome) return "";

  const lines: string[] = ["## Route Map", ""];

  if (matchedRoutes.length > 0) {
    lines.push("### Matching Routes");
    lines.push("");
    for (const [routeKey, entry] of matchedRoutes) {
      lines.push(`**${routeKey}**`);
      for (const p of entry.paths) {
        lines.push(`- path: ${p}`);
      }
      if (entry.shared_components.length > 0) {
        lines.push(`- components: ${entry.shared_components.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (includeChrome) {
    const chromeKeys = Object.keys(routeMap.chrome);
    if (chromeKeys.length > 0) {
      lines.push("### Chrome (shared layouts)");
      lines.push("");
      for (const [key, entry] of Object.entries(routeMap.chrome)) {
        lines.push(`**${key}**`);
        for (const p of entry.paths) {
          lines.push(`- path: ${p}`);
        }
        if (entry.shared_components.length > 0) {
          lines.push(`- components: ${entry.shared_components.join(", ")}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a context-pack markdown string for a single design unit.
 *
 * @param manifestPath - Path to manifest.json
 * @param unitId - Unit id to look up in manifest.units
 * @param opts - Optional enrichment inputs
 * @returns The markdown string
 * @throws Error if unit not found in manifest
 */
export function buildContextPack(
  manifestPath: string,
  unitId: string,
  opts: {
    visualSpecPath?: string;
    routeMapPath?: string;
    componentIndexPath?: string;
    hintsJson?: string;
  } = {},
): string {
  const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;

  const unit = (manifestRaw.units ?? []).find((u) => u.id === unitId);
  if (!unit) {
    throw new Error(`unit not found: ${unitId}`);
  }

  const sections: string[] = [];

  sections.push(`# Context Pack: ${unit.name}\n`);
  sections.push(buildUnitHeaderSection(unit));

  // Interaction signals
  const signalsSection = buildSignalsSection(unit, manifestRaw.interaction_signals ?? {});
  if (signalsSection) sections.push(signalsSection);

  // Doc headers
  const docHeadersSection = buildDocHeadersSection(unit, manifestRaw.doc_headers ?? {});
  if (docHeadersSection) sections.push(docHeadersSection);

  // Gather raw doc header strings for later component matching
  const unitDocHeaders: string[] = [];
  for (const f of unit.files) {
    const h = (manifestRaw.doc_headers ?? {})[f];
    if (h) unitDocHeaders.push(h);
  }

  // Spec overlays
  const overlaysSection = buildOverlaysSection(unit, manifestRaw.spec_overlays ?? []);
  if (overlaysSection) sections.push(overlaysSection);

  // Splits
  const splitsSection = buildSplitsSection(unit, manifestRaw.splits ?? []);
  if (splitsSection) sections.push(splitsSection);

  // Hints
  const hintsSection = buildHintsSection(opts.hintsJson);
  if (hintsSection) sections.push(hintsSection);

  // Visual spec
  const rawSpec = tryReadJson(opts.visualSpecPath);
  if (rawSpec !== null) {
    sections.push(buildVisualSpecSection(rawSpec as VisualSpec));
  }

  // Component index
  const rawIndex = tryReadJson(opts.componentIndexPath);
  if (rawIndex !== null) {
    sections.push(buildComponentSection(unit, rawIndex as ComponentIndex, unitDocHeaders));
  }

  // Route map
  const rawRouteMap = tryReadJson(opts.routeMapPath);
  if (rawRouteMap !== null) {
    const routeSection = buildRouteMapSection(unit, rawRouteMap as RouteMap);
    if (routeSection) sections.push(routeSection);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  let values: {
    manifest?: string;
    "unit-id"?: string;
    out?: string;
    "visual-spec"?: string;
    "route-map"?: string;
    "component-index"?: string;
    hints?: string;
  };

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        manifest: { type: "string" },
        "unit-id": { type: "string" },
        out: { type: "string" },
        "visual-spec": { type: "string" },
        "route-map": { type: "string" },
        "component-index": { type: "string" },
        hints: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const manifestArg = values["manifest"];
  const unitIdArg = values["unit-id"];
  const outArg = values["out"];

  if (!manifestArg || !unitIdArg || !outArg) {
    console.error("error: --manifest, --unit-id, and --out are required");
    return 1;
  }

  let markdown: string;
  try {
    markdown = buildContextPack(manifestArg, unitIdArg, {
      visualSpecPath: values["visual-spec"],
      routeMapPath: values["route-map"],
      componentIndexPath: values["component-index"],
      hintsJson: values["hints"],
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  mkdirSync(dirname(outArg), { recursive: true });
  writeFileSync(outArg, markdown, "utf-8");
  console.log(outArg);
  return 0;
}

runWhenMain(import.meta.url, main);
