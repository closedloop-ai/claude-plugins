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

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { git, readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { installedProviders, providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { scriptExitCode } = await vibeCore("lib/vibe/scripts/provider.mjs");

const ARTIFACT_ROOT = /^\.[a-z0-9][a-z0-9._-]*\/$/;
const RESERVED_ROOTS = new Set([".git/", ".claude/", ".codex/", ".agents/"]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The in-worktree plan folder (`<artifact root>vibe-plans/`) the binding's provider recipe names, or null when
 * the plans live in the private git directory.
 */
export function localPlanPrefix(binding) {
  const root = providerDataOr(binding, "recipes", "artifactRoot", null);
  if (root === null) return null;
  if (typeof root !== "string" || !ARTIFACT_ROOT.test(root) || RESERVED_ROOTS.has(root)) {
    throw new Error(`The provider's artifact root ${JSON.stringify(root)} is not one dot folder at the repository root.`);
  }
  return `${root}vibe-plans/`;
}

/**
 * Every in-worktree plan folder a session could have used in this repository: the bound provider's, and that of any
 * provider installed here whether or not it is bound, so a plan written while bound stays private after it is not.
 */
export function knownLocalPlanPrefixes(binding) {
  const prefixes = new Set();
  const bound = localPlanPrefix(binding);
  if (bound) prefixes.add(bound);
  let installed = [];
  try { installed = installedProviders(); } catch { installed = []; }
  for (const provider of installed) {
    const root = provider.contract?.data?.recipes?.artifactRoot;
    if (typeof root === "string" && ARTIFACT_ROOT.test(root) && !RESERVED_ROOTS.has(root)) prefixes.add(`${root}vibe-plans/`);
  }
  return [...prefixes];
}

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

/** The session's plan folder, plan file (for `requestId`) and decision table, as absolute paths. */
export function localPlanPaths(worktree, { requestId = null, binding = sessionBinding(worktree) } = {}) {
  if (requestId !== null && !REQUEST_ID.test(requestId)) throw new Error(`--request-id ${requestId} is not a request id.`);
  const slug = readSessionRecord(worktree)?.slug ?? path.basename(path.resolve(worktree));
  const prefix = localPlanPrefix(binding);
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  // Without a provider folder they live in the repository's git common dir, which removing the session worktree keeps.
  const root = prefix ? path.join(top, path.dirname(prefix))
    : path.join(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "vibe", slug);
  const plans = prefix ? path.join(top, prefix) : path.join(root, "plans");
  const decisionTables = path.join(root, "decision-tables");
  return {
    root,
    plans,
    ...(requestId ? { plan: path.join(plans, `${requestId}.md`) } : {}),
    decisionTable: path.join(decisionTables, `${slug}.md`),
    inWorktree: Boolean(prefix),
  };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
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
