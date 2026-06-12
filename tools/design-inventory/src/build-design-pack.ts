/**
 * Assemble a per-unit design pack and ticket bodies (PLN-859 Phase 5 / P4b).
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
 * - ticket-body-ui.md: ticket body for the UI implementation ticket (always
 *   written when there are accepted non-backend-gap findings). Contains
 *   acceptance criteria (bullet format), declined list, component reuse table,
 *   visual spec, and a Provenance section. Does NOT contain backend-gap
 *   criteria or numbered lists.
 * - ticket-body-api.md: ticket body for the backend ticket (written only when
 *   there are accepted backend-gap findings). Contains backend-gap criteria
 *   with state/spec detail.
 *
 * Usage:
 *     node build-design-pack.mjs --findings unit.json --decisions decisions.json \
 *         --extract-dir DIR --out-dir packs/ [--visual-spec spec.json] \
 *         [--css-slice slice.css] [--export-zip-name <name>]
 *
 * Prints the pack directory on success. Exit codes: 0 ok, 1 input/validation
 * error, 3 nothing accepted for this unit (no pack written).
 *
 * Replay behavior: the unit's pack directory is removed at the start of each
 * pack generation run (after input validation), including when the run exits
 * with code 3 (nothing accepted). This ensures re-runs that decline everything
 * leave no stale pack on disk.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";

import {
  effectiveDecision,
  validateDecisions,
  validateFindings,
  type JsonObject,
} from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

const ACCEPTED_STATES = new Set(["accepted", "edited"]);

/**
 * Validate that a path from a manifest (design_sources / reference_screenshots)
 * is safe to use as a relative path under a controlled directory.
 *
 * Rejects:
 * - absolute paths (isAbsolute)
 * - any normalized path whose first segment is ".." (path traversal)
 * - any path whose normalized form contains a ".." segment anywhere
 *
 * Returns true when the path is safe, false otherwise.
 *
 * Exported for unit tests.
 */
export function validateManifestPath(rel: string): boolean {
  if (isAbsolute(rel)) return false;
  const norm = normalize(rel);
  // normalize("../foo") -> "../foo", normalize("foo/../bar") -> "bar"
  // Split on both / and \ to handle Windows-style separators that normalize may produce.
  const parts = norm.split(/[\\/]/);
  return !parts.includes("..");
}

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

/**
 * Render the UI ticket body (ticket-body-ui.md).
 *
 * Covers all accepted non-backend-gap findings. Uses bullet acceptance criteria
 * (never numbered lists). Includes declined list, component reuse table, visual
 * spec, and a Provenance section. Does NOT include backend-gap criteria and
 * does NOT include a Dependencies section with backend lines.
 */
