#!/usr/bin/env node
// The watcher's Codex hook approval line for one machine. Codex runs vibe-core's
// hooks only once a person approves them, and asks again after vibe-core's bundle
// changes, so a vibe or vibe-core update in Codex can silently turn vibe's guards off.
// snapshot.sh runs this on every pass for the local machine and the remote host.
// When the installed Codex vibe or vibe-core version differs from the one last
// recorded in <state dir>/hook-approval.json, it asks Codex's hooks/list and records
// the answer, asking again while a hook still needs approval or the answer could not
// be read. On every pass it prints the current line, if any; the line stays the same
// until the answer changes, so the watcher raises one event per change and none on
// later wakes, and the line goes away once the hooks are approved.
//
// Usage: hook-approval.mjs <machine label> <state dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { comparePluginVersions } from "../../../shared/plugin-roots.mjs";
import { findCli, installedPlugins } from "../../vibe/scripts/plugin-cli.mjs";
import { codexHookApproval, FIRST_SPLIT_VIBE, HookApproval, hookApprovalLine } from "../../vibe/scripts/vibe-core-hooks.mjs";

// Nothing here loads vibe-core, so a Codex host where it is missing still gets its line.
const CODEX = "codex";
const STATE_FILE = "hook-approval.json";
const LIST_TIMEOUT_MS = 30_000;
/** Answers asked again on every pass until they settle. */
const RETRIED = new Set([HookApproval.Needed, HookApproval.Unchecked]);
const NOT_SPLIT = "not-split";

/** The installed Codex vibe and vibe-core versions from the Codex CLI `cli`, or null when it cannot list them. */
export function codexVersions(cli) {
  try {
    const plugins = installedPlugins(CODEX, execFileSync(cli, ["plugin", "list", "--json"],
      { encoding: "utf8", timeout: LIST_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }));
    const version = (name) => plugins.find((plugin) => plugin.name === name)?.version ?? null;
    return { vibe: version("vibe"), "vibe-core": version("vibe-core") };
  } catch {
    return null;
  }
}

/**
 * The line to print for `machine` and whether hooks/list was asked this pass. Asks when `versions` differ from
 * the recorded ones (or nothing is recorded), and again on every pass while the recorded answer was "needed"
 * (so the line clears once the person approves) or "unchecked" by a transient failure (so a later answer still
 * raises its alert). An App Server without hooks/list is final for that version: no App Server is started again.
 * Only a vibe whose hooks ship in vibe-core is asked about.
 */
export async function hookApprovalWatch(machine, stateDir, { versions, approval }) {
  const file = path.join(stateDir, STATE_FILE);
  const saved = readJson(file);
  if (!versions) return { line: saved?.line ?? null, checked: false };
  const same = saved && JSON.stringify(saved.versions) === JSON.stringify(versions);
  if (same && (!RETRIED.has(saved.state) || saved.final)) return { line: saved.line ?? null, checked: false };
  let state = NOT_SPLIT;
  let final = false;
  let line = null;
  if (typeof versions.vibe === "string" && comparePluginVersions(versions.vibe, FIRST_SPLIT_VIBE) >= 0) {
    const answer = versions["vibe-core"] ? await approval() : { state: HookApproval.Missing };
    state = answer.state;
    final = answer.final === true;
    const text = hookApprovalLine(answer);
    if (text) line = `HOOK-APPROVAL ${machine} vibe ${versions.vibe} vibe-core ${versions["vibe-core"] ?? "none"}: ${text}`;
  }
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ versions, state, ...(final ? { final } : {}), line, checkedAt: new Date().toISOString() })}\n`);
  renameSync(temporary, file);
  return { line, checked: true };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function main([machine, stateDir]) {
  if (!machine || !stateDir) throw new Error("Usage: hook-approval.mjs <machine label> <state dir>");
  const cli = findCli(CODEX);
  const { line } = await hookApprovalWatch(machine, stateDir, {
    versions: cli ? codexVersions(cli) : null,
    approval: () => codexHookApproval(cli, process.cwd()),
  });
  if (line) process.stdout.write(`${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`hook-approval: ${error.message}\n`); process.exitCode = 2; }
}
