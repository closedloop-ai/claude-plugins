/**
 * Render design-inventory-report.md from findings.json documents (PLN-859).
 *
 * The report is a rendering of the findings data contract, not a parse target:
 * analysts emit per-unit findings.json (see design-findings-schema.ts), the
 * optional review step emits decisions.json, and this tool renders both into
 * the human-readable report. Decision states resolve per finding via explicit
 * decision > theme decision > embedded state.
 *
 * Usage:
 *     node render-report.mjs --findings PATH [--findings PATH ...] \
 *         --out report.md [--decisions decisions.json] [--export-name NAME] \
 *         [--not-analyzed "unit-id: reason" ...]
 *
 * A --findings PATH may be a file or a directory (all *.json inside, skipping
 * decisions documents). Exit codes: 0 ok, 1 validation/input error.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { parseArgs } from "node:util";

import {
  FINDING_CATEGORIES,
  effectiveDecision,
  validateDecisions,
  validateFindings,
  type JsonObject,
} from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

const DECISION_MARK: Record<string, string> = {
  accepted: "[x] Accept / [ ] Decline",
  declined: "[ ] Accept / [x] Decline",
};
const PENDING_MARK = "[ ] Accept / [ ] Decline";

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

function renderFinding(finding: JsonObject, decision: string): string[] {
  const lines: string[] = [
    `#### ${String(finding["id"])} — ${String(finding["title"])}`,
    "",
  ];
  lines.push(`- Category: ${String(finding["category"])}`);
  lines.push(`- Intent: ${String(finding["intent"])} — ${String(finding["intent_rationale"])}`);
  const state = finding["state"] as JsonObject;
  const spec = finding["spec"] as JsonObject;
  const stateRefs = Array.isArray(state["refs"]) && (state["refs"] as string[]).length > 0
    ? ` (${(state["refs"] as string[]).join(", ")})`
    : "";
  const specRefs = Array.isArray(spec["refs"]) && (spec["refs"] as string[]).length > 0
    ? ` (${(spec["refs"] as string[]).join(", ")})`
    : "";
  lines.push(`- State: ${String(state["summary"])}${stateRefs}`);
  lines.push(`- Spec: ${String(spec["summary"])}${specRefs}`);
  const reuseObj = finding["reuse"] as JsonObject | null | undefined;
  const reuseLine = renderReuse(reuseObj);
  if (reuseLine) {
    lines.push(`- Reuse: ${reuseLine}`);
  }
  const mark = DECISION_MARK[decision] ?? PENDING_MARK;
  lines.push(`- ${mark} — ${String(finding["id"])}: ${String(finding["summary"])}`);
  lines.push("");
  return lines;
}

function renderUnit(doc: JsonObject, decisions: Record<string, JsonObject>): string[] {
  const unit = doc["unit"] as JsonObject;
  const impl = unit["current_impl"] as JsonObject;
  const flag = (unit["feature_flag"] as JsonObject | null | undefined) ?? {};
  const lines: string[] = [
    `## ${String(unit["name"])} (${String(unit["id"])})`,
    "",
  ];
  lines.push(`**Type:** ${String(unit["type"])}`);
  lines.push(`**Classification:** ${String(unit["classification"])}`);
  if (unit["classification"] === "new" || flag["required"]) {
    const flagName = flag["flag"] ? String(flag["flag"]) : "new flag needed";
    lines.push(`**REQUIRES FEATURE FLAG:** ${flagName}`);
  }
  const paths = Array.isArray(impl["paths"]) ? (impl["paths"] as string[]) : [];
  const implDesc = paths.length > 0
    ? paths.map((p) => `\`${p}\``).join(", ")
    : "not found in current web-ui";
  lines.push(`**Current implementation:** ${implDesc}`);
  const designSources = (unit["design_sources"] as string[]).map((s) => `\`${s}\``).join(", ");
  lines.push(
    `**Design source:** ${designSources} (primary: \`${String(unit["primary_source"])}\`)`
  );
  if (unit["duplication_note"]) {
    lines.push(`**Duplication note:** ${String(unit["duplication_note"])}`);
  }
  if (unit["spec_overlay_notes"]) {
    lines.push(`**Spec overlay notes:** ${String(unit["spec_overlay_notes"])}`);
  }
  lines.push("");

  const themesArr = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
  const themes: Record<string, JsonObject> = {};
  for (const theme of themesArr) {
    themes[String(theme["id"])] = theme;
  }
  if (Object.keys(themes).length > 0) {
    lines.push("**Themes:**");
    for (const theme of Object.values(themes)) {
      const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
      const members = findingsArr.filter((f) => f["theme"] === theme["id"]);
      const themeDecision = (decisions[String(theme["id"])] as JsonObject | undefined) ?? {};
      const decision = themeDecision["state"] ? String(themeDecision["state"]) : "pending";
      lines.push(
        `- \`${String(theme["id"])}\` ${String(theme["title"])} (${members.length} findings, ${decision})`
      );
    }
    lines.push("");
  }

  if (unit["classification"] === "deprecated-do-not-implement") {
    lines.push("Present in the design but deprecated: MUST NOT be implemented.");
    lines.push("");
  }
  const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
  if (findingsArr.length > 0) {
    lines.push("### Findings");
    lines.push("");
    for (const finding of findingsArr) {
      lines.push(...renderFinding(finding, effectiveDecision(finding, decisions)));
    }
  }

  const reuseTable = Array.isArray(doc["component_reuse"])
    ? (doc["component_reuse"] as JsonObject[])
    : [];
  if (reuseTable.length > 0) {
    lines.push("### Component Reuse");
    lines.push("");
    lines.push("| Element added by design | Resolution |");
    lines.push("|---|---|");
    for (const entry of reuseTable) {
      lines.push(`| ${String(entry["element"])} | ${renderReuse(entry) ?? String(entry["resolution"])} |`);
    }
    lines.push("");
  }

  const visual = doc["visual_spec"] as JsonObject | null | undefined;
  if (visual) {
    const colors = (visual["colors"] as JsonObject | undefined) ?? {};
    const resolved = Array.isArray(colors["resolved"]) ? (colors["resolved"] as JsonObject[]) : [];
    const drift = Array.isArray(colors["drift"]) ? (colors["drift"] as JsonObject[]) : [];
    lines.push("### Visual Spec (token-resolved)");
    lines.push("");
    lines.push(
      `- Colors: ${resolved.length} resolved to tokens, ` +
      `${drift.length} drifting from the design system`
    );
    if (visual["icons"] && Array.isArray(visual["icons"])) {
      const icons = (visual["icons"] as string[]).slice(0, 20);
      lines.push(`- Icons: ${icons.join(", ")}`);
    }
    const layout = (visual["layout"] as JsonObject | undefined) ?? {};
    const facts = Object.entries(layout)
      .filter(([k, v]) => k !== "utility_classes" && v)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    if (facts) {
      lines.push(`- Layout: ${facts}`);
    }
    lines.push("");
  }
  return lines;
}

function renderReport(
  docs: JsonObject[],
  decisions: Record<string, JsonObject>,
  exportName: string,
  notAnalyzed: string[],
): string {
  const byClass: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const decisionCounts: Record<string, number> = {
    pending: 0,
    accepted: 0,
    declined: 0,
    edited: 0,
  };
  const flagUnits: string[] = [];
  const newComponents: Map<string, [string, string]> = new Map();
  const backend: string[] = [];
  const drift: string[] = [];
  const pendingLines: string[] = [];

  for (const doc of docs) {
    const unit = doc["unit"] as JsonObject;
    const cls = String(unit["classification"]);
    byClass[cls] = (byClass[cls] ?? 0) + 1;
    const flag = (unit["feature_flag"] as JsonObject | null | undefined) ?? {};
    if (cls === "new" || flag["required"]) {
      flagUnits.push(String(unit["name"]));
    }
    const reuseTable = Array.isArray(doc["component_reuse"])
      ? (doc["component_reuse"] as JsonObject[])
      : [];
    for (const entry of reuseTable) {
      if (entry["resolution"] === "new-component") {
        const key = entry["proposed_name"] ? String(entry["proposed_name"]) : String(entry["element"]);
        if (!newComponents.has(key)) {
          newComponents.set(key, [String(entry["element"]), String(unit["name"])]);
        }
      }
    }
    const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
    for (const finding of findingsArr) {
      const cat = String(finding["category"]);
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const decision = effectiveDecision(finding, decisions);
      decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;
      if (cat === "backend-gap") {
        backend.push(`${String(finding["id"])} — ${String(finding["summary"])} (${String(unit["name"])})`);
      }
      if (cat === "token-drift") {
        drift.push(`${String(finding["id"])} — ${String(finding["summary"])} (${String(unit["name"])})`);
      }
      if (decision === "pending") {
        pendingLines.push(
          `- [ ] Accept / [ ] Decline — ${String(finding["id"])}: ${String(finding["summary"])}`
        );
      }
      const reuse = (finding["reuse"] as JsonObject | null | undefined) ?? {};
      if (reuse["resolution"] === "new-component") {
        const key = reuse["proposed_name"] ? String(reuse["proposed_name"]) : String(finding["title"]);
        if (!newComponents.has(key)) {
          newComponents.set(key, [String(finding["title"]), String(unit["name"])]);
        }
      }
    }
  }

  const out: string[] = [
    `# Design Inventory Report — ${exportName}`,
    "",
    "## Summary",
    "",
  ];
  const classSummary = Object.entries(byClass)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  out.push(`- Units analyzed: ${docs.length} (${classSummary})`);
  const categories = FINDING_CATEGORIES
    .filter((c) => byCategory[c])
    .map((c) => `${c} ${byCategory[c] ?? 0}`)
    .join(", ");
  out.push(`- Findings: ${Object.values(byCategory).reduce((a, b) => a + b, 0)} (${categories})`);
  out.push(
    `- Decisions: ${decisionCounts["pending"] ?? 0} pending, ` +
    `${decisionCounts["accepted"] ?? 0} accepted, ${decisionCounts["declined"] ?? 0} declined`
  );
  if (flagUnits.length > 0) {
    const sorted = [...new Set(flagUnits)].sort();
    out.push(`- Units requiring feature flags: ${sorted.join(", ")}`);
  }
  out.push(`- Net-new components required: ${newComponents.size}`);
  out.push("");

  const deprecated = docs.filter((d) => (d["unit"] as JsonObject)["classification"] === "deprecated-do-not-implement");
  if (deprecated.length > 0) {
    out.push("## Do Not Implement");
    out.push("");
    for (const doc of deprecated) {
      const unit = doc["unit"] as JsonObject;
      out.push(
        `- **${String(unit["name"])}** (\`${String(unit["id"])}\`): present in the design but deprecated; do not implement.`
      );
    }
    out.push("");
  }

  out.push("## Units");
  out.push("");
  for (const doc of docs) {
    out.push(...renderUnit(doc, decisions));
    out.push("---");
    out.push("");
  }

  if (pendingLines.length > 0) {
    out.push("## Decisions Needed");
    out.push("");
    out.push(...pendingLines);
    out.push("");
  }
  if (backend.length > 0) {
    out.push("## Backend Gaps");
    out.push("");
    out.push(...backend.map((b) => `- ${b}`));
    out.push("");
  }
  if (drift.length > 0) {
    out.push("## Token Drift");
    out.push("");
    out.push(...drift.map((d) => `- ${d}`));
    out.push("");
  }
  if (newComponents.size > 0) {
    out.push("## New Components Required");
    out.push("");
    out.push("| Proposed component | Element | Needed by |");
    out.push("|---|---|---|");
    for (const [name, [element, unitName]] of [...newComponents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`| ${name} | ${element} | ${unitName} |`);
    }
    out.push("");
  }
  if (notAnalyzed.length > 0) {
    out.push("## Not Analyzed");
    out.push("");
    out.push(...notAnalyzed.map((entry) => `- ${entry}`));
    out.push("");
  }
  return out.join("\n");
}

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      findings: { type: "string", multiple: true },
      out: { type: "string" },
      decisions: { type: "string" },
      "export-name": { type: "string", default: "design export" },
      "not-analyzed": { type: "string", multiple: true },
    },
  });

  const findingsPaths = values["findings"] ?? [];
  if (findingsPaths.length === 0) {
    console.error("error: no findings documents found");
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
  const allErrors = [...errors];
  let decisionsMap: Record<string, JsonObject> = {};

  const decisionsPath = values["decisions"];
  if (decisionsPath) {
    let decisionsDoc: unknown;
    try {
      decisionsDoc = JSON.parse(readFileSync(decisionsPath, "utf-8"));
    } catch (exc) {
      allErrors.push(
        `${decisionsPath}: unreadable: ${exc instanceof Error ? exc.message : String(exc)}`
      );
      decisionsDoc = null;
    }
    if (decisionsDoc !== null) {
      const decisionErrors = validateDecisions(decisionsDoc);
      if (decisionErrors.length > 0) {
        allErrors.push(...decisionErrors.map((e) => `${decisionsPath}: ${e}`));
      } else {
        decisionsMap = (decisionsDoc as JsonObject)["decisions"] as Record<string, JsonObject>;
      }
    }
  }

  if (allErrors.length > 0) {
    for (const error of allErrors) {
      console.error(error);
    }
    return 1;
  }

  const exportName = String(values["export-name"] ?? "design export");
  const notAnalyzed = values["not-analyzed"] ?? [];
  const report = renderReport(docs, decisionsMap, exportName, notAnalyzed);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, "utf-8");
  console.log(outPath);
  return 0;
}

runWhenMain(import.meta.url, main);
