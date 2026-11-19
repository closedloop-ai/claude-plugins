// Where a vibe session keeps its local technical plans and its decision table,
// and the check that none was ever committed. Without a provider recipe they
// live in the repository's git common dir (`<git common dir>/vibe/<slug>/plans/`
// and `.../decision-tables/`), outside the working tree, so no commit, diff or
// push can carry them and removing the session worktree keeps them. A provider recipe for the repository
// (`recipes.artifactRoot`, a dot folder the repository ignores) keeps them in
// that folder of the worktree instead, under `vibe-plans/` and
// `decision-tables/`; every publisher then refuses a commit that holds one.
//
// Usage:
//   local-plans.mjs --worktree <path>                                   the committed-plan check
//   local-plans.mjs paths --worktree <path> [--request-id <id>]         the session's paths, as JSON
// The check prints {"ok","committedLocalPlans"} and exits 1 when a plan is committed. `paths` prints
// {"ok","root","plans","plan","decisionTable","inWorktree"}: `plan` is `<plans>/<request-id>.md` (only with
// --request-id) and `decisionTable` is `<decision tables>/<session slug>.md`.

import { parseArgs } from "node:util";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { sessionBinding, scriptExitCode } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { knownLocalPlanPrefixes, localPlanPaths, localPlanPrefix } = await vibeCore("lib/vibe/scripts/session-artifact-paths.mjs");
export { knownLocalPlanPrefixes, localPlanPaths, localPlanPrefix };

/** The session at `worktree`'s in-worktree plan folder (localPlanPrefix of its binding), or null. */
export function sessionLocalPlanPrefix(worktree) {
  return localPlanPrefix(sessionBinding(worktree));
}

/** Whether `filePath` (repo-relative) is in the in-worktree plan folder `prefix`; never with no such folder. */
export function isLocalPlanPath(filePath, prefix) {
  return Boolean(prefix) && (filePath === prefix.slice(0, -1) || filePath.startsWith(prefix));
}

/** Plans already present in HEAD under `prefix`, which must block any further publication; none without one. */
export function committedLocalPlans(runGit, prefix) {
  if (!prefix) return [];
  return runGit(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", prefix.slice(0, -1)])
    .split("\0").filter((file) => file && isLocalPlanPath(file, prefix));
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true,
      options: { worktree: { type: "string" }, "request-id": { type: "string" } } });
    if (!values.worktree) throw new Error("--worktree is required.");
    if (positionals[0] === "paths") {
      process.stdout.write(`${JSON.stringify({ ok: true, ...localPlanPaths(values.worktree, { requestId: values["request-id"] ?? null }) })}\n`);
    } else {
      const plans = knownLocalPlanPrefixes(sessionBinding(values.worktree))
        .flatMap((prefix) => committedLocalPlans((args) => git(values.worktree, args), prefix));
      process.stdout.write(`${JSON.stringify({ ok: plans.length === 0, committedLocalPlans: plans })}\n`);
      process.exitCode = plans.length ? 1 : 0;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = scriptExitCode(error, 1);
  }
}
