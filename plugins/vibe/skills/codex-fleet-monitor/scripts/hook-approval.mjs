#!/usr/bin/env node
// The watcher's Codex hook approval line for one machine. Codex runs vibe-core's
// hooks only once a person approves them, and asks again after vibe-core's bundle
// changes, so a vibe or vibe-core update in Codex can silently turn vibe's guards off.
// snapshot.sh runs this on every pass for the local machine and the remote host.
// When the installed Codex vibe or vibe-core version differs from the one last
// recorded in <state dir>/hook-approval.json, it asks Codex's hooks/list once and
// records the result; on every pass it prints the recorded line, if any, so the
// watcher raises one event per version change and none on later wakes.
//
// Usage: hook-approval.mjs <machine label> <state dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, findCli, Harness, installedPlugins } from "../../vibe/scripts/plugin-version.mjs";
import { codexHookApproval, FIRST_SPLIT_VIBE, HookApproval, hookApprovalLine } from "../../vibe/scripts/vibe-core-hooks.mjs";

const STATE_FILE = "hook-approval.json";
const LIST_TIMEOUT_MS = 30_000;

/** The installed Codex vibe and vibe-core versions from the Codex CLI `cli`, or null when it cannot list them. */
export function codexVersions(cli) {
  try {
    const plugins = installedPlugins(Harness.Codex, execFileSync(cli, ["plugin", "list", "--json"],
      { encoding: "utf8", timeout: LIST_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }));
    const version = (name) => plugins.find((plugin) => plugin.name === name)?.version ?? null;
    return { vibe: version("vibe"), "vibe-core": version("vibe-core") };
  } catch {
    return null;
  }
}

/**
 * The line to print for `machine` and whether hooks/list was asked this pass. Asks only when `versions`
 * differ from the recorded ones (or nothing is recorded), and only for a vibe whose hooks ship in vibe-core.
 */
export async function hookApprovalWatch(machine, stateDir, { versions, approval }) {
  const file = path.join(stateDir, STATE_FILE);
  const saved = readJson(file);
  if (!versions) return { line: saved?.line ?? null, checked: false };
  if (saved && JSON.stringify(saved.versions) === JSON.stringify(versions)) return { line: saved.line ?? null, checked: false };
  let line = null;
  if ((compareVersions(versions.vibe, FIRST_SPLIT_VIBE) ?? -1) >= 0) {
    const text = hookApprovalLine(versions["vibe-core"] ? await approval() : { state: HookApproval.Missing });
    if (text) line = `HOOK-APPROVAL ${machine} vibe ${versions.vibe} vibe-core ${versions["vibe-core"] ?? "none"}: ${text}`;
  }
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ versions, line, checkedAt: new Date().toISOString() })}\n`);
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
  const cli = findCli(Harness.Codex);
  const { line } = await hookApprovalWatch(machine, stateDir, {
    versions: cli ? codexVersions(cli) : null,
    approval: () => codexHookApproval(cli, process.cwd()),
  });
  if (line) process.stdout.write(`${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`hook-approval: ${error.message}\n`); process.exitCode = 2; }
}
