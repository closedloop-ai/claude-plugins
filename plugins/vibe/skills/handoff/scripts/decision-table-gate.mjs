import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { localPlanPaths } from "../../vibe/scripts/local-plans.mjs";

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return null;
  const body = text.slice(start + heading.length + 3);
  const end = body.search(/^##\s/m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

/** Stale decision-table state that must stop handoff before reviews and publication. */
export function decisionTableProblems(worktree) {
  const root = realpathSync(worktree);
  const directory = path.dirname(localPlanPaths(root).decisionTable);
  if (!existsSync(directory)) return [];
  const problems = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".md")).sort()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || realpathSync(file).slice(0, directory.length + 1) !== `${directory}${path.sep}`) {
      problems.push(`${name}: decision table is not a contained regular file`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const status = section(text, "Final Alignment Status");
    if (!status) problems.push(`${name}: Final Alignment Status is missing`);
    else if (/\bNot aligned\b/i.test(status)) problems.push(`${name}: Final Alignment Status is still Not aligned`);
    else if (!/\bAligned\b/i.test(status)) problems.push(`${name}: Final Alignment Status does not say Aligned`);
    const aligned = !/\bNot aligned\b/i.test(status ?? "") && /\bAligned\b/i.test(status ?? "");
    if (aligned && !/^## Frozen Behavior\s*$/m.test(text)) {
      problems.push(`${name}: Frozen Behavior is missing from the aligned table`);
    }
    const missing = section(text, "Missing tests") ?? "";
    for (const line of text.split("\n").filter((entry) => /built[^|\n]*without (?:a )?test|built[^|\n]*no test/i.test(entry))) {
      const row = /\b(?:DT|ROW)-[A-Za-z0-9.-]+\b/.exec(line)?.[0];
      if (!row || !missing.includes(row)) problems.push(`${name}: ${row ?? "a row"} is built without a test and is absent from Missing tests`);
    }
  }
  return problems;
}
