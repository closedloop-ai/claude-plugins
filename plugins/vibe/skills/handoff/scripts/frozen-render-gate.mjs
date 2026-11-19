#!/usr/bin/env node
// The frozen-render gate as one shell step, with no agent: it selects the frozen story files the handoff
// `frozen-render` rule would name (selectFrozenStoryFiles, without the session's local fixes), plus any a changed
// generated render input reaches, which that rule leaves to its source; builds both static Storybooks, renders them with
// frozen-render.mjs, writes results.json and, on a pass, appends the `Frozen render unchanged` line to the change log.
// It prints exactly one line and exits with its code:
//   FROZEN PASS <files> files <stories> stories inputs <digest>   exit 0 (also when nothing is selected)
//   FROZEN BLOCK <k> stories: <results.json>                     exit 1; read only the cropped diffs it names
//   FROZEN ERROR <reason>                                        exit 2, a usage or setup error, including no bound
//                                                                vibe provider layout to select with
//
// Usage:
//   frozen-render-gate.mjs --repo <session worktree> --base <base commit> [--base-dir <prepared base worktree>]
//                          [--out <dir>] [--change-log <file>] [--viewport WxH] [--timeout-ms N] [--now <ISO time>]
//                          [--workers N] [--cache-dir <dir> | --no-cache]
// Without --base-dir, when a story file is selected, the gate makes the base worktree itself with prepare-base
// (frozen-render.mjs), bootstraps it with the repository's bootstrap (setup-ctl.mjs bootstrap) and, once its line is
// printed, unregisters it from git and leaves deleting its files to a detached background process; --base-dir
// names an already prepared one instead. --out defaults to a new directory under the worktree's git directory;
// --change-log to the change log handoff's diff rules read (`vibe-changes.md` in the worktree's git directory). Run it as its own shell step, not inside a fleet heavy slot: its static builds take that slot themselves.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromiumLauncher, frozenInputs, prepareBase, renderOptions, runOwnedFrozenComparison, selectFrozenStoryFiles } from "./frozen-render.mjs";
import { localFixPaths } from "./local-fix-paths.mjs";
import { repositoryLayout } from "../../vibe/scripts/area-paths.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");

export const GateExit = Object.freeze({ Pass: 0, Block: 1, Error: 2 });
const USAGE = "Usage: frozen-render-gate.mjs --repo <worktree> --base <commit> [--base-dir <prepared base worktree>] [--out <dir>] [--change-log <file>] [--viewport WxH] [--timeout-ms N] [--now <ISO time>] [--workers N] [--cache-dir <dir> | --no-cache]";
const WHITESPACE_RUN = /\s+/g;
const SETUP_CTL = fileURLToPath(new URL("../../vibe/scripts/setup-ctl.mjs", import.meta.url));
const BOOTSTRAP_OK = "OK";

/**
 * Runs the gate and returns its one line and exit code, handing them to `onVerdict` first. `dependencies` replace
 * selection, the comparison, the input digest, the browser launcher and the base worktree's preparation, bootstrap and
 * removal in tests.
 */
export async function frozenGate({ repo, base, baseDir, out, changeLog, onVerdict = () => {}, ...render }, {
  select = selectFrozenStoryFiles, compare = runOwnedFrozenComparison, inputsOf = frozenInputs, launch = () => chromiumLauncher(repo),
  prepare = prepareBase, bootstrap = bootstrapWorktree, removeWorktree = detachWorktree, record = readSessionRecord, layout = repositoryLayout,
} = {}) {
  // Without the provider's layout, import aliases, the Storybook preview and render manifests are unknown, so an
  // empty selection would be a false pass.
  if (Object.keys(layout() ?? {}).length === 0) return gateError("no vibe provider layout is bound; selection cannot be computed");
  // The session's local fixes are left out exactly as the inventory leaves them out of the frozen-render rule.
  const storyFiles = select(repo, base, new Set(localFixPaths(record(repo)).keys()));
  if (storyFiles.length === 0) {
    return { exitCode: GateExit.Pass, line: `FROZEN PASS 0 files 0 stories inputs ${inputsOf(repo, base, [])}` };
  }
  if (baseDir) return compareAndRecord({ repo, base, baseDir, out, changeLog, storyFiles, render, compare, launch });
  const ownBase = path.join(out, "base-worktree");
  prepare({ repo, base, storyFiles, dir: ownBase });
  try {
    const bootstrapped = bootstrap(ownBase);
    const verdict = bootstrapped.status === BOOTSTRAP_OK
      ? await compareAndRecord({ repo, base, baseDir: ownBase, out, changeLog, storyFiles, render, compare, launch })
      : gateError(`the base worktree's bootstrap did not finish (${bootstrapped.status}): ${bootstrapped.reason ?? bootstrapped.error ?? ""}`);
    // The verdict and its change-log line are final here; removing the base worktree is not on their path.
    onVerdict(verdict);
    return verdict;
  } finally {
    removeWorktree(repo, ownBase);
  }
}

