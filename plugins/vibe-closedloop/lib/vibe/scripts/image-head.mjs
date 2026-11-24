#!/usr/bin/env node
// An e2e run that reuses built images tests the commit those images were built
// from, not the worktree's HEAD. On 2026-10-24 a queued rerun reused images
// built from a spec-only baseline worktree, which would have reported baseline
// code as the fix run, and a `--no-build` baseline half
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

import { certifiesComposeImages, changesComposeImages, explicitComposeProject } from "./docker-disk-admission.mjs";
import { withStableSource } from "./tested-head.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { escalation, isSandboxRefusal } from "./sandbox-refusal.mjs";
import os from "node:os";
import path from "node:path";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

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
export function imageProblem({ project, worktree, head, source, command, records }) {
  if (!reusesImages(command)) return null;
  let built;
  try { built = JSON.parse(readFileSync(imageRecordFile(project, records), "utf8")); }
  catch { built = null; }
  if (!built?.head || built.schema !== "vibe.e2e-image-witness/4") return `STALE-IMAGES no recorded build for compose project ${project}: drop --no-build so this run builds from ${head.slice(0, 12)}`;
  if (!built.head.startsWith(head.toLowerCase())) {
    return `STALE-IMAGES ${project}'s images were built from ${built.head.slice(0, 12)}, not ${head.slice(0, 12)}: drop --no-build and build fresh`;
  }
  if ((source || built.source) && source?.treeSha256 !== built.source?.treeSha256) return `STALE-IMAGES ${project} images have different uncommitted inputs: build fresh`;
  if (built.worktree !== worktree) return `STALE-IMAGES ${project}'s images were built in ${built.worktree}, not ${worktree}: build fresh after a worktree switch`;
  return null;
}

/** Retire the previous witness before a build can overwrite its project's image tags. */
export function invalidateImages({ project, command, argv, records }) {
  if (!(argv ? changesComposeImages(argv[0], argv.slice(1)) : changesComposeImages("sh", ["-c",command]))) return;
  try { unlinkSync(imageRecordFile(project, records)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

/** Records that `command` built `project`'s images from `head` in `worktree`; a reusing command records nothing. */
export function recordImages({ project, worktree, cwd = worktree, head, source, command, argv, records }) {
  const [binary,...args] = argv ?? ["sh","-c",command];
  const explicitProject = explicitComposeProject(binary,args,project);
  if ((explicitProject && explicitProject !== project) || !certifiesComposeImages(binary,args,worktree,cwd)) return false;
  const file = imageRecordFile(project, records);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ schema:"vibe.e2e-image-witness/4", head, source, worktree, builtAt: new Date().toISOString() })}\n`, { mode: 0o600 });
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
  return { action, values, argv:rest.slice(index), command: rest.slice(index).join(" ") };
}

function main(argv) {
  const { action, values, command, argv:commandArgs } = parse(argv);
  if (!["check", "record"].includes(action) || !values.project || !values.worktree || !SHA.test(values.head ?? "") || !command) {
    process.stderr.write("Usage: image-head.mjs check|record --project <p> --worktree <path> --head <sha> -- <command...>\n");
    return 2;
  }
  const operation = source => {
    const input = { project: values.project, worktree: values.worktree, head: values.head, source, command, argv:commandArgs, records: values.records };
    if (action === "record") {
      try { recordImages(input); }
      catch (error) {
        if (!isSandboxRefusal(error)) throw error;
        process.stdout.write(`${JSON.stringify(escalation(error, ESCALATION_JUSTIFICATION))}\n`);
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    }
    const problem = imageProblem(input);
    if (problem) process.stderr.write(`${problem}\n`);
    return { exitCode: problem ? 1 : 0 };
  };
  const repository = spawnSync('git', ['-C', values.worktree, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return (repository.status === 0 ? withStableSource(values.worktree, operation, { head: values.head }) : operation(undefined)).exitCode;
}

export const ESCALATION_JUSTIFICATION = "Record which version the automatic checks' setup was built from";

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
