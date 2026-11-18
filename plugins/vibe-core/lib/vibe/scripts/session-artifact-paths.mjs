import path from "node:path";
import { knownProviderContracts, providerDataOr, sessionBinding } from "./provider.mjs";
import { git, readSessionRecord } from "./session-record.mjs";

const ARTIFACT_ROOT = /^\.[a-z0-9][a-z0-9._-]*\/$/;
const RESERVED_ROOTS = new Set([".git/", ".claude/", ".codex/", ".agents/"]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function validArtifactRoot(root) {
  return typeof root === "string" && ARTIFACT_ROOT.test(root) && !RESERVED_ROOTS.has(root);
}

/** Resolve the provider's in-worktree plan folder, or null for Git-private plans. */
export function localPlanPrefix(binding) {
  const root = providerDataOr(binding, "recipes", "artifactRoot", null);
  if (root === null) return null;
  if (!validArtifactRoot(root)) {
    throw new Error(`The provider's artifact root ${JSON.stringify(root)} is not one dot folder at the repository root.`);
  }
  return `${root}vibe-plans/`;
}

/** Old provider plan folders remain private even when the session no longer binds their provider. */
export function knownLocalPlanPrefixes(binding) {
  const prefixes = new Set();
  const bound = localPlanPrefix(binding);
  if (bound) prefixes.add(bound);
  let known = [];
  try { known = knownProviderContracts(); } catch { known = []; }
  for (const provider of known) {
    const root = provider.contract?.data?.recipes?.artifactRoot;
    if (validArtifactRoot(root)) prefixes.add(`${root}vibe-plans/`);
  }
  return [...prefixes];
}

/** The exact session's plan folder, optional request plan, and decision table. */
export function localPlanPaths(worktree, { requestId = null, binding = sessionBinding(worktree) } = {}) {
  if (requestId !== null && !REQUEST_ID.test(requestId)) throw new Error(`--request-id ${requestId} is not a request id.`);
  const slug = readSessionRecord(worktree)?.slug ?? path.basename(path.resolve(worktree));
  const prefix = localPlanPrefix(binding);
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  const root = prefix ? path.join(top, path.dirname(prefix))
    : path.join(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "vibe", slug);
  const plans = prefix ? path.join(top, prefix) : path.join(root, "plans");
  return {
    root,
    plans,
    ...(requestId ? { plan: path.join(plans, `${requestId}.md`) } : {}),
    decisionTable: path.join(root, "decision-tables", `${slug}.md`),
    inWorktree: Boolean(prefix),
  };
}
