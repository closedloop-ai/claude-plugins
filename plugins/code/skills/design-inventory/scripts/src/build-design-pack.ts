/**
 * Assemble a per-unit design pack and ticket body (PLN-859 Phase 5).
 *
 * Runs only AFTER review: a unit with no accepted findings produces no pack and
 * no ticket. For each accepted design unit this tool gathers everything an
 * implementing agent needs to mirror the original look and feel without the
 * original zip or the designer:
 *
 * - design-source/: the unit's design files (and optional sliced CSS) -- the
 *   lossless visual reference. Scope is governed by the ticket's acceptance
 *   criteria, never by the source: declined changes present in the source are
 *   listed explicitly as do-not-implement.
 * - screenshots/: the designer-curated reference images for the unit.
 * - findings.json: the unit findings with review decisions applied.
 * - visual-spec.json: the token-resolved visual spec, when provided.
 * - ticket-body.md: the text-only ticket body (platform documents cannot embed
 *   images) with acceptance criteria, declined list, component reuse table,
 *   visual spec, and dependency callouts.
 *
 * Usage:
 *     node build-design-pack.mjs --findings unit.json --decisions decisions.json \
 *         --extract-dir DIR --out-dir packs/ [--visual-spec spec.json] \
 *         [--css-slice slice.css]
 *
 * Prints the pack directory on success. Exit codes: 0 ok, 1 input/validation
 * error, 3 nothing accepted for this unit (no pack written).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import {
  effectiveDecision,
  validateDecisions,
  validateFindings,
  type JsonObject,
} from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

const ACCEPTED_STATES = new Set(["accepted", "edited"]);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function criterionText(finding: JsonObject, decisions: Record<string, JsonObject>): string {
  const decision = (decisions[String(finding["id"])] as JsonObject | undefined) ?? {};
  if (decision["state"] === "edited") {
    return String(decision["edited_summary"]);
  }
  return String(finding["summary"]);
}

function renderReuseLine(reuse: JsonObject): string {
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
  return String(reuse["resolution"] ?? "");
}

function renderVisualSpec(visual: JsonObject): string[] {
  const lines: string[] = ["## Visual Spec (token-resolved)", ""];
  const colors = (visual["colors"] as JsonObject | undefined) ?? {};
  const resolved = Array.isArray(colors["resolved"]) ? (colors["resolved"] as JsonObject[]) : [];
  const drift = Array.isArray(colors["drift"]) ? (colors["drift"] as JsonObject[]) : [];
  if (resolved.length > 0) {
    lines.push("Use these design-system tokens (NOT raw values):");
    lines.push("");
    lines.push("| Design value | Token |");
    lines.push("|---|---|");
    for (const entry of resolved) {
      lines.push(`| \`${String(entry["value"])}\` | \`${String(entry["token"])}\` |`);
    }
    lines.push("");
  }
  if (drift.length > 0) {
    lines.push(
      "Token drift -- raw values in the design with no exact design-system match. " +
      "Default to the nearest token unless the acceptance criteria say otherwise:"
    );
    lines.push("");
    lines.push("| Design value | Uses | Nearest token |");
    lines.push("|---|---|---|");
    for (const entry of drift) {
      const nearest = entry["nearest_token"] !== undefined ? String(entry["nearest_token"]) : "-";
      const distance = entry["distance"];
      // Match Python float repr: 1.0 renders as "1.0", not "1"
      const distStr = typeof distance === "number" && Number.isFinite(distance)
        ? (Number.isInteger(distance) ? distance.toFixed(1) : String(distance))
        : String(distance);
      const nearestDesc = nearest !== "-" ? `\`${nearest}\` (d=${distStr})` : "-";
      lines.push(`| \`${String(entry["value"])}\` | ${String(entry["count"] ?? 1)} | ${nearestDesc} |`);
    }
    lines.push("");
  }
  if (visual["icons"] && Array.isArray(visual["icons"])) {
    lines.push(`Icons (lucide names): ${(visual["icons"] as string[]).join(", ")}`);
    lines.push("");
  }
  const layout = (visual["layout"] as JsonObject | undefined) ?? {};
  const layoutFacts = Object.entries(layout)
    .filter(([k, v]) => k !== "utility_classes" && v)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  if (layoutFacts) {
    lines.push(`Layout: ${layoutFacts}`);
  }
  const utility = Array.isArray(layout["utility_classes"]) ? (layout["utility_classes"] as string[]) : [];
  if (utility.length > 0) {
    lines.push(`Utility classes in design: ${utility.join(" ")}`);
  }
  const states = (visual["state_styles"] as JsonObject | undefined) ?? {};
  if (Object.keys(states).length > 0) {
    lines.push(
      "State styles present: " +
      Object.entries(states)
        .map(([k, v]) => `${k} (${Array.isArray(v) ? v.length : 0} selectors)`)
        .join(", ")
    );
  }
  for (const propGroup of ["spacing", "typography"] as const) {
    const values = (visual[propGroup] as JsonObject | undefined) ?? {};
    if (Object.keys(values).length > 0) {
      lines.push("");
      lines.push(`${propGroup.charAt(0).toUpperCase() + propGroup.slice(1)}:`);
      for (const [prop, vals] of Object.entries(values)) {
        const valsArr = Array.isArray(vals) ? (vals as string[]).slice(0, 12) : [];
        lines.push(`- ${prop}: ${valsArr.join(", ")}`);
      }
    }
  }
  lines.push("");
  return lines;
}

function renderTicketBody(
  doc: JsonObject,
  decisions: Record<string, JsonObject>,
  accepted: JsonObject[],
  declined: JsonObject[],
  visual: JsonObject | null,
  packRel: string,
): string {
  const unit = doc["unit"] as JsonObject;
  const impl = unit["current_impl"] as JsonObject;
  const flag = (unit["feature_flag"] as JsonObject | null | undefined) ?? {};
  const lines: string[] = [
    `# Implement ${String(unit["name"])} from approved design`,
    "",
    "## State vs Spec",
    "",
  ];
  const paths = Array.isArray(impl["paths"]) ? (impl["paths"] as string[]) : [];
  const implDesc = paths.length > 0
    ? paths.map((p) => `\`${p}\``).join(", ")
    : "no current implementation";
  let stateLine =
    `Unit type: ${String(unit["type"])}. Classification: ${String(unit["classification"])}. ` +
    `Current implementation: ${implDesc}.`;
  if (impl["route"]) {
    stateLine += ` Route: \`${String(impl["route"])}\`.`;
  }
  lines.push(stateLine);
  lines.push(
    `Design source (visual reference, in the attached design pack): ` +
    `\`${String(unit["primary_source"])}\`.`
  );
  if (unit["duplication_note"]) {
    lines.push(`Note: ${String(unit["duplication_note"])}`);
  }
  lines.push("");
  if (unit["classification"] === "new" || flag["required"]) {
    lines.push(`**REQUIRES FEATURE FLAG:** ${flag["flag"] ? String(flag["flag"]) : "create a new flag"}`);
    lines.push("");
  }

  lines.push("## Acceptance Criteria (reviewed and accepted)");
  lines.push("");
  let i = 1;
  for (const finding of accepted) {
    lines.push(`${i}. (${String(finding["id"])}) ${criterionText(finding, decisions)}`);
    i++;
  }
  lines.push("");

  if (declined.length > 0) {
    lines.push("## Declined Changes — DO NOT IMPLEMENT");
    lines.push("");
    lines.push(
      "The attached design source still contains these. They were reviewed and " +
      "declined; do not mirror them:"
    );
    lines.push("");
    for (const finding of declined) {
      lines.push(`- (${String(finding["id"])}) ${String(finding["summary"])}`);
    }
    lines.push("");
  }

  const reuseEntries = accepted.filter((f) => f["reuse"]);
  const table = Array.isArray(doc["component_reuse"])
    ? (doc["component_reuse"] as JsonObject[])
    : [];
  if (reuseEntries.length > 0 || table.length > 0) {
    lines.push("## Component Reuse");
    lines.push("");
    lines.push("| Element | Resolution |");
    lines.push("|---|---|");
    const seen = new Set<string>();
    for (const finding of reuseEntries) {
      const line = renderReuseLine(finding["reuse"] as JsonObject);
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(`| ${String(finding["title"])} | ${line} |`);
      }
    }
    for (const entry of table) {
      const line = renderReuseLine(entry);
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(`| ${String(entry["element"])} | ${line} |`);
      }
    }
    lines.push("");
  }

  if (visual) {
    lines.push(...renderVisualSpec(visual));
  }

  // dependencies: insertion-order dedup via Set (mirrors Python dict.fromkeys)
  const depsOrdered: string[] = [];
  const depsSet = new Set<string>();
  for (const finding of accepted) {
    if (finding["category"] === "backend-gap") {
      const dep = `Backend ticket required: (${String(finding["id"])}) ${String(finding["summary"])}`;
      if (!depsSet.has(dep)) {
        depsSet.add(dep);
        depsOrdered.push(dep);
      }
    }
    const reuse = (finding["reuse"] as JsonObject | null | undefined) ?? {};
    if (reuse["resolution"] === "new-component") {
      const dep = `Design-system ticket required: build \`${String(reuse["proposed_name"])}\``;
      if (!depsSet.has(dep)) {
        depsSet.add(dep);
        depsOrdered.push(dep);
      }
    }
  }
  for (const entry of table) {
    if (entry["resolution"] === "new-component") {
      const name = entry["proposed_name"] ? String(entry["proposed_name"]) : String(entry["element"]);
      const dep = `Design-system ticket required: build \`${name}\``;
      if (!depsSet.has(dep)) {
        depsSet.add(dep);
        depsOrdered.push(dep);
      }
    }
  }
  if (depsOrdered.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    for (const d of depsOrdered) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  lines.push("## Design Pack");
  lines.push("");
  lines.push(
    `Attached/stored at \`${packRel}\`: design-source/ (visual values reference ONLY; ` +
    "scope is the acceptance criteria above), screenshots/ (compare your result " +
    "against these), findings.json (full inventory with decisions), and " +
    "visual-spec.json when present. Build with design-system tokens and shared " +
    "components; never copy raw values the visual spec resolves to tokens."
  );
  lines.push("");
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      findings: { type: "string" },
      decisions: { type: "string" },
      "extract-dir": { type: "string" },
      "out-dir": { type: "string" },
      "visual-spec": { type: "string" },
      "css-slice": { type: "string" },
    },
  });

  const findingsPath = values["findings"];
  const decisionsPath = values["decisions"];
  const extractDirPath = values["extract-dir"];
  const outDirPath = values["out-dir"];

  if (!findingsPath || !decisionsPath || !extractDirPath || !outDirPath) {
    console.error("error: --findings, --decisions, --extract-dir, and --out-dir are required");
    return 1;
  }

  let doc: unknown;
  let decisionsDoc: unknown;
  try {
    doc = loadJson(findingsPath);
    decisionsDoc = loadJson(decisionsPath);
  } catch (exc) {
    console.error(`error: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  const errors = [...validateFindings(doc), ...validateDecisions(decisionsDoc)];
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 1;
  }

  const decisions = (decisionsDoc as JsonObject)["decisions"] as Record<string, JsonObject>;
  const findingsArr = Array.isArray((doc as JsonObject)["findings"])
    ? ((doc as JsonObject)["findings"] as JsonObject[])
    : [];

  const accepted = findingsArr.filter((f) => ACCEPTED_STATES.has(effectiveDecision(f, decisions)));
  const declined = findingsArr.filter((f) => effectiveDecision(f, decisions) === "declined");

  if (accepted.length === 0) {
    const unit = (doc as JsonObject)["unit"] as JsonObject;
    console.error(`nothing accepted for unit ${String(unit["id"])}; no pack written`);
    return 3;
  }

  const unit = (doc as JsonObject)["unit"] as JsonObject;
  const packDir = join(outDirPath, String(unit["id"]));
  const sourceDir = join(packDir, "design-source");
  const shotsDir = join(packDir, "screenshots");
  mkdirSync(sourceDir, { recursive: true });

  const designSources = Array.isArray(unit["design_sources"])
    ? (unit["design_sources"] as string[])
    : [];
  for (const rel of designSources) {
    const src = join(extractDirPath, rel);
    if (existsSync(src) && statSync(src).isFile()) {
      copyFileSync(src, join(sourceDir, basename(rel)));
    }
  }

  const cssSlicePath = values["css-slice"];
  if (cssSlicePath && existsSync(cssSlicePath) && statSync(cssSlicePath).isFile()) {
    copyFileSync(cssSlicePath, join(sourceDir, "design-slice.css"));
  }

  const refScreenshots = Array.isArray(unit["reference_screenshots"])
    ? (unit["reference_screenshots"] as string[])
    : [];
  for (const rel of refScreenshots) {
    const src = join(extractDirPath, rel);
    if (existsSync(src) && statSync(src).isFile()) {
      mkdirSync(shotsDir, { recursive: true });
      copyFileSync(src, join(shotsDir, basename(rel)));
    }
  }

  // Deep copy the doc and apply effective decisions
  const resolvedDoc = JSON.parse(JSON.stringify(doc)) as JsonObject;
  const resolvedFindings = Array.isArray(resolvedDoc["findings"])
    ? (resolvedDoc["findings"] as JsonObject[])
    : [];
  for (const finding of resolvedFindings) {
    finding["decision"] = { state: effectiveDecision(finding, decisions) };
  }
  writeFileSync(join(packDir, "findings.json"), JSON.stringify(resolvedDoc, null, 1), "utf-8");

  let visual: JsonObject | null = null;
  const visualSpecPath = values["visual-spec"];
  if (visualSpecPath && existsSync(visualSpecPath) && statSync(visualSpecPath).isFile()) {
    visual = loadJson(visualSpecPath) as JsonObject;
    writeFileSync(join(packDir, "visual-spec.json"), JSON.stringify(visual, null, 1), "utf-8");
  }

  const body = renderTicketBody(
    doc as JsonObject,
    decisions,
    accepted,
    declined,
    visual,
    packDir,
  );
  writeFileSync(join(packDir, "ticket-body.md"), body, "utf-8");
  console.log(packDir);
  return 0;
}

runWhenMain(import.meta.url, main);