async function compareAndRecord({ repo, base, baseDir, out, changeLog, storyFiles, render, compare, launch }) {
  const summary = await compare({ repo, baseDir, base, storyFiles, out, staticBuild: true, ...render }, { launch: launch() });
  const results = path.join(out, "results.json");
  if (summary.ok && summary.changeLogLine) {
    const existing = existsSync(changeLog) ? readFileSync(changeLog, "utf8") : "";
    appendFileSync(changeLog, `${existing && !existing.endsWith("\n") ? "\n" : ""}${summary.changeLogLine}\n`);
    return { exitCode: GateExit.Pass, line: `FROZEN PASS ${summary.storyFiles} files ${summary.stories} stories inputs ${summary.inputs}` };
  }
  if (summary.blocking?.length) {
    return { exitCode: GateExit.Block, line: `FROZEN BLOCK ${summary.blocking.length} stories: ${results}` };
  }
  return gateError(summary.lines?.at(-1) ?? "the comparison returned no verdict");
}

/** The repository's bootstrap for `worktree` through setup-ctl.mjs, as its one JSON result line. */
function bootstrapWorktree(worktree) {
  const result = spawnSync(process.execPath, [SETUP_CTL, "bootstrap", "--worktree", worktree], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { status: "unreadable", reason: `setup-ctl.mjs did not run: ${result.error.message}` };
  // setup-ctl.mjs prints its JSON result line whatever its exit status, so the line, not the status, is the verdict.
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    return { status: "unreadable", reason: `setup-ctl.mjs exited ${result.status}` };
  }
}

/**
 * Takes the worktree `dir` out of `repo`'s worktree list at once and deletes its files in a detached process nobody
 * waits on (`deleteLater`): it is renamed aside, then `git worktree prune` drops the registration whose directory is
 * gone. However the delete ends, no git worktree stays registered; only an unregistered directory beside --out can.
 */
export function detachWorktree(repo, dir, { deleteLater = deleteDetached } = {}) {
  const aside = `${dir}.removing-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, aside);
  } catch {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", dir], { stdio: "ignore" });
    return;
  }
  spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  deleteLater(aside);
}

/** Deletes `dir` in a detached background process this one does not wait on. */
function deleteDetached(dir) {
  spawn(process.execPath, ["-e", "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", dir], { detached: true, stdio: "ignore" }).unref();
}

function gateError(reason) {
  return { exitCode: GateExit.Error, line: `FROZEN ERROR ${reason.replace(WHITESPACE_RUN, " ").trim()}` };
}

async function main(argv, onVerdict) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, base: { type: "string" }, "base-dir": { type: "string" }, out: { type: "string" },
    "change-log": { type: "string" }, viewport: { type: "string" }, "timeout-ms": { type: "string" }, now: { type: "string" },
    workers: { type: "string" }, "cache-dir": { type: "string" }, "no-cache": { type: "boolean" },
  } });
  if (!values.repo || !values.base) throw new Error(USAGE);
  const repo = path.resolve(values.repo);
  const gitDir = execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  return frozenGate({ repo, base: values.base, baseDir: values["base-dir"] && path.resolve(values["base-dir"]), onVerdict,
    out: path.resolve(values.out ?? frozenOutDir(gitDir)),
    changeLog: path.resolve(values["change-log"] ?? path.join(gitDir, "vibe-changes.md")), ...renderOptions(values) });
}

if (isEntryPoint(import.meta.url)) {
  let printed = false;
  const print = (result) => {
    if (printed) return;
    printed = true;
    process.stdout.write(`${result.line}\n`);
    process.exitCode = result.exitCode;
  };
  try {
    print(await main(process.argv.slice(2), print));
  } catch (error) {
    print(gateError(error instanceof Error ? error.message : String(error)));
  }
}

/** A new private results directory in the session's git directory; session scripts keep no state in the system temp folder. */
function frozenOutDir(gitDir) {
  const parent = path.join(gitDir, "vibe-frozen-render");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, "run-"));
}
