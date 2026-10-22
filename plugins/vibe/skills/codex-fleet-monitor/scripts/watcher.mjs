#!/usr/bin/env node
// Is the watcher for a work dir running? A watcher re-arm was lost in an
// interrupted tool batch and nobody noticed for about two hours, so pushes sat
// unhandled. watch.sh writes <workDir>/watcher.json at start, after every
// tick and on exit; this reads it.
//
// Usage: watcher.mjs <workDir> [--now <iso>]
//
// Prints `watcher ok pid=<p> tick=<n>s ago`, or `watcher MISSING(<why>)` and
// exits 1. A watcher is live when watcher.json has no exitedAt, its pid is
// alive and its last tick is within twice its interval plus 120 seconds.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveWorkDir } from "./work-dir.mjs";

const TICK_SLACK_SECONDS = 120;

/** The watcher's state for `workDir`: `{ ok, line }`. */
export function watcherState(workDir, now = Date.now()) {
  let state;
  try {
    state = JSON.parse(readFileSync(path.join(workDir, "watcher.json"), "utf8"));
  } catch {
    return missing("no watcher.json");
  }
  if (state.exitedAt) {
    return missing(`exited ${Math.max(0, Math.floor((now - Date.parse(state.exitedAt)) / 60_000))}m ago`);
  }
  if (!isAlive(state.pid)) {
    return missing(`pid ${state.pid} dead`);
  }
  const age = Math.max(0, Math.floor((now - Date.parse(state.lastTickAt ?? state.startedAt)) / 1000));
  const interval = Number(state.intervalSeconds) || 0;
  if (!Number.isFinite(age) || age > 2 * interval + TICK_SLACK_SECONDS) {
    return missing(`no tick for ${Number.isFinite(age) ? age : "?"}s`);
  }
  return { ok: true, line: `watcher ok pid=${state.pid} tick=${age}s ago` };
}

function missing(why) {
  return { ok: false, line: `watcher MISSING(${why})` };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { now: { type: "string" } } });
  const [workDir] = positionals;
  if (!workDir) {
    process.stderr.write("Usage: watcher.mjs <workDir: a fleet home, program dir or flat work dir> [--now <iso>]\n");
    return 2;
  }
  const { ok, line } = watcherState(resolveWorkDir(workDir).dir, values.now ? Date.parse(values.now) : Date.now());
  process.stdout.write(`${line}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
