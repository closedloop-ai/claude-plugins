#!/usr/bin/env node
// Resolves a fleet work dir from one fleet home, so every script that writes
// orchestration state writes it in the same place. A new orchestrator chat
// once inherited only part of a program: its resume log and lessons ledger
// lived beside the work dir, its Codex writers' state in a second machine's
// own directory, and nothing said where any of it was.
//
// A fleet home is a directory with a `programs/` subdirectory: reusable state
// (config.env, standing-rulings.md, lessons.md, handover.md and `current`,
// the active program's slug) at its top, and each program's state under
// programs/<slug>/. Given the home, the work dir is the active program's dir;
// given programs/<slug> itself, that dir. Any other directory is a flat work
// dir from before the home layout and is used as is.
//
// In a home, config.env at the top is read first and programs/<slug>/config.env
// second, and the per-program state keys are always derived, never configured:
// LOCAL_STATE_DIR is <program>/sessions and REQUESTS_DIR <program>/requests, and
// with REMOTE_FLEET_HOME (the fleet home on REMOTE_HOST) REMOTE_STATE_DIR and
// REMOTE_REQUESTS_DIR are the same program's dirs there. A home-level
// LOCAL_STATE_DIR once kept serving a finished program's sessions.
//
// Usage: work-dir.mjs sh <dir>   prints the shell lines a script evals: W, FLEET_HOME, FLEET_PROGRAM, the
//                                 config files sourced in order, then the derived keys. Exits 2 for a home
//                                 with no active program.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PER_PROGRAM_KEYS = ["LOCAL_STATE_DIR", "REQUESTS_DIR", "REMOTE_STATE_DIR", "REMOTE_REQUESTS_DIR"];

/** `{ home, program, dir }` for `dir`; home and program are null for a flat work dir. */
export function resolveWorkDir(dir) {
  const abs = path.resolve(dir);
  if (isDir(path.join(abs, "programs"))) {
    const slug = existsSync(path.join(abs, "current")) ? readFileSync(path.join(abs, "current"), "utf8").trim() : "";
    if (!slug || !isDir(path.join(abs, "programs", slug))) {
      throw new Error(`no active program in ${abs}: start one with fleet-home.mjs start <slug>`);
    }
    return { home: abs, program: slug, dir: path.join(abs, "programs", slug) };
  }
  if (path.basename(path.dirname(abs)) === "programs") {
    return { home: path.dirname(path.dirname(abs)), program: path.basename(abs), dir: abs };
  }
  return { home: null, program: null, dir: abs };
}

/** The KEY=value pairs of a config.env file (quotes stripped, no expansion). */
export function parseConfig(text) {
  const values = {};
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    values[match[1]] = match[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** The merged configuration for a resolved work dir, with the per-program keys derived in a home. */
export function readConfig(resolved) {
  const files = configFiles(resolved);
  const config = Object.assign({}, ...files.map((file) => parseConfig(readFileSync(file, "utf8"))));
  return { ...config, ...derivedKeys(resolved, config.REMOTE_FLEET_HOME) };
}

function derivedKeys(resolved, remoteHome) {
  if (!resolved.program) return {};
  const keys = { LOCAL_STATE_DIR: path.join(resolved.dir, "sessions"), REQUESTS_DIR: path.join(resolved.dir, "requests") };
  if (remoteHome) {
    keys.REMOTE_STATE_DIR = `${remoteHome}/programs/${resolved.program}/sessions`;
    keys.REMOTE_REQUESTS_DIR = `${remoteHome}/programs/${resolved.program}/requests`;
  }
  return keys;
}

function configFiles(resolved) {
  return [resolved.home && path.join(resolved.home, "config.env"), path.join(resolved.dir, "config.env")]
    .filter((file) => file && existsSync(file));
}

/** The shell lines that set W, the home and program, source the config files and set the derived keys. */
export function shellLines(resolved) {
  const lines = [`W=${quote(resolved.dir)}`, `FLEET_HOME=${quote(resolved.home ?? "")}`, `FLEET_PROGRAM=${quote(resolved.program ?? "")}`];
  for (const file of configFiles(resolved)) lines.push(`. ${quote(file)}`);
  if (resolved.program) {
    for (const [key, value] of Object.entries(derivedKeys(resolved))) lines.push(`${key}=${quote(value)}`);
    const program = quote(resolved.program);
    lines.push(`if [ -n "\${REMOTE_FLEET_HOME:-}" ]; then REMOTE_STATE_DIR="$REMOTE_FLEET_HOME/programs/"${program}/sessions; REMOTE_REQUESTS_DIR="$REMOTE_FLEET_HOME/programs/"${program}/requests; fi`);
  }
  return `${lines.join("\n")}\n`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isDir(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function main(argv) {
  const [command, dir] = argv;
  if (command !== "sh" || !dir) throw new Error("Usage: work-dir.mjs sh <dir>");
  process.stdout.write(shellLines(resolveWorkDir(dir)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
