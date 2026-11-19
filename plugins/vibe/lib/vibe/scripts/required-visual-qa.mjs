// Whether a change needs a visual QA pass before its pull request opens, a writer calls it ready, or it is
// merged, and whether the findings file offered for it covers the source being published. A user-visible pull
// request was opened and reported ready to merge with no visual QA on any head while the rule requiring it was
// prose only. This is the one copy: vibe's handoff gate (whose witness binds the verdict) and fleet board, and
// vibe's PR-create and merge guards all call it.
// The UI paths are the repository's own, from its provider recipe (`recipes.areas.ui`); a repository that
// declares none needs no visual QA here, and the verdict says so.
//
// A findings file is the fleet's finding-brief.mjs format ({"head": "<full sha>", "findings": [...]}, `[]` when
// QA found nothing). It covers a source when its head is that source (or, given the repository, has its tree)
// and every finding on a touched surface has a disposition.

import { readFileSync } from "node:fs";
import { providerDataOr, sessionBinding } from "./provider.mjs";

export const VISUAL_QA_STEP = "run the repository's visual QA skill on the affected screens at this head, write its findings file "
  + "({\"head\": \"<full sha>\", \"findings\": [...]}) and give every touched-surface finding a disposition "
  + "(finding-brief.mjs --require-disposition)";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The UI path prefixes the repository `binding` names declares (`recipes.areas.ui`), or none. */
function uiPaths(binding) {
  const ui = providerDataOr(binding, "recipes", "areas", null)?.ui;
  return Array.isArray(ui) ? ui : [];
}

/** Whether the repository `binding` names declares any UI paths; without them no diff needs visual QA here. */
export function declaresUiPaths(binding) {
  return uiPaths(binding).length > 0;
}

/** { required, reason, paths } for `diffPaths` in the repository `binding` names: required when a changed file sits under one of its UI paths. */
export function visualQaRequired(binding, diffPaths) {
  const ui = uiPaths(binding);
  if (ui.length === 0) return { required: false, reason: "the repository declares no UI paths (provider recipe recipes.areas.ui)", paths: [] };
  const paths = diffPaths.filter((file) => ui.some((prefix) => file.startsWith(prefix)));
  if (paths.length === 0) return { required: false, reason: "no changed file is under the repository's UI paths", paths };
  return { required: true, reason: `${paths.length} changed file(s) under the repository's UI paths, first ${paths[0]}`, paths };
}

/**
 * Touched-surface findings that have neither a fixing commit nor a follow-up work item of the tracker `binding`
 * names (its ticket key, else a GitHub issue number). A QA pass that found nothing has nothing to dispose of and
 * passes; only a findings value that is not a list is refused.
 */
export function dispositionProblems(findings, binding = sessionBinding(null)) {
  if (!Array.isArray(findings)) return ["findings must be a list, [] when QA found nothing"];
  const workItem = new RegExp(`^(?:${providerDataOr(binding, "tickets", "keyPattern", "#\\d+")})$`);
  return findings.flatMap((finding, index) => {
    const name = finding?.id ?? `finding ${index + 1}`;
    if (typeof finding?.touchedSurface !== "boolean") return [`${name}: touchedSurface must say true or false`];
    if (!finding.touchedSurface) return [];
    const disposition = String(finding?.disposition ?? "").trim();
    const ticket = /^ticket:\s*(\S+)$/i.exec(disposition)?.[1];
    if (/^fixed:\s*[0-9a-f]{7,40}$/i.test(disposition) || (ticket && workItem.test(ticket))) return [];
    return [`${name}: a finding on a touched surface needs disposition "fixed: <sha>" or "ticket: <id>"`];
  });
}

/**
 * Why the findings file does not cover `head`, or an empty list. With `git` (a runner for the repository that
 * holds `head`), the findings head must name a commit whose tree is `head`'s; without one it must be `head`
 * itself, written in full.
 */
export function visualQaFindingsProblems(file, head, git = null, binding = sessionBinding(null)) {
  if (!file) return [`no visual QA findings file (pass --visual-qa <findings.json>): ${VISUAL_QA_STEP}`];
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { return [`visual QA findings ${file} cannot be read: ${error.message}`]; }
  const qaHead = String(parsed?.head ?? "").toLowerCase();
  if (!FULL_SHA.test(qaHead)) return [`visual QA findings ${file} must name the full head it ran on`];
  const current = String(head ?? "").toLowerCase();
  const covers = git ? sameTree(git, qaHead, current) : current.length >= 7 && qaHead.startsWith(current);
  if (!covers) return [`visual QA findings ${file} ran on ${qaHead}, not the current source ${current || "(unknown)"}: ${VISUAL_QA_STEP}`];
  return dispositionProblems(parsed?.findings, binding).map((problem) => `visual QA findings ${file}: ${problem}`);
}

/** Every path changed between `base` and `head` in the repository `git` runs in, without rename pairing. */
export function changedPaths(git, base, head) {
  return git("diff", "--name-only", "--no-renames", "-z", `${base}...${head}`).split("\0").filter(Boolean);
}

function sameTree(git, left, right) {
  try { return git("rev-parse", "--verify", `${left}^{tree}`) === git("rev-parse", "--verify", `${right}^{tree}`); }
  catch { return false; }
}
