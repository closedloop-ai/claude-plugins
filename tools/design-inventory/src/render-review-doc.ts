/**
 * Render the markdown body of the platform "Design Review" Feature document (PLN-859 P2).
 *
 * Emits the document body that humans review by editing: deleting a section
 * declines that finding. Strict formatting rules: no numbered lists anywhere;
 * every finding/theme heading carries its stable id as a trailing inline code
 * span; images use placeholder syntax for later attachment substitution.
 *
 * Usage:
 *     node render-review-doc.mjs --findings <file-or-dir> [--findings ...] \
 *         --manifest <manifest.json> --out <body.md> [--export-name <name>]
 *
 * Exit codes: 0 ok, 1 validation/input error.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { validateFindings, type JsonObject } from "./design-findings-schema.js";
import { checkThemeIdUniqueness } from "./theme-id-guard.js";
import { runWhenMain } from "./cli.js";

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

function loadFindingsPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const name of paths) {
    let isDir = false;
    try {
      isDir = statSync(name).isDirectory();
    } catch {
      // not a dir, treat as file
    }
    if (isDir) {
      const children = readdirSync(name)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(name, f));
      for (const child of children) {
        try {
          const doc: unknown = JSON.parse(readFileSync(child, "utf-8"));
          if (typeof doc === "object" && doc !== null && !Array.isArray(doc) && !("decisions" in doc)) {
            files.push(child);
          }
        } catch {
          // skip unreadable
        }
      }
    } else {
      files.push(name);
    }
  }
  return files;
}

function loadDocuments(files: string[]): { docs: JsonObject[]; errors: string[] } {
  const docs: JsonObject[] = [];
  const errors: string[] = [];
  for (const path of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, "utf-8"));
    } catch (exc) {
      errors.push(`${path}: unreadable: ${exc instanceof Error ? exc.message : String(exc)}`);
      continue;
    }
    const docErrors = validateFindings(doc);
    if (docErrors.length > 0) {
      errors.push(...docErrors.map((e) => `${path}: ${e}`));
    } else {
      docs.push(doc as JsonObject);
    }
  }
  return { docs, errors };
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

interface ManifestUnit {
  id: string;
  name: string;
  type: string;
  disposition?: string;
}

interface Manifest {
  units: ManifestUnit[];
}

function loadManifest(path: string): { manifest: Manifest | null; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (exc) {
    return { manifest: null, error: `${path}: unreadable: ${exc instanceof Error ? exc.message : String(exc)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (exc) {
    return { manifest: null, error: `${path}: invalid JSON: ${exc instanceof Error ? exc.message : String(exc)}` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { manifest: null, error: `${path}: manifest must be a JSON object` };
  }
  const obj = doc as Record<string, unknown>;
  if (!Array.isArray(obj["units"])) {
    return { manifest: null, error: `${path}: manifest.units must be an array` };
  }
  const units: ManifestUnit[] = [];
  for (const u of obj["units"] as unknown[]) {
    if (typeof u !== "object" || u === null || Array.isArray(u)) continue;
    const unit = u as Record<string, unknown>;
    units.push({
      id: String(unit["id"] ?? ""),
      name: String(unit["name"] ?? ""),
      type: String(unit["type"] ?? ""),
      disposition: unit["disposition"] !== undefined ? String(unit["disposition"]) : undefined,
    });
  }
  return { manifest: { units }, error: null };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderReuse(reuse: JsonObject | null | undefined): string | null {
  if (!reuse) return null;
  if (reuse["resolution"] === "reuse") {
    let line = `use \`${String(reuse["component"])}\` from \`${String(reuse["import_path"])}\``;
    if (reuse["story"]) {
      line += ` (story \`${String(reuse["story"])}\`)`;
    }
    return line;
  }
  if (reuse["resolution"] === "new-component") {
    let line = `NEW COMPONENT required: \`${String(reuse["proposed_name"])}\``;
    if (reuse["closest_existing"]) {
      line += ` (closest existing: \`${String(reuse["closest_existing"])}\`)`;
    }
    return line;
  }
  return null;
}

/**
 * Derive recommendation from a finding when no explicit recommendation field is present.
 * likely-intentional -> Accept, likely-unintentional -> Decline, unclear -> Discuss.
 */
function derivedRecommendation(finding: JsonObject): { action: string; rationale: string } {
  const intent = String(finding["intent"] ?? "unclear");
  const rationale = String(finding["intent_rationale"] ?? "");
  if (intent === "likely-intentional") {
    return { action: "Accept", rationale };
  }
  if (intent === "likely-unintentional") {
    return { action: "Decline", rationale };
  }
  return { action: "Discuss", rationale };
}

