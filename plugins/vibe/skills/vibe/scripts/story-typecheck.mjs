#!/usr/bin/env node
// A typecheck for changed Storybook stories whose package has no typecheck
// script. PR #9732 said typecheck passed for `storybook`, which has
// no such script, and shipped a TS2345 in a changed story: no repository lane
// typechecks those stories. pre-pr-lanes.mjs adds this lane to the selected
// lanes whenever the diff changes such a story, so it is run and recorded like
// any other lane.
//
// Usage: story-typecheck.mjs --worktree <path> --base <sha>
//
// For each package that owns a changed story and has a tsconfig.json but no
// "typecheck" script, it runs `pnpm exec tsc --noEmit --incremental false
// --pretty false -p tsconfig.json` in that package. It fails on any error on a
// line the diff adds (committed, uncommitted or untracked) and on a tsc
// failure it cannot attribute to a file. Errors on other lines are counted and
// printed but do not fail: one repository's storybook tsconfig already reports
// about 150 errors on main (most are TS2307 for the `@/` alias the Storybook
// bundler resolves), so a whole-package or whole-file verdict would either
// always fail or, recorded main-preexisting, hide the new error. Exits 0 when
// nothing needs it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const STORY = /\.stories\.tsx?$/;
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
export const STORY_TYPECHECK_SCRIPT = fileURLToPath(import.meta.url);
const TSC_ARGS = ["exec", "tsc", "--noEmit", "--incremental", "false", "--pretty", "false", "-p", "tsconfig.json"];

/** Files the worktree changes against `base`: committed, uncommitted and untracked. */
export function changedFiles(worktree, base) {
  return [...addedLines(worktree, base).keys()].sort();
}

/** Each changed file's added line numbers against `base`; an untracked file adds every line. */
export function addedLines(worktree, base) {
  const run = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = new Map();
  let file = null;
  for (const line of run(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=ACMRT", base, "--"]).split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice("+++ b/".length);
      if (file) lines.set(file, lines.get(file) ?? new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    for (let offset = 0; offset < Number(hunk[2] ?? 1); offset += 1) lines.get(file).add(start + offset);
  }
  for (const untracked of run(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    let count = 0;
    try { count = readFileSync(path.join(worktree, untracked), "utf8").split("\n").length; } catch { /* A directory or unreadable entry adds no line. */ }
    lines.set(untracked, new Set(Array.from({ length: count }, (_, index) => index + 1)));
  }
  return lines;
}

/** Package directories that own a changed story and have a tsconfig.json but no "typecheck" script. */
export function storyTypecheckTargets(worktree, files) {
  const targets = new Set();
  for (const file of files.filter((entry) => STORY.test(entry))) {
    let directory = path.posix.dirname(file);
    for (;;) {
      const manifest = path.join(worktree, directory, "package.json");
      if (existsSync(manifest)) {
        let scripts = {};
        try { scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {}; } catch { /* An unreadable manifest has no typecheck script. */ }
        if (!Object.hasOwn(scripts, "typecheck") && existsSync(path.join(worktree, directory, "tsconfig.json"))) targets.add(directory);
        break;
      }
      if (directory === "." || directory === "") break;
      directory = path.posix.dirname(directory);
    }
  }
  return [...targets].sort();
}

/** The lane command for this diff, or null when no changed story needs it. */
export function storyTypecheckLane(worktree, base) {
  if (!base || storyTypecheckTargets(worktree, changedFiles(worktree, base)).length === 0) return null;
  return `node ${JSON.stringify(STORY_TYPECHECK_SCRIPT)} --worktree . --base ${base}`;
}

/** Split tsc output for one package into errors on added lines and the rest; `attributed` is false when nothing parsed. */
export function classifyDiagnostics(output, packageDir, added) {
  const inChanged = [];
  const elsewhere = [];
  for (const line of output.split("\n")) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (!match) continue;
    const file = path.posix.normalize(path.posix.join(packageDir, match[1].replaceAll("\\", "/")));
    (added.get(file)?.has(Number(match[2])) ? inChanged : elsewhere).push(`${file}:${match[2]}:${match[3]} ${match[4]} ${match[5]}`);
  }
  return { inChanged, elsewhere, attributed: inChanged.length + elsewhere.length > 0 };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, base: { type: "string" } } });
  if (!values.worktree || !values.base) throw new Error("Usage: story-typecheck.mjs --worktree <path> --base <sha>");
  const worktree = path.resolve(values.worktree);
  const added = addedLines(worktree, values.base);
  const files = [...added.keys()];
  let failed = false;
  for (const packageDir of storyTypecheckTargets(worktree, files)) {
    const result = spawnSync("pnpm", TSC_ARGS, { cwd: path.join(worktree, packageDir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const { inChanged, elsewhere, attributed } = classifyDiagnostics(output, packageDir, added);
    for (const line of inChanged) process.stdout.write(`STORY-TYPE-ERROR ${line}\n`);
    if (elsewhere.length) process.stdout.write(`${packageDir}: ${elsewhere.length} type errors on lines this diff does not add (not counted)\n`);
    if (inChanged.length || (result.status !== 0 && !attributed)) {
      failed = true;
      if (!attributed) process.stdout.write(`${packageDir}: tsc failed without a file diagnostic: ${(result.error?.message ?? output).trim().split("\n").slice(-3).join(" | ")}\n`);
    } else process.stdout.write(`${packageDir}: no type errors on added lines\n`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
