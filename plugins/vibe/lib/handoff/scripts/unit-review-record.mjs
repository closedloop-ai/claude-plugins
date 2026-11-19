// The recorded review of a grouped unit's completed work: vibe's
// handoff/scripts/unit-review.mjs --record writes it to the fleet program's
// evidence directory, and this reads it for vibe's board.mjs and status-audit.mjs
// and for the ticket status guard (hooks/unit-status-guard.mjs). A unit is not
// ready, closed or moved to In Review or Done until its recorded review passed
// and covers every one of its tickets (operator ruling, 2026-11-10).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

/** The review file for a unit on a program's board. */
export function unitReviewFile(orchDir, unit) {
  return path.join(resolveWorkDir(orchDir).dir, "evidence", `unit-review-${unit.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
}

/** The recorded review of a unit, or null when none was recorded. */
export function readUnitReview(orchDir, unit) {
  const file = unitReviewFile(orchDir, unit);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Why a unit may not be reported ready, closed or moved on: null only after a passing recorded review covering every one of its tickets. */
export function unitReviewProblem(orchDir, name, unit) {
  let record;
  try { record = readUnitReview(orchDir, name); }
  catch (error) { return `unit ${name}'s review record cannot be read (${error instanceof Error ? error.message : String(error)})`; }
  if (!record) return `unit ${name} has no recorded review; run handoff's unit-review.mjs with --record`;
  if (record.ok !== true) return `unit ${name}'s review has ${record.gaps?.length ?? 0} gaps and ${record.problems?.length ?? 0} problems`;
  const uncovered = (unit?.tickets ?? []).filter((slug) => !(record.tickets ?? []).includes(slug));
  return uncovered.length === 0 ? null : `unit ${name}'s review does not cover ${uncovered.join(", ")}, added after it ran`;
}

/** The board's open units (a unit closed with board.mjs unit --closed is finished), `{}` when it has none. */
export function openBoardUnits(orchDir) {
  const file = path.join(resolveWorkDir(orchDir).dir, "board.json");
  const units = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).units ?? {} : {};
  return Object.fromEntries(Object.entries(units).filter(([, unit]) => !unit.closed));
}