function renderUiTicketBody(
  doc: JsonObject,
  decisions: Record<string, JsonObject>,
  acceptedNonBackend: JsonObject[],
  declined: JsonObject[],
  pending: JsonObject[],
  visual: JsonObject | null,
  exportZipName: string | undefined,
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
  for (const finding of acceptedNonBackend) {
    lines.push(`- (${String(finding["id"])}) ${criterionText(finding, decisions)}`);
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

  if (pending.length > 0) {
    lines.push("## Undecided Findings (excluded from this ticket's scope)");
    lines.push("");
    lines.push(
      "These findings were left undecided during review and need a decision before they can be scheduled:"
    );
    lines.push("");
    for (const finding of pending) {
      lines.push(`- (${String(finding["id"])}) ${String(finding["summary"])}`);
    }
    lines.push("");
  }

  // Component Reuse: accepted findings' reuse blocks form the main (decision-tracked) table.
  // Unit-level component_reuse catalog rows go into an informational subsection only --
  // they are not decision-tracked and must not drive Dependencies.
  const reuseEntries = acceptedNonBackend.filter((f) => f["reuse"]);
  const catalogTable = Array.isArray(doc["component_reuse"])
    ? (doc["component_reuse"] as JsonObject[])
    : [];
  if (reuseEntries.length > 0 || catalogTable.length > 0) {
    lines.push("## Component Reuse");
    lines.push("");
    if (reuseEntries.length > 0) {
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
      lines.push("");
    }
    if (catalogTable.length > 0) {
      lines.push("### Catalog (informational, not decision-tracked)");
      lines.push("");
      lines.push("| Element | Resolution |");
      lines.push("|---|---|");
      for (const entry of catalogTable) {
        lines.push(`| ${String(entry["element"])} | ${renderReuseLine(entry)} |`);
      }
      lines.push("");
    }
  }

  if (visual) {
    lines.push(...renderVisualSpec(visual));
  }

  // Dependencies: ONLY from accepted findings' reuse blocks with resolution new-component.
  // Unit-level catalog rows and declined/pending findings' reuse are excluded.
  const depsOrdered: string[] = [];
  const depsSet = new Set<string>();
  for (const finding of acceptedNonBackend) {
    const reuse = (finding["reuse"] as JsonObject | null | undefined) ?? {};
    if (reuse["resolution"] === "new-component") {
      const dep = `Design-system ticket required: build \`${String(reuse["proposed_name"])}\``;
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

  lines.push("## Provenance");
  lines.push("");
  const exportRef = exportZipName ? `from ${exportZipName}` : "from the design export";
  lines.push(
    `Generated by design-inventory Stage A ${exportRef}. ` +
    "Analysis artifacts live in the run workdir and are regenerable."
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the API ticket body (ticket-body-api.md).
 *
 * Covers accepted backend-gap findings only. Includes state/spec summaries and
 * declined backend-gap findings when present.
 */
function renderApiTicketBody(
  doc: JsonObject,
  decisions: Record<string, JsonObject>,
  acceptedBackend: JsonObject[],
  declinedBackend: JsonObject[],
): string {
  const unit = doc["unit"] as JsonObject;
  const impl = unit["current_impl"] as JsonObject;
  const lines: string[] = [
    `# Backend for ${String(unit["name"])}`,
    "",
    "## State vs Spec",
    "",
  ];
  const paths = Array.isArray(impl["paths"]) ? (impl["paths"] as string[]) : [];
  const implDesc = paths.length > 0
    ? paths.map((p) => `\`${p}\``).join(", ")
    : "no current implementation";
  lines.push(
    `Unit type: ${String(unit["type"])}. Classification: ${String(unit["classification"])}. ` +
    `Current implementation: ${implDesc}.`
  );
  lines.push("");

  lines.push("## Acceptance Criteria (backend-gap)");
  lines.push("");
  for (const finding of acceptedBackend) {
    lines.push(`- (${String(finding["id"])}) ${criterionText(finding, decisions)}`);
    const state = (finding["state"] as JsonObject | undefined) ?? {};
    const spec = (finding["spec"] as JsonObject | undefined) ?? {};
    if (state["summary"]) {
      lines.push(`  - State: ${String(state["summary"])}`);
    }
    if (spec["summary"]) {
      lines.push(`  - Spec: ${String(spec["summary"])}`);
    }
  }
  lines.push("");

  if (declinedBackend.length > 0) {
    lines.push("## Declined Backend Changes — DO NOT IMPLEMENT");
    lines.push("");
    for (const finding of declinedBackend) {
      lines.push(`- (${String(finding["id"])}) ${String(finding["summary"])}`);
    }
    lines.push("");
  }

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
      "export-zip-name": { type: "string" },
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
  const pending = findingsArr.filter((f) => effectiveDecision(f, decisions) === "pending");

  const unit = (doc as JsonObject)["unit"] as JsonObject;
  const packDir = join(outDirPath, String(unit["id"]));

  // Remove any pre-existing pack dir before writing (Finding C: replay cleanup).
  // This ensures stale outputs from prior runs are never left on disk, including
  // when the current run produces nothing (exit 3).
  if (existsSync(packDir)) {
    rmSync(packDir, { recursive: true, force: true });
  }

  if (accepted.length === 0) {
    const pendingClause = pending.length > 0
      ? `; ${pending.length} finding(s) still pending`
      : "";
    const declinedClause = declined.length > 0
      ? `; ${declined.length} finding(s) declined`
      : "";
    console.error(
      `nothing accepted for unit ${String(unit["id"])}; no pack written` +
      declinedClause + pendingClause
    );
    return 3;
  }

  const acceptedNonBackend = accepted.filter((f) => f["category"] !== "backend-gap");
  const acceptedBackend = accepted.filter((f) => f["category"] === "backend-gap");
  const declinedBackend = declined.filter((f) => f["category"] === "backend-gap");

  const sourceDir = join(packDir, "design-source");
  const shotsDir = join(packDir, "screenshots");
  mkdirSync(sourceDir, { recursive: true });

  const designSources = Array.isArray(unit["design_sources"])
    ? (unit["design_sources"] as string[])
    : [];
  for (const rel of designSources) {
    if (!validateManifestPath(rel)) {
      process.stderr.write(`warning: skipping unsafe design_sources path: ${rel}\n`);
      continue;
    }
    const src = join(extractDirPath, rel);
    if (existsSync(src) && statSync(src).isFile()) {
      const dest = join(sourceDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
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
    if (!validateManifestPath(rel)) {
      process.stderr.write(`warning: skipping unsafe reference_screenshots path: ${rel}\n`);
      continue;
    }
    const src = join(extractDirPath, rel);
    if (existsSync(src) && statSync(src).isFile()) {
      const dest = join(shotsDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
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

  const exportZipName = values["export-zip-name"];

  // Write ticket-body-ui.md when there are accepted non-backend-gap findings
  if (acceptedNonBackend.length > 0) {
    const uiBody = renderUiTicketBody(
      doc as JsonObject,
      decisions,
      acceptedNonBackend,
      declined,
      pending,
      visual,
      exportZipName,
    );
    writeFileSync(join(packDir, "ticket-body-ui.md"), uiBody, "utf-8");
  }

  // Write ticket-body-api.md only when there are accepted backend-gap findings
  if (acceptedBackend.length > 0) {
    const apiBody = renderApiTicketBody(
      doc as JsonObject,
      decisions,
      acceptedBackend,
      declinedBackend,
    );
    writeFileSync(join(packDir, "ticket-body-api.md"), apiBody, "utf-8");
  }

  const summary = {
    pack: packDir,
    accepted: accepted.length,
    declined: declined.length,
    pending: pending.length,
    ...(pending.length > 0 && { pending_ids: pending.map((f) => String(f["id"])) }),
  };
  console.log(JSON.stringify(summary));
  return 0;
}

runWhenMain(import.meta.url, main);
