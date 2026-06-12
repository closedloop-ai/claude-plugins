/**
 * Cross-unit theme-id duplicate guard for the design-inventory pipeline.
 *
 * Theme ids must be globally unique across all findings documents because they
 * are used as heading anchors in the review document, as keys in decisions.json,
 * and as criteria references in the ticket plan. When two units emit the same
 * theme id (e.g. both pick "thm-artifact-table") the surviving-id logic in
 * derive-decisions-from-doc and the ticket plan would silently conflate them.
 *
 * The check runs BEFORE rendering, deriving, or planning. On violation it
 * returns a non-empty error list; callers must print the errors and exit 1.
 */

import type { JsonObject } from "./design-findings-schema.js";

export interface ThemeIdViolation {
  themeId: string;
  unitIds: string[];
}

/**
 * Check that every theme id appears in at most ONE unit's findings document.
 *
 * Returns an empty array when all ids are unique. Returns one entry per
 * duplicated id when violations are found.
 */
export function findDuplicateThemeIds(docs: JsonObject[]): ThemeIdViolation[] {
  // Map: theme id -> list of unit ids that declare it
  const themeToUnits = new Map<string, string[]>();

  for (const doc of docs) {
    const unit = doc["unit"] as JsonObject;
    const unitId = String(unit["id"]);
    const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
    for (const theme of themes) {
      const tid = String(theme["id"]);
      let existing = themeToUnits.get(tid);
      if (!existing) {
        existing = [];
        themeToUnits.set(tid, existing);
      }
      existing.push(unitId);
    }
  }

  const violations: ThemeIdViolation[] = [];
  for (const [themeId, unitIds] of themeToUnits) {
    if (unitIds.length > 1) {
      violations.push({ themeId, unitIds });
    }
  }
  return violations;
}

/**
 * Build a human-readable error block for duplicate theme ids and print it to
 * stderr. Returns a non-zero exit code (1) when violations exist, 0 otherwise.
 *
 * Prints nothing and returns 0 when there are no violations.
 */
export function checkThemeIdUniqueness(docs: JsonObject[]): number {
  const violations = findDuplicateThemeIds(docs);
  if (violations.length === 0) return 0;

  console.error("error: duplicate theme ids detected across findings documents");
  for (const v of violations) {
    console.error(
      `  theme id '${v.themeId}' is declared by units: ${v.unitIds.join(", ")}`,
    );
  }
  console.error(
    "remediation: theme ids must be unit-scoped (recommended: thm-<unit-slug>-<topic>); " +
    "rename in the affected findings.json and re-render",
  );
  return 1;
}
