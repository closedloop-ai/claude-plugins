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

import { capturedJson } from "../../../lib/vibe/scripts/captured-json.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { comparePluginVersions, isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { findCli, installedPlugins, OWN_PLUGIN } from "../../vibe/scripts/plugin-cli.mjs";
import { APPROVE_HOOKS, approveHooksStep, codexHookApproval, FIRST_SPLIT_VIBE, HookApproval, hookApprovalLine, UNREAD_PLUGIN_NAME } from "../../vibe/scripts/vibe-core-hooks.mjs";

// Nothing here loads vibe-core, so a Codex host where it is missing still gets its line.
const CODEX = "codex";
const STATE_FILE = "hook-approval.json";
const LIST_TIMEOUT_MS = 30_000;
/** Answers asked again on every pass until they settle. */
const RETRIED = new Set([HookApproval.Needed, HookApproval.Unchecked]);
const NOT_SPLIT = "not-split";

/** The installed Codex vibe and vibe-core versions from the Codex CLI `cli`, or null when it cannot list them. */
export function codexVersions(cli) {
  return codexHookInventory(cli)?.versions ?? null;
}

/** Resolve the hook entry from the target host's enabled installation, including staged watchers. */
export function codexHookInventory(cli) {
  try {
    const listing = capturedJson(execFileSync(cli, ["plugin", "list", "--json"],
      { encoding: "utf8", timeout: LIST_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }));
    const plugins = installedPlugins(CODEX, listing);
    const version = (name) => plugins.find((plugin) => plugin.name === name)?.version ?? null;
    const core = plugins.find((plugin) => plugin.name === "vibe-core");
    const root = listing.installed?.find((entry) => entry.pluginId === core?.id)?.source?.path;
    const manifest = root ? readJson(path.join(root, ".codex-plugin", "plugin.json")) : null;
    const displayName = manifest?.interface?.displayName;
    const named = typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
    return { versions: { vibe: version(OWN_PLUGIN), "vibe-core": version("vibe-core") }, displayName: named ?? core?.id, targetLabel: named };
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
export async function hookApprovalWatch(machine, stateDir, { versions, approval, displayName, targetLabel = null }) {
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
    // When the target host's manifest names its vibe-core entry, the setup step uses that exact label.
    const relabelled = targetLabel ? text.replace(APPROVE_HOOKS, approveHooksStep(targetLabel)) : text;
    const labelled = displayName ? relabelled.replace(UNREAD_PLUGIN_NAME, displayName) : relabelled;
    if (text) line = `HOOK-APPROVAL ${machine} vibe ${versions.vibe} vibe-core ${versions["vibe-core"] ?? "none"}: ${labelled}`;
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
  const inventory = cli ? codexHookInventory(cli) : null;
  const { line } = await hookApprovalWatch(machine, stateDir, {
    versions: inventory?.versions ?? null,
    displayName: inventory?.displayName, targetLabel: inventory?.targetLabel ?? null,
    approval: () => codexHookApproval(cli, process.cwd()),
  });
  if (line) process.stdout.write(`${line}\n`);
}

if (isEntryPoint(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`hook-approval: ${error.message}\n`); process.exitCode = 2; }
}
