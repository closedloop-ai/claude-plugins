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
 *   acceptance criteria (bullet format) with per-criterion State/Spec/Refs
 *   sub-bullets (the refs carry file:line locations into the embedded design
 *   source where the geometry lives), inline screenshot placeholders, a declined
 *   list, a component reuse table, a visual spec, a Provenance section, and an
 *   embedded "Design Source (embedded)" section that inlines the unit's design
 *   file(s) and sliced CSS so the ticket is SELF-CONTAINED (implementable from
 *   the ticket alone, with no access to the workdir, the export, or any pack).
 *   Does NOT contain backend-gap criteria or numbered lists.
 * - ticket-body-api.md: ticket body for the backend ticket (written only when
 *   there are accepted backend-gap findings). Contains backend-gap criteria
 *   with State/Spec/Refs detail, plus the same embedded design source so the
 *   data contract can be derived from what the UI actually reads.
 *
 * Embedded design source budget: the embedded "Design Source (embedded)" section
 * is capped at a deterministic EMBED_BUDGET_CHARS (90,000) characters total
 * across ALL embedded code blocks (every design-source file plus the sliced
 * CSS). Files are embedded in order until the remaining budget runs out; a file
 * that would exceed the remaining budget is truncated at a line boundary and a
 * visible "[truncated: N more lines, M more characters]" marker is appended so
 * the body stays bounded and reproducible regardless of source size.
 *
 * Inline image placeholders: per-finding `attachment://{{path}}` image
 * placeholders (and a unit base/theme shot at the top of the body) are emitted
 * verbatim for the orchestrator's C4 step to substitute (map mode) or strip
 * (strip mode) via apply-inline-images. The placeholder syntax matches exactly
 * what apply-inline-images consumes.
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

const CODE_FENCE_LANG: Record<string, string> = {
  ".jsx": "jsx",
  ".tsx": "tsx",
  ".js": "javascript",
  ".ts": "typescript",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".json": "json",
  ".svg": "html",
};

function fenceLang(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
  return CODE_FENCE_LANG[ext] ?? "";
}

// Deterministic total budget for the embedded "Design Source (embedded)"
// section: at most this many characters across ALL embedded code blocks (every
// design-source file plus the sliced CSS). Files are embedded in order until
// the budget is exhausted; a file that would exceed the remaining budget is
// truncated at a line boundary with a visible marker. This keeps a ticket body
// bounded and reproducible regardless of how large the source is.
const EMBED_BUDGET_CHARS = 90_000;

/** A design-source (or CSS slice) text ready to embed, with its display label. */
interface EmbedSource {
  /** Heading for the block, e.g. "`ui_kits/app/SessionsPage.jsx`" or the CSS label. */
  label: string;
  /** Code-fence language hint (jsx/tsx/css/...); "" when unknown. */
  lang: string;
  /** Full file text. */
  text: string;
}

/**
 * Read the unit's design-source files (validated, from the extract dir) and the
 * sliced CSS into in-memory EmbedSource entries. Done once in main() so the body
 * renderers stay pure and the same texts back both the UI and API bodies.
 */
function readEmbedSources(
  unit: JsonObject,
  extractDirPath: string,
  cssSlicePath: string | undefined,
): EmbedSource[] {
  const sources: EmbedSource[] = [];
  const designSources = Array.isArray(unit["design_sources"])
    ? (unit["design_sources"] as string[])
    : [];
  for (const rel of designSources) {
    if (!validateManifestPath(rel)) continue;
    const src = join(extractDirPath, rel);
    if (!(existsSync(src) && statSync(src).isFile())) continue;
    sources.push({ label: `\`${rel}\``, lang: fenceLang(rel), text: readFileSync(src, "utf-8") });
  }
  if (cssSlicePath && existsSync(cssSlicePath) && statSync(cssSlicePath).isFile()) {
    sources.push({
      label: "Sliced CSS (`design-slice.css`)",
      lang: "css",
      text: readFileSync(cssSlicePath, "utf-8"),
    });
  }
  return sources;
}

/**
 * Truncate `text` to fit `budget` characters at a line boundary and append a
 * visible marker counting the dropped lines and characters. When the whole text
 * fits, returns it unchanged with truncated=false.
 */
