#!/usr/bin/env node
// An e2e run that reuses built images tests the commit those images were built
// from, not the worktree's HEAD. On 2026-10-24 a queued rerun reused images
// built from a spec-only baseline worktree, which would have reported baseline
// code as the fix run (ISS-13067, #9241), and a `--no-build` baseline half
// later reused the fix's images. So a build records, per compose project, the
// commit and worktree its images came from, and a run that reuses images
// (`--no-build`) starts only when that record names the same commit and
// worktree it is about to test. Without a record it builds fresh.
//
// Usage: image-head.mjs check  --project <compose project> --worktree <path> --head <sha> -- <command...>
//        image-head.mjs record --project <compose project> --worktree <path> --head <sha> -- <command...>
//        (both take `--records <dir>`, default ~/.codex/vibe/locks/e2e-images)
//
// `check` exits 1 with `STALE-IMAGES ...` when the command reuses images built
// from another commit or worktree, or built by nothing recorded; `record` notes
// the build only when the command built (no `--no-build`). Both exit 0
// otherwise. A record is `<records dir>/<project>.json`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NO_BUILD = /(?:^|[\s"'=])--no-build(?=$|[\s"'])/;
const SHA = /^[0-9a-f]{7,40}$/i;

/** Whether a command line reuses already-built images instead of building them. */
export function reusesImages(command) {
  return NO_BUILD.test(command);
}

/** The machine-wide folder of image build records, beside vibe's e2e stack lock. */
export function defaultRecordsDir(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "locks", "e2e-images");
}

/** The record file for a compose project's built images. */
export function imageRecordFile(project, records = defaultRecordsDir()) {
  return path.join(records, `${project.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** The refusal for a run that would reuse images not built from `head` in `worktree`, or null. */
export function imageProblem({ project, worktree, head, command, records }) {
  if (!reusesImages(command)) return null;
  let built;
  try { built = JSON.parse(readFileSync(imageRecordFile(project, records), "utf8")); }
  catch { built = null; }
  if (!built?.head) return `STALE-IMAGES no recorded build for compose project ${project}: drop --no-build so this run builds from ${head.slice(0, 12)}`;
  if (!built.head.startsWith(head.toLowerCase())) {
    return `STALE-IMAGES ${project}'s images were built from ${built.head.slice(0, 12)}, not ${head.slice(0, 12)}: drop --no-build and build fresh`;
  }
  if (built.worktree !== worktree) return `STALE-IMAGES ${project}'s images were built in ${built.worktree}, not ${worktree}: build fresh after a worktree switch`;
  return null;
}

/** Records that `command` built `project`'s images from `head` in `worktree`; a reusing command records nothing. */
export function recordImages({ project, worktree, head, command, records }) {
  if (reusesImages(command)) return false;
  const file = imageRecordFile(project, records);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ head, worktree, builtAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return true;
}

function parse(argv) {
  const [action, ...rest] = argv;
  const values = {};
  let index = 0;
  while (rest[index]?.startsWith("--") && rest[index] !== "--") {
    values[rest[index].slice(2)] = rest[index + 1];
    index += 2;
  }
  if (rest[index] === "--") index += 1;
  return { action, values, command: rest.slice(index).join(" ") };
}

function main(argv) {
  const { action, values, command } = parse(argv);
  if (!["check", "record"].includes(action) || !values.project || !values.worktree || !SHA.test(values.head ?? "") || !command) {
    process.stderr.write("Usage: image-head.mjs check|record --project <p> --worktree <path> --head <sha> -- <command...>\n");
    return 2;
  }
  const input = { project: values.project, worktree: values.worktree, head: values.head, command, records: values.records };
  if (action === "record") { recordImages(input); return 0; }
  const problem = imageProblem(input);
  if (problem) process.stderr.write(`${problem}\n`);
  return problem ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
