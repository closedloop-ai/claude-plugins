import { execFileSync } from "node:child_process";
import { workflowLaneDefinitions } from "../../handoff/scripts/ci-job-shape.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { fleetCriticFindings } = await vibeCore("lib/vibe/scripts/visual-critic-evidence.mjs");
const { sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { evidenceFingerprint } = await vibeCore("lib/handoff/scripts/handoff-evidence.mjs");
const { changedPaths, declaresUiPaths, VISUAL_QA_STEP, readVisualQaFindings, visualQaRequired } = await vibeCore("lib/vibe/scripts/required-visual-qa.mjs");

export function ghOid(row, field) {
  try {
    return execFileSync(process.env.BOARD_GH || "gh", ["pr", "view", String(row.pr), "-R", row.repo, "--json", field, "-q", `.${field}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim() || null;
  } catch {
    return null;
  }
}

export function ghHead(row) { return ghOid(row, 'headRefOid'); }

/** Read Git from an exact recorded worktree; callers never rely on the coordinator cwd. */
export function repositoryGit(worktree, args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

/** Check a publisher release against full commands from the head's declared workflow and exact-head run rows. */
export function releaseSuiteProblem(git, base, head, report) {
  const manifests = git("diff", "--name-only", "--diff-filter=AM", base, head, "--",
    ":(glob)**/.claude-plugin/plugin.json", ".claude-plugin/plugin.json").split("\n").filter(Boolean);
  const release = manifests.some(file => {
    const after = JSON.parse(git("show", `${head}:${file}`)).version;
    let before;
    try { before = JSON.parse(git("show", `${base}:${file}`)).version; } catch { /* New plugin manifest. */ }
    return typeof after === "string" && after !== before;
  });
  if (!release) return null;
  const inventory = report?.targetedInventory;
  if (inventory?.commit !== head || !Array.isArray(report.testRuns)) return "plugin version bump needs the exact-head release-contract suite report";
  const policy = JSON.parse(git("show", `${head}:vibe-handoff-paths.json`));
  const source = policy.laneSource;
  if (source?.kind !== "github-workflow" || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(source.path)) return "release workflow declaration missing";
  const expected = workflowLaneDefinitions(git("show", `${head}:${source.path}`));
  const missing = expected.filter(({ name, command }) => !inventory.laneReport?.matches?.some(lane => lane.name === name && lane.command === command)
    || !report.testRuns.some(run => run.lane === name && run.command === command && run.status === "passed" && run.commit === head));
  return missing.length ? `missing full release-contract suite evidence: ${missing.map(lane => lane.name).join(", ")}` : null;
}

/** Use the live PR target, an orchestrator-pinned base, or the repository default before PR creation. */
export function trustedBaseOid(row, git, published) {
  if (row.pr && row.repo) {
    const oid = ghOid(row, 'baseRefOid');
    if (!/^[a-f0-9]{40}$/i.test(oid ?? '')) throw new Error('Cannot establish the live PR base');
    return git('rev-parse', '--verify', '--end-of-options', `${oid}^{commit}`);
  }
  if (row.trustedBase) {
    if (!/^[a-f0-9]{40}$/i.test(row.trustedBase.oid ?? '')) throw new Error('Recorded trusted base is invalid');
    return git('rev-parse', '--verify', '--end-of-options', `${row.trustedBase.oid}^{commit}`);
  }
  let ref;
  try { ref = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'); }
  catch {
    try { return git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'); }
    catch { return published; }
  }
  return git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
}

/** Unresolved review threads a human opened, or null when gh cannot answer. */
/**
 * The visual QA verdict for a writer's ready head ({ head, required, reason, findings }), or a thrown refusal
 * naming the visual QA step. The diff is the ready head against the row's trusted base in its local worktree. A
 * remote or worktree-less row has no repository binding to read UI paths from, so an undeclared set counts as UI.
 */
export function readyVisualQa(row, ready, findings, helpers = {}) {
  const local = row.worktree && row.where !== "remote";
  const binding = sessionBinding(local ? row.worktree : null);
  if (local && !declaresUiPaths(binding)) return { head: ready, ...visualQaRequired(binding, []), findings: null };
  let verdict;
  let git = null;
  if (local) {
    git = (...args) => repositoryGit(row.worktree, args);
    try {
      let published;
      try { published = git("rev-parse", "@{upstream}"); } catch { published = null; }
      verdict = visualQaRequired(binding, changedPaths(git, trustedBaseOid(row, git, published), ready));
    } catch { verdict = null; }
  }
  verdict ??= { required: true, reason: "no local tree to diff, so the ready head is treated as user-visible", paths: [] };
  if (!verdict.required) return { head: ready, required: false, reason: verdict.reason, findings: null };
  const coverage = local ? { paths: verdict.paths.length ? verdict.paths : null } : { paths: [], remoteHeadOnly: true };
  const expected = local ? undefined : fleetCriticFindings(helpers, row.worktree, ready);
  const { problems, fingerprint } = readVisualQaFindings(findings, ready, git, binding, coverage, local ? row.worktree : null, expected);
  if (problems.length) throw new Error(`visual QA is required before this head is called ready (${verdict.reason}): ${problems.join("; ")}`);
  return { head: ready, required: true, reason: verdict.reason, findings: fingerprint };
}

/** Why a writer's declared ready head lacks current visual QA, or null. */
export function readyVisualQaProblem(row) {
  if (!row?.ready || row.retiredAt) return null;
  const verdict = row.visualQa;
  if (!verdict?.head || !(verdict.head.startsWith(row.ready) || row.ready.startsWith(verdict.head))) {
    return `no visual QA verdict for ready head ${row.ready}; declare it again with writer --ready <sha> [--visual-qa <findings.json>]`;
  }
  if (!verdict.required) return null;
  try {
    if (JSON.stringify(evidenceFingerprint(verdict.findings.path)) !== JSON.stringify(verdict.findings)) return `visual QA findings ${verdict.findings.path} changed since the ready declaration`;
  } catch { return `visual QA findings for ready head ${row.ready} cannot be read: ${VISUAL_QA_STEP}`; }
  return null;
}