function truncateToBudget(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    // +1 for the newline that re-joins this line to the next.
    const cost = lines[i]!.length + 1;
    if (used + cost > budget) break;
    kept.push(lines[i]!);
    used += cost;
  }
  const droppedLines = lines.length - kept.length;
  const droppedChars = text.length - kept.join("\n").length;
  const body = kept.join("\n");
  const marker = `[truncated: ${droppedLines} more lines, ${droppedChars} more characters]`;
  return { text: body === "" ? marker : `${body}\n${marker}`, truncated: true };
}

/**
 * Render the embedded "Design Source (embedded)" appendix from pre-read sources.
 *
 * Inlines the unit's design source file(s) and the sliced CSS directly into the
 * ticket body so the ticket is SELF-CONTAINED: an implementing agent in a fresh
 * worktree, with only the ticket, has the lossless visual/structural reference
 * and never needs the original export, the workdir, or a never-delivered pack.
 *
 * A deterministic EMBED_BUDGET_CHARS budget is shared across every embedded
 * block; a file that would exceed the remaining budget is truncated at a line
 * boundary with a visible marker. Four-backtick fences guard against
 * three-backtick sequences inside the source breaking out of the block. Returns
 * [] when no readable source exists.
 */
function renderDesignSourceAppendix(sources: EmbedSource[]): string[] {
  if (sources.length === 0) return [];
  const blocks: string[] = [];
  let remaining = EMBED_BUDGET_CHARS;
  for (const source of sources) {
    const { text, truncated } = truncateToBudget(source.text, remaining);
    remaining -= text.length;
    if (remaining < 0) remaining = 0;
    blocks.push(`### ${source.label}`, "");
    blocks.push("````" + source.lang, text, "````");
    if (truncated) {
      blocks.push("", "_(embedded source truncated to stay within the ticket budget)_");
    }
    blocks.push("");
  }
  return [
    "## Design Source (embedded)",
    "",
    "The design prototype source for this unit is embedded below so this ticket is " +
    "self-contained: implement from the ticket alone, with no access to the original " +
    "export, the run workdir, or any external pack. This is a REFERENCE, not the spec:",
    "",
    "- Scope is the Acceptance Criteria above, never the source. Anything in the Declined " +
    "Changes list still appears in this source; do not implement it.",
    "- This is a standalone prototype (mock data, `window.*` globals, hardcoded values). " +
    "Mirror the structure, layout, and visual styling; wire real data per the Acceptance " +
    "Criteria and the backend ticket. Resolve raw color and spacing values to the tokens in " +
    "the Visual Spec above; never copy a raw value the spec maps to a token.",
    "",
    ...blocks,
  ];
}

/**
 * Build an inline image placeholder line for a screenshot path, using EXACTLY
 * the `![alt](attachment://{{path}})` syntax apply-inline-images consumes. The
 * orchestrator's C4 step later substitutes the path with an attachment id (map
 * mode) or strips the line (strip mode).
 */
function imagePlaceholder(path: string, alt: string): string {
  return `![${alt}](attachment://{{${path}}})`;
}

/**
 * Emit the per-criterion sub-bullets for a finding: State, Spec, and a combined
 * Refs line. State/Spec carry the visual geometry; Refs join state.refs +
 * spec.refs, which point file:line into the embedded design source. Indented two
 * spaces so they nest under the criterion bullet.
 */
