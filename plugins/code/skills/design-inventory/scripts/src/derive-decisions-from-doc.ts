/**
 * Derive decisions.json from a human-edited review document (PLN-859 P4a).
 *
 * Humans review by deleting or editing sections of the markdown body produced
 * by render-review-doc. Survival is judged ONLY from HEADING lines (lines
 * matching /^#{2,4}\s/) that carry an id anchor in backticks. Ids appearing
 * in bullets, tables, or the Backend gaps rollup do NOT count as survival.
 *
 * Usage:
 *     node derive-decisions-from-doc.mjs \
 *         --doc <review-body.md> \
 *         --findings <file-or-dir> [--findings ...] \
 *         --out <decisions.json> \
 *         --reviewer <string>
 *
 * Exit codes: 0 ok, 1 validation/input error.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  validateFindings,
  validateDecisions,
  FINDING_ID,
  THEME_ID,
  type JsonObject,
} from "./design-findings-schema.js";
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
          if (
            typeof doc === "object" &&
            doc !== null &&
            !Array.isArray(doc) &&
            !("decisions" in doc)
          ) {
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
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse heading level from a line like "## foo" or "### bar".
 * Returns 0 if the line is not a heading.
 */
function headingLevel(line: string): number {
  const m = /^(#{2,4})\s/.exec(line);
  return m ? m[1]!.length : 0;
}

/**
 * Extract all ids (FINDING_ID or THEME_ID) found inside backticks on HEADING
 * lines only. Lines that are not headings are ignored entirely.
 *
 * A heading line is any line matching /^#{2,4}\s/.
 * Ids inside backticks on non-heading lines (table rows, bullets, etc.) are
 * intentionally excluded.
 */
export function extractSurvivingIds(body: string): Set<string> {
  const surviving = new Set<string>();
  const lines = body.split("\n");
  for (const line of lines) {
    if (!/^#{2,4}\s/.test(line)) continue;
    // Extract all backtick-enclosed tokens on this heading line
    const backtickRe = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = backtickRe.exec(line)) !== null) {
      const token = m[1]!;
      if (FINDING_ID.test(token) || THEME_ID.test(token)) {
        surviving.add(token);
      }
    }
  }
  return surviving;
}

/**
 * Extract the text body of the section that begins at the heading line
 * containing the given id. The section extends until the next heading of the
 * same or higher (numerically lower) level, or end of document.
 *
 * Returns null if the id is not found on any heading line.
 */
export function sectionFor(body: string, id: string): string | null {
  const lines = body.split("\n");
  let startIndex = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^#{2,4}\s/.test(line)) continue;
    // Check if this heading contains the id in backticks
    const backtickRe = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = backtickRe.exec(line)) !== null) {
      if (m[1] === id) {
        startIndex = i;
        sectionLevel = headingLevel(line);
        break;
      }
    }
    if (startIndex !== -1) break;
  }

  if (startIndex === -1) return null;

  // Collect lines from startIndex until a heading of same or higher level
  const sectionLines: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;
    if (i !== startIndex) {
      const lvl = headingLevel(line);
      if (lvl > 0 && lvl <= sectionLevel) {
        // Same or higher level heading: section ends here
        break;
      }
    }
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

/**
 * Extract the text from a "What changes:" line inside a section body.
 * Returns null if the line is absent.
 * Matches: `- **What changes:** <text>`
 */
function extractWhatChanges(section: string): string | null {
  const lines = section.split("\n");
  for (const line of lines) {
    const m = /^-\s+\*\*What changes:\*\*\s+(.+)$/.exec(line.trimEnd());
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * Core decision derivation logic. No timestamps generated here.
 *
 * For every theme id across all findings docs:
 *   - surviving heading -> accepted
 *   - absent -> declined
 *
 * For every finding id:
 *   - absent from surviving set -> declined
 *   - present -> locate section, check What changes text against finding.summary
 *     - differs -> { state: "edited", edited_summary: <text> }
 *     - same (or What changes line missing) -> accepted
 */
export function deriveDecisions(
  findingsDocs: JsonObject[],
  body: string,
  reviewer: string,
  decidedAt: string,
): JsonObject {
  const surviving = extractSurvivingIds(body);
  const decisions: Record<string, JsonObject> = {};

  for (const doc of findingsDocs) {
    // Process themes
    const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
    for (const theme of themes) {
      const tid = String(theme["id"]);
      if (!tid) continue;
      decisions[tid] = surviving.has(tid) ? { state: "accepted" } : { state: "declined" };
    }

    // Process findings
    const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
    for (const finding of findings) {
      const fid = String(finding["id"]);
      if (!fid) continue;

      if (!surviving.has(fid)) {
        decisions[fid] = { state: "declined" };
        continue;
      }

      // Finding is present in surviving headings; check for edits
      const section = sectionFor(body, fid);
      const whatChanges = section !== null ? extractWhatChanges(section) : null;
      const originalSummary = String(finding["summary"] ?? "");

      if (whatChanges !== null && whatChanges !== originalSummary) {
        decisions[fid] = { state: "edited", edited_summary: whatChanges };
      } else {
        decisions[fid] = { state: "accepted" };
      }
    }
  }

  return {
    schema_version: 1,
    reviewer,
    decided_at: decidedAt,
    decisions,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      doc: { type: "string" },
      findings: { type: "string", multiple: true },
      out: { type: "string" },
      reviewer: { type: "string" },
    },
  });

  const docPath = values["doc"];
  if (!docPath) {
    console.error("error: --doc is required");
    return 1;
  }

  const findingsPaths = values["findings"] ?? [];
  if (findingsPaths.length === 0) {
    console.error("error: --findings is required");
    return 1;
  }

  const outPath = values["out"];
  if (!outPath) {
    console.error("error: --out is required");
    return 1;
  }

  const reviewer = values["reviewer"];
  if (!reviewer) {
    console.error("error: --reviewer is required");
    return 1;
  }

  // Load review document body
  let body: string;
  try {
    body = readFileSync(docPath, "utf-8");
  } catch (exc) {
    console.error(`error: ${docPath}: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  // Load findings
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

  // Derive decisions
  const decidedAt = new Date().toISOString();
  const output = deriveDecisions(docs, body, reviewer, decidedAt);

  // Validate before writing
  const validationErrors = validateDecisions(output);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) {
      console.error(`validation error: ${error}`);
    }
    return 1;
  }

  // Write output
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(outPath);

  // Print summary
  const decisionsMap = output["decisions"] as Record<string, JsonObject>;
  let accepted = 0;
  let declined = 0;
  let edited = 0;
  for (const d of Object.values(decisionsMap)) {
    const state = d["state"];
    if (state === "accepted") accepted++;
    else if (state === "declined") declined++;
    else if (state === "edited") edited++;
  }
  console.log(JSON.stringify({ accepted, declined, edited }));

  return 0;
}

runWhenMain(import.meta.url, main);