function getRecommendation(finding: JsonObject): { action: string; rationale: string } {
  const rec = finding["recommendation"];
  if (rec !== null && rec !== undefined && typeof rec === "object" && !Array.isArray(rec)) {
    const recObj = rec as JsonObject;
    const action = String(recObj["action"] ?? "discuss");
    // Capitalise first letter for display
    const displayAction = action.charAt(0).toUpperCase() + action.slice(1);
    return { action: displayAction, rationale: String(recObj["rationale"] ?? "") };
  }
  return derivedRecommendation(finding);
}

function renderFindingBlock(finding: JsonObject, level: "#####" | "####" | "###"): string[] {
  const id = String(finding["id"]);
  const title = String(finding["title"]);
  const lines: string[] = [];

  lines.push(`${level} ${title} \`${id}\``);
  lines.push("");

  const screenshot = finding["screenshot"];
  if (typeof screenshot === "string" && screenshot.length > 0) {
    lines.push(`![design region](attachment://{{${screenshot}}})`);
    lines.push("");
  }

  const rec = getRecommendation(finding);
  lines.push(`- **Recommended: ${rec.action}** - ${rec.rationale}`);

  lines.push(`- **What changes:** ${String(finding["summary"])}`);

  const state = finding["state"] as JsonObject;
  const spec = finding["spec"] as JsonObject;
  lines.push(`- **Today:** ${String(state["summary"])} | **Design:** ${String(spec["summary"])}`);

  const reuseObj = finding["reuse"] as JsonObject | null | undefined;
  const reuseLine = renderReuse(reuseObj);
  if (reuseLine) {
    lines.push(`- **Reuse:** ${reuseLine}`);
  }

  lines.push(`- To decline this change, delete this entire section (\`${id}\`).`);
  lines.push("");

  return lines;
}