function criterionDetailLines(finding: JsonObject): string[] {
  const out: string[] = [];
  const state = (finding["state"] as JsonObject | undefined) ?? {};
  const spec = (finding["spec"] as JsonObject | undefined) ?? {};
  if (state["summary"]) {
    out.push(`  - State: ${String(state["summary"])}`);
  }
  if (spec["summary"]) {
    out.push(`  - Spec: ${String(spec["summary"])}`);
  }
  const stateRefs = Array.isArray(state["refs"]) ? (state["refs"] as string[]) : [];
  const specRefs = Array.isArray(spec["refs"]) ? (spec["refs"] as string[]) : [];
  const refs = [...stateRefs, ...specRefs].filter((r) => typeof r === "string" && r.length > 0);
  if (refs.length > 0) {
    out.push(`  - Refs: ${refs.map((r) => `\`${r}\``).join(", ")}`);
  }
  return out;
}

/**
 * Emit a finding's criterion bullet, its State/Spec/Refs sub-bullets, and -- for
 * non-backend findings with a string `screenshot` -- an inline image placeholder
 * sub-bullet. The placeholder is consumed by apply-inline-images at C4.
 */
function criterionBlock(
  finding: JsonObject,
  decisions: Record<string, JsonObject>,
  withScreenshot: boolean,
): string[] {
  const out: string[] = [`- (${String(finding["id"])}) ${criterionText(finding, decisions)}`];
  out.push(...criterionDetailLines(finding));
  const screenshot = finding["screenshot"];
  if (withScreenshot && typeof screenshot === "string" && screenshot.length > 0) {
    out.push(`  ${imagePlaceholder(screenshot, `${String(finding["id"])} design region`)}`);
  }
  return out;
}

/**
 * Find the unit base/theme shot from the findings doc, when one was captured.
 * The capture step propagates the unit base shot onto theme.screenshot, so the
 * first theme with a screenshot is the best available top-of-body shot.
 */
function unitBaseShot(doc: JsonObject): string | null {
  const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
  for (const theme of themes) {
    const shot = theme["screenshot"];
    if (typeof shot === "string" && shot.length > 0) return shot;
  }
  return null;
}

/**
 * Render the UI ticket body (ticket-body-ui.md).
 *
 * Covers all accepted non-backend-gap findings. Uses bullet acceptance criteria
 * (never numbered lists) with State/Spec/Refs sub-bullets and inline screenshot
 * placeholders. Includes declined list, component reuse table, visual spec, an
 * embedded design source, and a Provenance section. Does NOT include backend-gap
 * criteria and does NOT include a Dependencies section with backend lines.
 */
function renderUiTicketBody(
  doc: JsonObject,
  decisions: Record<string, JsonObject>,
  acceptedNonBackend: JsonObject[],
  declined: JsonObject[],
  pending: JsonObject[],
  visual: JsonObject | null,
  exportZipName: string | undefined,
  embedSources: EmbedSource[],
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
    `Design source (embedded for reference in the Design Source section below): ` +
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

  const baseShot = unitBaseShot(doc);
  if (baseShot) {
    lines.push(imagePlaceholder(baseShot, `${String(unit["name"])} design`));
    lines.push("");
  }

  lines.push("## Acceptance Criteria (reviewed and accepted)");
  lines.push("");
  for (const finding of acceptedNonBackend) {
    lines.push(...criterionBlock(finding, decisions, true));
  }
  lines.push("");

  if (declined.length > 0) {
    lines.push("## Declined Changes — DO NOT IMPLEMENT");
    lines.push("");
    lines.push(
      "The embedded design source below still contains these. They were reviewed and " +
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

  lines.push(...renderDesignSourceAppendix(embedSources));

  lines.push("## Provenance");
  lines.push("");
  const exportRef = exportZipName ? `from ${exportZipName}` : "from the design export";
  lines.push(
    `Generated by design-inventory Stage C ${exportRef}; this ticket is self-contained ` +
    "(embedded design source, refs, visual spec); the run workdir is a regenerable " +
    "convenience, not a dependency."
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the API ticket body (ticket-body-api.md).
 *
 * Covers accepted backend-gap findings only. Includes State/Spec/Refs detail and
 * declined backend-gap findings when present, plus the embedded design source.
 */
function renderApiTicketBody(
  doc: JsonObject,
  decisions: Record<string, JsonObject>,
  acceptedBackend: JsonObject[],
  declinedBackend: JsonObject[],
  embedSources: EmbedSource[],
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
    // Backend findings carry no screenshot placeholder (no UI region to show).
    lines.push(...criterionBlock(finding, decisions, false));
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

  const appendix = renderDesignSourceAppendix(embedSources);
  if (appendix.length > 0) {
    lines.push(
      "The UI prototype source that consumes this backend is embedded below. Use it to " +
      "derive the exact field names, shapes, and enum values the frontend reads, so the " +
      "data contract matches what the design renders.",
      "",
    );
    lines.push(...appendix);
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

  // Read the design-source texts + CSS slice once; both bodies embed the same
  // budgeted source so the tickets are self-contained.
  const embedSources = readEmbedSources(unit, extractDirPath, cssSlicePath);

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
      embedSources,
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
      embedSources,
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
