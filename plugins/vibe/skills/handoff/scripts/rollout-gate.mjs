#!/usr/bin/env node
// A PRD's rollout gate is part of its scope. One PRD required a closed-by-default
// flag, the legacy list kept as a rollback path until parity, and a staged
// cohort rollout; a pull request deleted the legacy list and shipped the new
// surface to everyone, and agents then closed the rollout tickets citing a
// ruling about a different surface.
//
// Every rollout requirement (a ticket acceptance criterion, or a PRD checkbox or
// bullet under a rollout or rollback heading, that names a flag, a rollback or
// legacy path, a cohort or a staged rollout) needs a change log line:
//   Rollout: <AC-n | PRD-n>: <file>:<line>                                 (the code that does it, at HEAD)
//   Rollout: <AC-n | PRD-n>: ruling <human name or operator ruling>, <YYYY-MM-DD>, <where>
// A flag requirement's line reads a flag; a ruling names the ticket or PRD it
// is applied to (a ruling about another surface does not cover this one).
//
// Usage: rollout-gate.mjs --worktree <path> --ticket <ticket body .md> --slug <ticket slug> [--prd <PRD body .md> --prd-slug <slug>] [--change-log <file>]
// Prints {"ok","requirements","problems"}; exits 1 on any problem. Changes nothing.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../vibe/scripts/session-record.mjs";
import { criteriaStates } from "./criteria-audit.mjs";
import { rulingNamesScope } from "./rulings-check.mjs";
import { escapeRegExp } from "./source-imports.mjs";

export const ROLLOUT = /\b(?:feature (?:flag|switch)|flag(?:-gated|ged)?|closed[- ]by[- ]default|default[- ]off|rollback|roll back|legacy|cohort|staged rollout|rollout|kill switch|percentage rollout)\b/i;
const FLAG = /\b(?:feature (?:flag|switch)|flag|closed[- ]by[- ]default|default[- ]off|kill switch)\b/i;
const FLAG_READ = /flag/i;
const ROLLOUT_HEADING = /^#{1,6}\s+.*\b(?:rollout|rollback|release plan|launch plan|feature flags?)\b/i;
const HEADING = /^(#{1,6})\s/;
const BULLET = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(\S.*)$/;
const RULING = /^ruling\s+(?:operator ruling|[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+),\s*\d{4}-\d{2}-\d{2},\s*\S/;
const CODE = /^(\S+?):(\d+)\s*$/;

/** The rollout requirements in a ticket body (AC-n) and a PRD body (PRD-n). */
export function rolloutRequirements(ticket, prd = "") {
  const fromTicket = criteriaStates(ticket).filter((criterion) => ROLLOUT.test(criterion.text)).map(({ id, text }) => ({ id, text }));
  const fromPrd = [];
  let level = 0;
  let count = 0;
  for (const line of prd.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      level = ROLLOUT_HEADING.test(line) ? heading[1].length : level && heading[1].length > level ? level : 0;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && (level || (/^\s*[-*]\s+\[[ xX]\]/.test(line) && ROLLOUT.test(bullet[1])))) {
      count += 1;
      if (ROLLOUT.test(bullet[1]) || level) fromPrd.push({ id: `PRD-${count}`, text: bullet[1] });
    }
  }
  return [...fromTicket, ...fromPrd];
}

/** Problems for each requirement without code at HEAD or a ruling scoped to this ticket or PRD. */
export function rolloutProblems(requirements, changeLog, { lineAt }, scope) {
  const problems = [];
  for (const requirement of requirements) {
    const match = new RegExp(String.raw`^\s*(?:[-*]\s+)?Rollout:\s*${escapeRegExp(requirement.id)}:\s*(.+?)\s*$`, "m").exec(changeLog);
    const label = `${requirement.id} "${requirement.text.slice(0, 100)}"`;
    if (!match) {
      problems.push(`${label} has no \`Rollout: ${requirement.id}: <file>:<line>\` or scoped ruling; build it, or cite a human ruling that names ${scope.join(" or ")}`);
      continue;
    }
    const evidence = match[1];
    if (/^ruling\b/i.test(evidence)) {
      if (!RULING.test(evidence)) problems.push(`${label}: a ruling needs a human name or operator ruling, a date and where it was said`);
      else if (!rulingNamesScope(evidence, scope)) problems.push(`${label}: the ruling names neither ${scope.join(" nor ")}; a ruling about another ticket or surface does not cover this one`);
      continue;
    }
    const code = CODE.exec(evidence);
    const text = code ? lineAt(code[1], Number(code[2])) : null;
    if (text === null) problems.push(`${label}: ${evidence} is not a line at HEAD; a deleted or missing path does not keep a rollout or rollback requirement`);
    else if (FLAG.test(requirement.text) && !FLAG_READ.test(text)) problems.push(`${label}: ${evidence} reads no flag`);
  }
  return problems;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, ticket: { type: "string" }, slug: { type: "string" }, prd: { type: "string" }, "prd-slug": { type: "string" }, "change-log": { type: "string" },
  } });
  if (!values.worktree || !values.ticket || !values.slug || (values.prd && !values["prd-slug"])) {
    throw new Error("Usage: rollout-gate.mjs --worktree <path> --ticket <body> --slug <ticket slug> [--prd <body> --prd-slug <slug>] [--change-log <file>]");
  }
  const worktree = path.resolve(values.worktree);
  const logFile = values["change-log"] ?? path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-changes.md");
  const requirements = rolloutRequirements(readFileSync(values.ticket, "utf8"), values.prd ? readFileSync(values.prd, "utf8") : "");
  const lineAt = (file, line) => {
    const full = path.join(worktree, file);
    if (!full.startsWith(`${worktree}${path.sep}`) || !existsSync(full)) return null;
    return readFileSync(full, "utf8").split("\n")[line - 1] ?? null;
  };
  const problems = rolloutProblems(requirements, existsSync(logFile) ? readFileSync(logFile, "utf8") : "", { lineAt }, [values.slug, values["prd-slug"]].filter(Boolean));
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, requirements: requirements.map(({ id }) => id), problems }, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