function renderUnitSection(doc: JsonObject): string[] {
  const unit = doc["unit"] as JsonObject;
  const unitId = String(unit["id"]);
  const unitName = String(unit["name"]);
  const lines: string[] = [];

  lines.push(`## ${unitName} \`${unitId}\``);
  lines.push("");

  // Classification line
  const cls = String(unit["classification"]);
  const flag = (unit["feature_flag"] as JsonObject | null | undefined) ?? {};
  lines.push(`- **Classification:** ${cls}`);
  if (cls === "new" || flag["required"] === true) {
    const flagName = flag["flag"] ? String(flag["flag"]) : "new flag needed";
    lines.push(`- **REQUIRES FEATURE FLAG:** ${flagName}`);
  }

  // Current impl
  const impl = unit["current_impl"] as JsonObject;
  const paths = Array.isArray(impl["paths"]) ? (impl["paths"] as string[]) : [];
  const route = impl["route"] ? String(impl["route"]) : null;
  if (paths.length > 0) {
    const pathsStr = paths.map((p) => `\`${p}\``).join(", ");
    lines.push(`- **Current impl:** ${route ? `\`${route}\` — ` : ""}${pathsStr}`);
  } else {
    lines.push(`- **Current impl:** not found in current web-ui`);
  }

  // Design source
  const primarySource = String(unit["primary_source"]);
  lines.push(`- **Design source primary:** \`${primarySource}\``);

  lines.push("");

  // Deprecated: short-circuit, no findings
  if (cls === "deprecated-do-not-implement") {
    lines.push("**Present in the design but deprecated. MUST NOT be implemented.**");
    lines.push("");
    return lines;
  }

  // Themes then standalone findings
  const themesArr = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
  const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];

  // Index themes
  const themeOrder: string[] = [];
  const themeMap: Record<string, JsonObject> = {};
  for (const theme of themesArr) {
    const tid = String(theme["id"]);
    themeOrder.push(tid);
    themeMap[tid] = theme;
  }

  // Group findings by theme
  const byTheme: Record<string, JsonObject[]> = {};
  const standaloneFindings: JsonObject[] = [];
  for (const finding of findingsArr) {
    const themeRef = finding["theme"];
    if (typeof themeRef === "string" && themeRef.length > 0 && themeMap[themeRef]) {
      if (!byTheme[themeRef]) byTheme[themeRef] = [];
      byTheme[themeRef]!.push(finding);
    } else {
      standaloneFindings.push(finding);
    }
  }

  // Render themes
  for (const tid of themeOrder) {
    const theme = themeMap[tid];
    if (!theme) continue;
    const themeTitle = String(theme["title"]);
    lines.push(`### ${themeTitle} \`${tid}\``);
    lines.push("");

    const themeScreenshot = theme["screenshot"];
    if (typeof themeScreenshot === "string" && themeScreenshot.length > 0) {
      lines.push(`![design region](attachment://{{${themeScreenshot}}})`);
      lines.push("");
    }

    const themeDesc = theme["description"];
    if (typeof themeDesc === "string" && themeDesc.length > 0) {
      lines.push(themeDesc);
      lines.push("");
    }

    const members = byTheme[tid] ?? [];
    for (const finding of members) {
      lines.push(...renderFindingBlock(finding, "####"));
    }
  }

  // Render standalone findings
  for (const finding of standaloneFindings) {
    lines.push(...renderFindingBlock(finding, "###"));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

function renderReviewDoc(
  docs: JsonObject[],
  manifest: Manifest,
  exportName: string,
): string {
  const out: string[] = [];

  // H1 + intro
  out.push(`# Design Review: ${exportName}`);
  out.push("");
  out.push(
    "Review this document by editing it directly. " +
    "Delete any section you do not want built. " +
    "Edit the **What changes** line to amend scope. " +
    "Everything that remains becomes tickets."
  );
  out.push("");

  // Build a lookup: unit-id -> findings doc
  const docsByUnitId: Record<string, JsonObject> = {};
  for (const doc of docs) {
    const unit = doc["unit"] as JsonObject;
    docsByUnitId[String(unit["id"])] = doc;
  }

  // H2: Screens considered table
  out.push("## Screens considered");
  out.push("");
  out.push("| ID | Name | Type | Disposition |");
  out.push("|---|---|---|---|");
  for (const mu of manifest.units) {
    const findingsDoc = docsByUnitId[mu.id];
    let disposition: string;
    if (findingsDoc) {
      const unit = findingsDoc["unit"] as JsonObject;
      disposition = String(unit["classification"]);
    } else if (mu.disposition) {
      disposition = mu.disposition;
    } else {
      disposition = "not analyzed";
    }
    out.push(`| \`${mu.id}\` | ${mu.name} | ${mu.type} | ${disposition} |`);
  }
  out.push("");
  out.push("_This table is informational and is not part of the decision contract._");
  out.push("");

  // One H2 per unit that has a findings doc, in manifest order
  for (const mu of manifest.units) {
    const doc = docsByUnitId[mu.id];
    if (!doc) continue;
    out.push(...renderUnitSection(doc));
    out.push("---");
    out.push("");
  }

  // H2: Backend gaps rollup
  const backendGaps: Array<{ id: string; summary: string; unitName: string }> = [];
  for (const doc of docs) {
    const unit = doc["unit"] as JsonObject;
    const unitName = String(unit["name"]);
    const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
    for (const finding of findingsArr) {
      if (finding["category"] === "backend-gap") {
        backendGaps.push({
          id: String(finding["id"]),
          summary: String(finding["summary"]),
          unitName,
        });
      }
    }
  }

  if (backendGaps.length > 0) {
    out.push("## Backend gaps");
    out.push("");
    out.push(
      "These are informational. The per-screen sections above remain the decision surface."
    );
    out.push("");
    for (const gap of backendGaps) {
      out.push(`- \`${gap.id}\` ${gap.summary} (${gap.unitName})`);
    }
    out.push("");
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Cross-checks
// ---------------------------------------------------------------------------

function crossCheck(
  docs: JsonObject[],
  manifest: Manifest,
): string[] {
  const errors: string[] = [];
  const manifestIds = new Set(manifest.units.map((u) => u.id));

  // Every findings unit-id must exist in the manifest
  for (const doc of docs) {
    const unit = doc["unit"] as JsonObject;
    const uid = String(unit["id"]);
    if (!manifestIds.has(uid)) {
      errors.push(
        `findings unit id '${uid}' is not present in the manifest units array`
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      findings: { type: "string", multiple: true },
      manifest: { type: "string" },
      out: { type: "string" },
      "export-name": { type: "string", default: "design export" },
    },
  });

  const findingsPaths = values["findings"] ?? [];
  if (findingsPaths.length === 0) {
    console.error("error: --findings is required");
    return 1;
  }
  const manifestPath = values["manifest"];
  if (!manifestPath) {
    console.error("error: --manifest is required");
    return 1;
  }
  const outPath = values["out"];
  if (!outPath) {
    console.error("error: --out is required");
    return 1;
  }

  const files = loadFindingsPaths(findingsPaths);
  if (files.length === 0) {
    console.error("error: no findings documents found");
    return 1;
  }

  const { docs, errors } = loadDocuments(files);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 1;
  }

  const { manifest, error: manifestError } = loadManifest(manifestPath);
  if (!manifest || manifestError) {
    console.error(manifestError ?? "error: failed to load manifest");
    return 1;
  }

  const crossErrors = crossCheck(docs, manifest);
  if (crossErrors.length > 0) {
    for (const error of crossErrors) {
      console.error(`error: ${error}`);
    }
    return 1;
  }

  const themeGuardResult = checkThemeIdUniqueness(docs);
  if (themeGuardResult !== 0) return themeGuardResult;

  const exportName = String(values["export-name"] ?? "design export");
  const body = renderReviewDoc(docs, manifest, exportName);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, "utf-8");
  console.log(outPath);
  return 0;
}

runWhenMain(import.meta.url, main);
