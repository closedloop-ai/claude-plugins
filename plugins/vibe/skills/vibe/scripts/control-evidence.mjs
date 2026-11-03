#!/usr/bin/env node
// Relocate one owned control run's captures out of publication inputs.

import { existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";

/**
 * Moves one named control run to private git storage after control is down.
 * The caller must name only a run it started; sibling runs are never scanned.
 */
export function relocateControlEvidence(worktree, run) {
  const root = realpathSync(worktree);
  const runs = path.join(root, ".control", "runs");
  const source = realpathSync(run);
  const relative = path.relative(runs, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
    || !statSync(source).isDirectory()) {
    throw new Error("Control evidence must name one owned run directory under this worktree.");
  }
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  const target = path.join(gitDir, "vibe-control-runs", relative);
  if (existsSync(target)) throw new Error("Private control evidence already exists; refusing to overwrite it.");
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(source, target);
  return { path: target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { worktree: { type: "string" }, run: { type: "string" } } });
    if (!values.worktree || !values.run) throw new Error("Usage: control-evidence.mjs --worktree <path> --run <owned .control/runs directory>");
    process.stdout.write(`${JSON.stringify(relocateControlEvidence(values.worktree, values.run))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
