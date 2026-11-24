import { capturedJson } from "../../../lib/vibe/scripts/captured-json.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptStartupRecord, blockingProblem, conversationId, readStartupRecord } from "./plugin-version.mjs";
import { assertPrototypeSource, isOwnedPrototypeSession, LEGACY_PROTOTYPE_BRANCH_PREFIX, SESSION_BRANCH_PREFIX } from "./prototype-session.mjs";
import { captureSessionProcessIdentities, stopSessionProcesses } from "./session-processes.mjs";
import { adoptStartupQuestions } from "./session-questions.mjs";
import { listedFlagKeys } from "./flag-keys.mjs";
import { validateOperator, validEnvironmentOrgId, vercelAliases } from "./vibe-session-data.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { git, readSessionRecord, sessionLiveTicket, writeSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { ProviderState, providerDataOr, sessionBinding, UNPROBED_REFUSAL } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { githubRepository } = await vibeCore("lib/vibe/scripts/github-remote.mjs");
const { registerWorktreeRetirement, sweepOwnedCleanups } = await vibeCore("lib/vibe/scripts/owned-cleanup.mjs");

const BRANCH_PREFIX = SESSION_BRANCH_PREFIX;
const WORKTREE_DIR = ".claude/worktrees";
const WORKTREE_NAME_PREFIX = "vibe-";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A bug reference with no tracker bound: a URL, `#123`, or another token without spaces.
const GENERIC_REFERENCE = /^[A-Za-z0-9#][A-Za-z0-9#._:/?=&%+-]{0,299}$/;
// Vercel's per-branch preview aliases are `<project>-git-vibe-<slug>`, and a
// DNS label longer than 63 characters gets truncated and hashed, which would
// make the session's URLs unpredictable.
const MAX_SLUG_LENGTH = 40;
// Written by vibe-preflight.sh; holds {"repo": "<the checkout it used last>"}.
const CONFIG_FILE = path.join(os.homedir(), ".codex", "vibe", "config.json");
// The plan document's status follows the work (operator ruling, 2026-10-19): DRAFT while
// its plan is not built yet, APPROVED once the session wrote and checked the
// code (at the latest when handoff opens the pull request), EXECUTED once the
// pull request merged.
const PlanStatus = {
  Draft: "DRAFT",
  Approved: "APPROVED",
  Executed: "EXECUTED",
};
const SessionStatus = {
  Active: "active",
  HandedOff: "handed-off",
};

// Whether a publication merges fresh main: `deferred` (the default) waits for
// QA, conflicts included; `final` merges it, set once QA has passed or when the
// person asks for a main merge now (dist/main-sync.mjs, mainMergeDecision).
const MainMerge = {
  Deferred: "deferred",
  Final: "final",
};

// A hosted environment's starting data, with the provider's recipes: seeded
// with the example company, or blank. A session with no hosted environment has
// no mode.
const SessionMode = {
  Seeded: "seeded",
  Blank: "blank",
};

/**
 * Mirrors the environment org under its old name so earlier installed clients
 * can read a record written here or after another harness rolls back.
 */
export const writeVibeSessionRecord = (worktree, record) => writeSessionRecord(worktree,
  record.environmentOrgId ? { ...record, clerkOrgId: record.environmentOrgId } : record);

/**
 * Binds worktree lifecycle commands to one parsed session CLI invocation.
 * The CLI keeps output formatting and artifact commands. These operations own
 * repository discovery, private record updates and exact worktree ownership.
 */
export function createSessionWorktreeCommands(values, requireOption) {
  return {
    resolveRepo: () => resolveRepo(values),
    listSessions,
    newSession: (options) => newSession(values, requireOption, options),
    touchSession: () => touchSession(values, requireOption),
    stopSession: () => stopSession(requireOption),
    discardSession: () => discardSession(values, requireOption),
    sweepOwnedCleanups,
  };
}

function readRecord(worktree) {
  const record = readSessionRecord(worktree);
  return record ? withDefaults(record, worktree) : null;
}

/** Reads the private session record with legacy fields normalized and requires it to exist. */
export function requireRecord(worktree) {
  const record = readRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  return record;
}

/** The hosted environment's record fields for a new session, or null with no environment recipe. */
function vercelDefaults(branch, environment) {
  if (!environment) return null;
  return {
    ...vercelAliases(branch, environment),
    lastDeployedCommit: null,
    lastDeployedAt: null,
    deploymentIds: null,
    verifiedAt: null,
  };
}

/**
 * Fills fields added after a record was written, reads an older record's
 * `handoffTicket` as `liveTicket` and its `clerkOrgId` as `environmentOrgId`,
 * and drops the retired draft/full `scope` (every session is built frontend
 * and backend).
 */
function withDefaults(record, worktree) {
  const { handoffTicket, clerkOrgId: legacyOrgId, scope: _retiredScope, ...rest } = record;
  return {
    ...rest,
    mode: rest.mode ?? null,
    operator: rest.operator ?? null,
    liveTicket: sessionLiveTicket(record),
    liveTicketCreatedBySession: rest.liveTicketCreatedBySession === undefined
      ? sessionLiveTicket(record) !== null : rest.liveTicketCreatedBySession,
    livePlan: rest.livePlan ?? null,
    livePlanStatus: rest.livePlanStatus ?? null,
    vercel: vercelWithDefaults(rest, worktree),
    flagSnapshot: rest.flagSnapshot ?? null,
    flagKeys: rest.flagKeys ?? null,
    environmentOrgId: rest.environmentOrgId ?? legacyOrgId ?? null,
    desktopAuthSavedAt: rest.desktopAuthSavedAt ?? null,
    codexSessions: rest.codexSessions ?? { orchestrators: [], subagents: [] },
    claudeSessions: rest.claudeSessions ?? { orchestrators: [] },
    localFixes: rest.localFixes ?? [],
  };
}

function vercelWithDefaults(record, worktree) {
  if (isOwnedPrototypeSession(record)) {
    return null;
  }
  if (record.vercel) {
    return { deploymentIds: null, verifiedAt: null, ...record.vercel };
  }
  return record.branch ? vercelDefaults(record.branch, environmentRecipe(worktree)) : null;
}

function parseWorktreeList(repo) {
  const porcelain = git(repo, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

function changeSummary(worktree) {
  const status = git(worktree, ["status", "--porcelain"]);
  const changedFiles = status ? status.split("\n").length : 0;
  const upstreamAhead = git(worktree, [
    "rev-list",
    "--count",
    `origin/${baseBranch(worktree)}..HEAD`,
  ]);
  return { changedFiles, commitsAheadOfMain: Number(upstreamAhead) };
}

function listSessions(repo) {
  return parseWorktreeList(repo)
    .filter((entry) => entry.branch?.startsWith(BRANCH_PREFIX) ||
      (entry.branch?.startsWith(LEGACY_PROTOTYPE_BRANCH_PREFIX) && existsSync(entry.worktree) &&
        isOwnedPrototypeSession(readRecord(entry.worktree), entry.branch)))
    .map((entry) => {
      const record = readRecord(entry.worktree);
      return {
        slug: record?.slug ?? entry.branch.slice(BRANCH_PREFIX.length),
        branch: entry.branch,
        worktree: entry.worktree,
        summary: record?.summary ?? null,
        ticket: record?.ticket ?? null,
        status: record?.status ?? SessionStatus.Active,
        mode: record?.mode ?? null,
        operator: record?.operator ?? null,
        liveTicket: record?.liveTicket ?? null,
        liveTicketCreatedBySession: record?.liveTicketCreatedBySession ?? false,
        livePlan: record?.livePlan ?? null,
        livePlanStatus: record?.livePlanStatus ?? null,
        createdAt: record?.createdAt ?? null,
        lastActiveAt: record?.lastActiveAt ?? null,
        vercel: isOwnedPrototypeSession(record) ? null : record?.vercel ?? vercelDefaults(entry.branch, environmentRecipe(entry.worktree)),
        ...(isOwnedPrototypeSession(record) && record.prototype ? { prototype: record.prototype } : {}),
        flagSnapshotTakenAt: record?.flagSnapshot?.takenAt ?? null,
        flagKeys: listedFlagKeys(record?.flagKeys ?? null),
        stack: record?.stack ?? null,
        localFixes: record?.localFixes ?? [],
        ...changeSummary(entry.worktree),
      };
    })
    .sort((a, b) => compareLastActive(a, b));
}

function compareLastActive(a, b) {
  const aTime = Date.parse(a.lastActiveAt ?? "") || 0;
  const bTime = Date.parse(b.lastActiveAt ?? "") || 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return a.slug.localeCompare(b.slug);
}

function newSession(values, requireOption, { prototype = false } = {}) {
  const slug = requireOption("slug");
  const summary = requireOption("summary");
  if (prototype && (values.mode || !/^[a-z]/.test(slug))) {
    throw new Error("A prototype slug must start with a letter and has no seeded or blank mode.");
  }
  const startup = readStartupRecord(conversationId());
  const versionProblem = blockingProblem(startup);
  if (versionProblem) {
    throw new Error(`${versionProblem}; ask the person and record the answer with plugin-version.mjs choose before starting a session.`);
  }
  if (startup?.provider?.state === ProviderState.Unprobed) throw new Error(UNPROBED_REFUSAL);
  // Before the record exists the binding is this conversation's.
  const environment = prototype ? null : environmentRecipe(null);
  const mode = sessionMode(environment, values, requireOption);
  const givenOperator = operatorFromArgs(values, { required: false });
  if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Slug must be lowercase words joined by hyphens, at most ${MAX_SLUG_LENGTH} characters.`
    );
  }
  const branch = `${BRANCH_PREFIX}${slug}`;
  const worktreeName = `${WORKTREE_NAME_PREFIX}${slug}`;
  const repo = newSessionRepo(values, worktreeName);
  const operator = givenOperator ?? operatorFromArgs(values, { required: true, cwd: repo });
  const worktree = path.join(git(repo, ["rev-parse", "--show-toplevel"]), WORKTREE_DIR, worktreeName);
  if (existsSync(worktree)) {
    throw new Error(`A session already exists at ${worktree}. Resume it or pick another slug.`);
  }
  const branchExists =
    git(repo, ["branch", "--list", branch]) !== "" ||
    git(repo, ["ls-remote", "--heads", "origin", branch]) !== "";
  if (branchExists) {
    throw new Error(`Branch ${branch} already exists. Pick another slug.`);
  }
  const base = baseBranch(repo);
  git(repo, ["fetch", "origin", base]);
  if (prototype) assertPrototypeSource(repo, `origin/${base}`, slug);
  excludeWorktrees(repo, worktree);
  git(repo, ["worktree", "add", "--no-track", "-b", branch, worktree, `origin/${base}`]);
  const now = new Date().toISOString();
  const record = {
    slug,
    branch,
    ...(prototype ? { kind: "prototype" } : {}),
    summary,
    ticket: values.ticket ?? null,
    status: SessionStatus.Active,
    mode,
    operator,
    liveTicket: trackerPattern(null, "tickets", "issuePattern")?.test(values.ticket ?? "") ? values.ticket : null,
    liveTicketCreatedBySession: false,
    livePlan: null,
    livePlanStatus: null,
    baseCommit: git(worktree, ["rev-parse", "HEAD"]),
    createdAt: now,
    lastActiveAt: now,
    vercel: prototype ? null : vercelDefaults(branch, environment),
    flagSnapshot: null,
    environmentOrgId: null,
    desktopAuthSavedAt: null,
    codexSessions: { orchestrators: [], subagents: [] },
    claudeSessions: { orchestrators: [] },
    stack: null,
    localFixes: [],
  };
  writeVibeSessionRecord(worktree, record);
  adoptStartupRecord(worktree);
  const questions = adoptStartupQuestions(worktree);
  return { worktree, ...record, ...(questions.length ? { questions } : {}) };
}

function touchSession(values, requireOption) {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  const orgId = values["environment-org"] ?? values["clerk-org-id"];
  if (isOwnedPrototypeSession(record) && (values.mode || orgId)) {
    throw new Error("Prototype sessions do not have app data modes or environment organizations.");
  }
  if (values.status && !Object.values(SessionStatus).includes(values.status)) {
    throw new Error(`--status must be one of: ${Object.values(SessionStatus).join(", ")}.`);
  }
  const liveTicket = values["live-ticket"] ?? values["handoff-ticket"];
  if (liveTicket !== undefined) requireTrackerSlug(worktree, liveTicket, "live-ticket", "tickets", "slugPattern");
  if (values["created-live-ticket"] &&
    !(liveTicket && (record.liveTicket === null ||
      (record.liveTicketCreatedBySession === true && record.liveTicket === liveTicket)))) {
    throw new Error("--created-live-ticket requires the newly created --live-ticket, not a bound existing ticket.");
  }
  if (values["body-stale"] !== undefined && (!values["body-stale"].trim() || values["body-refreshed"])) {
    throw new Error("--body-stale needs the ruling that changed scope, and goes without --body-refreshed.");
  }
  const members = values["member-ticket"] ?? [];
  for (const slug of members) requireTrackerSlug(worktree, slug, "member-ticket", "tickets", "slugPattern");
  const livePlan = values["live-plan"];
  if (livePlan !== undefined) requireTrackerSlug(worktree, livePlan, "live-plan", "plans", "planPattern");
  const livePlanStatus = values["live-plan-status"];
  if (livePlanStatus !== undefined && !Object.values(PlanStatus).includes(livePlanStatus)) {
    throw new Error(`--live-plan-status must be one of: ${Object.values(PlanStatus).join(", ")}.`);
  }
  if (livePlanStatus !== undefined && !(livePlan ?? record.livePlan)) {
    throw new Error("--live-plan-status needs a recorded --live-plan.");
  }
  const mainMerge = values["main-merge"];
  if (mainMerge !== undefined && !Object.values(MainMerge).includes(mainMerge)) {
    throw new Error(`--main-merge must be one of: ${Object.values(MainMerge).join(", ")}.`);
  }
  const prFields = [values["pr-repo"], values["pr-number"], values["pr-head"]];
  let pullRequest = record.pullRequest ?? null;
  let retirement = null;
  if (prFields.some((part) => part !== undefined)) {
    if (prFields.some((part) => !part) || values.status !== SessionStatus.HandedOff) {
      throw new Error("PR identity requires --status handed-off and --pr-repo, --pr-number, --pr-head together.");
    }
    const number = Number(values["pr-number"]);
    if (!Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/i.test(values["pr-head"])) {
      throw new Error("PR number and head must be exact.");
    }
    const raw = execFileSync("gh", ["api", `repos/${values["pr-repo"]}/pulls/${number}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    const live = capturedJson(raw);
    const branch = git(worktree, ["branch", "--show-current"]);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    if (live.number !== number || live.base?.repo?.full_name !== values["pr-repo"]
      || live.head?.ref !== branch || live.head?.sha !== head || head !== values["pr-head"]) {
      throw new Error("The returned PR does not match the session's published branch and head.");
    }
    const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    retirement = { worktree, repo: path.dirname(commonDir),
      pr: { repo: values["pr-repo"], number, head, branch, state: live.merged_at ? 'MERGED' : String(live.state).toUpperCase() },
      proof: { kind: 'vibe' }, ticket: record.liveTicket ?? record.ticket };
    pullRequest = { repo: values["pr-repo"], number, head };
  }
  const now = new Date().toISOString();
  const updated = {
    ...record,
    summary: values.summary ?? record.summary,
    ticket: values.ticket ?? record.ticket,
    status: values.status ?? record.status,
    mode: values.mode ? requireMode(values.mode) : record.mode,
    operator: operatorFromArgs(values, { required: false, cwd: worktree }) ?? record.operator,
    liveTicket: liveTicket ?? record.liveTicket,
    liveTicketCreatedBySession: values["created-live-ticket"] || record.liveTicketCreatedBySession,
    ...(members.length || record.memberTickets ? { memberTickets: [...new Set([...(record.memberTickets ?? []), ...members])] } : {}),
    livePlan: livePlan ?? record.livePlan,
    livePlanStatus: livePlanStatus ?? record.livePlanStatus,
    environmentOrgId: orgId ? requireEnvironmentOrgId(orgId, environmentRecipe(worktree)) : record.environmentOrgId,
    stack: values.stack ? captureSessionProcessIdentities(worktree, JSON.parse(values.stack), { previous: record.stack }) : record.stack,
    pullRequest,
    ...(mainMerge ?? record.mainMerge ? { mainMerge: mainMerge ?? record.mainMerge } : {}),
    lastActiveAt: now,
  };
  // A recorded scope change leaves the open pull request's body stale until env-ctl pr-update saves a refreshed one.
  if (values["body-stale"]) updated.prBodyStale = { reason: values["body-stale"].trim(), at: now };
  if (values["body-refreshed"]) delete updated.prBodyStale;
  writeVibeSessionRecord(worktree, updated);
  let retirementWarning;
  if (retirement) {
    try { registerWorktreeRetirement(retirement); }
    catch (error) { retirementWarning = String(error instanceof Error ? error.message : error); }
  }
  return { worktree, ...updated, ...(retirementWarning ? { retirementWarning } : {}) };
}

/**
 * Stops the session's recorded Storybook and Desktop, each only after proving it is still the process the
 * session started (alive, that kind of command, running in this worktree); a stale or reused pid is left alone.
 */
async function stopSession(requireOption) {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  requireOwnedSession(worktree, record, "Stop");
  return { worktree, processes: await stopRecorded(worktree, record) };
}

async function stopRecorded(worktree, record) {
  const { results, stack } = await stopSessionProcesses(worktree, record.stack);
  if (record.stack && JSON.stringify(stack) !== JSON.stringify(record.stack)) {
    writeVibeSessionRecord(worktree, { ...record, stack: Object.keys(stack).length ? stack : null });
  }
  return results;
}

/**
 * Without `--confirm`, reports what discarding would lose. With it, requests
 * the drop of a pushed session's preview data when its environment recipe
 * names a cleanup workflow (`previewCleanupWorkflow`, run with the branch in
 * the repository the session's `origin` names), then deletes the remote
 * branch, the worktree, and the local branch, in that order, so a failed
 * request or remote delete leaves the session intact. A handed-off session is never
 * discarded. The result carries the live ticket and operator read from the
 * record before it is deleted. Cancellation evidence is returned only for a
 * ticket that this session created. A ticket it only linked stays active.
 */
async function discardSession(values, requireOption) {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  const { branch, targetRoot, operator, prototype } = requireOwnedSession(worktree, record, "Discard");
  if (record?.status === SessionStatus.HandedOff) {
    throw new Error(`${branch} was handed off; it belongs to design and engineering now and is never discarded.`);
  }
  const changed = git(worktree, ["status", "--porcelain"]);
  const wouldLose = {
    worktree,
    branch,
    summary: record?.summary ?? null,
    liveTicket: record?.liveTicket ?? null,
    liveTicketCreatedBySession: record?.liveTicketCreatedBySession ?? false,
    operator,
    uncommittedFiles: changed ? changed.split("\n").map((line) => line.slice(3)) : [],
    pushed: git(worktree, ["ls-remote", "--heads", "origin", branch]) !== "",
  };
  if (!values.confirm) {
    return { discarded: false, wouldLose };
  }
  const executionRoot = realpathSync(process.cwd());
  if (executionRoot === targetRoot || executionRoot.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error("Confirmed discard must run from a retained checkout outside its target.");
  }
  // A discarded worktree's Storybook and Desktop would otherwise keep running with nothing left to stop them.
  const cleanupWorkflow = prototype ? null : environmentRecipe(worktree)?.previewCleanupWorkflow ?? null;
  const stopped = await stopRecorded(worktree, record);
  const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repo = path.dirname(commonDir);
  const cleanupRequested = Boolean(wouldLose.pushed && cleanupWorkflow);
  if (cleanupRequested) {
    execFileSync(
      "gh",
      ["workflow", "run", cleanupWorkflow, "--repo", originRepository(worktree), "--ref", "main", "-f", `branch=${branch}`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  }
  if (wouldLose.pushed) {
    git(repo, ["push", "origin", "--delete", branch]);
  }
  git(repo, ["worktree", "remove", "--force", worktree]);
  git(repo, ["branch", "-D", branch]);
  return {
    discarded: true,
    processes: stopped,
    remoteBranchDeleted: wouldLose.pushed,
    schemaCleanupRequested: cleanupRequested,
    wouldLose,
    ...(wouldLose.liveTicket && wouldLose.liveTicketCreatedBySession ? { cancelEvidence: {
      discarded: true, branch, liveTicket: wouldLose.liveTicket, liveTicketCreatedBySession: true,
      operatorId: operator.id, operatorEmail: operator.email,
    } } : {}),
  };
}

/** Validates the recorded session's exact Git worktree, branch, operator and ticket before a stop or discard. */
function requireOwnedSession(worktree, record, action) {
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const targetRoot = realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]));
  const targetDir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (realpathSync(worktree) !== targetRoot || (record.worktree && realpathSync(record.worktree) !== targetRoot)
    || record.branch !== branch || !existsSync(path.join(targetDir, "commondir"))) {
    throw new Error(`${action} requires the exact owned session worktree and matching private branch record.`);
  }
  const operator = validateOperator({ id: record.operator?.id, email: record.operator?.email,
    ...(record.operator?.name ? { name: record.operator.name } : {}) });
  if (record.liveTicket !== null && !recordedTicketOk(worktree, record.liveTicket)) {
    throw new Error(`${action} requires a valid recorded live ticket or no ticket.`);
  }
  if (typeof record.liveTicketCreatedBySession !== "boolean" ||
    (record.liveTicketCreatedBySession && !record.liveTicket)) {
    throw new Error(`${action} requires valid live-ticket ownership provenance.`);
  }
  const prototype = isOwnedPrototypeSession(record, branch);
  if (!branch.startsWith(BRANCH_PREFIX) && !prototype) {
    throw new Error(`${worktree} is not a vibe session (branch ${branch}).`);
  }
  return { branch, targetRoot, operator, prototype };
}

/**
 * The branch new sessions start from: `main`, unless the checkout sets git
 * config `vibe.baseRef` during the environment rollout. Unset it when the
 * default branch carries that environment.
 */
export function baseBranch(cwd) {
  try {
    return git(cwd, ["config", "--get", "vibe.baseRef"]) || "main";
  } catch {
    return "main";
  }
}

function requireMode(mode) {
  if (!Object.values(SessionMode).includes(mode)) {
    throw new Error(`--mode must be one of: ${Object.values(SessionMode).join(", ")}.`);
  }
  return mode;
}

/**
 * The session repository's checkout, in vibe-preflight.sh's order: `--repo`
 * when given, then the checkout that owns the working directory (a worktree
 * resolves to its main checkout), then the one vibe-preflight.sh remembered.
 */
function resolveRepo(values) {
  if (values.repo) {
    return values.repo;
  }
  const here = cwdCheckout();
  if (here) {
    return here;
  }
  let config = null;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    config = null;
  }
  const repo = typeof config?.repo === "string" ? config.repo : "";
  if (!repo) {
    throw new Error(
      `No checkout is remembered in ${CONFIG_FILE}. Run vibe-preflight.sh first, or pass --repo.`
    );
  }
  if (!existsSync(repo)) {
    throw new Error(
      `The remembered checkout ${repo} no longer exists. Run vibe-preflight.sh to find it again.`
    );
  }
  return repo;
}

/**
 * The checkout a new session starts in. A requested `--worktree` names it: the path must be
 * `<checkout>/.claude/worktrees/<worktreeName>`, and a `--repo` of another repository is refused,
 * so a session for one repository never lands in another repository's remembered checkout.
 * Without `--worktree`, `--repo` or the remembered checkout as before.
 */
function newSessionRepo(values, worktreeName) {
  if (!values.worktree) {
    return resolveRepo(values);
  }
  const requested = path.resolve(values.worktree);
  const owner = path.dirname(path.dirname(path.dirname(requested)));
  const top = checkoutTop(owner);
  if (!top) {
    throw new Error(`--worktree ${values.worktree} is not inside a git checkout's ${WORKTREE_DIR} folder.`);
  }
  if (realpathSync(top) !== realpathSync(owner) || requested !== path.join(owner, WORKTREE_DIR, worktreeName)) {
    throw new Error(`--worktree ${values.worktree} must be ${path.join(owner, WORKTREE_DIR, worktreeName)}, this slug's session path in ${top}.`);
  }
  if (values.repo && gitCommonDir(values.repo) !== gitCommonDir(owner)) {
    throw new Error(`--repo ${values.repo} and --worktree ${values.worktree} are different repositories; pass the checkout that owns the worktree path, or drop --repo.`);
  }
  return owner;
}

function checkoutTop(dir) {
  try {
    return existsSync(dir) ? git(dir, ["rev-parse", "--show-toplevel"]) : null;
  } catch {
    return null;
  }
}

function gitCommonDir(dir) {
  try {
    return realpathSync(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    throw new Error(`${dir} is not a git checkout.`);
  }
}

/**
 * The `--operator-*` options as a validated operator, or undefined when none is given and none is required.
 * With a tracker bound they are required (its user lookup names the person); without one the operator is
 * the GitHub login `gh` reports, with git's user email in `cwd`.
 */
function operatorFromArgs(values, { required, cwd }) {
  const given = ["operator-id", "operator-email", "operator-name"].some((name) => values[name] !== undefined);
  if (!given && !required) {
    return undefined;
  }
  if (!given && trackerPattern(null, "tickets", "slugPattern")) {
    throw new Error("--operator-id and --operator-email are required: the person running the session, from the bound tracker's user lookup.");
  }
  if (!given) {
    return gitHubOperator(cwd);
  }
  return validateOperator({
    id: values["operator-id"],
    email: values["operator-email"],
    name: values["operator-name"],
  });
}

/** The bound provider's hosted environment recipe for the session at `worktree` (or this conversation), or null. */
export function environmentRecipe(worktree) {
  return providerDataOr(sessionBinding(worktree), "recipes", "environment", null);
}

/** The bound provider's `data[capability][key]` slug pattern, or null with no such provider. */
export function trackerPattern(worktree, capability, key) {
  const pattern = providerDataOr(sessionBinding(worktree), capability, key, null);
  return typeof pattern === "string" ? new RegExp(pattern) : null;
}

function requireTrackerSlug(worktree, value, option, capability, key) {
  const pattern = trackerPattern(worktree, capability, key);
  if (!pattern) {
    throw new Error(`--${option} needs a bound provider with ${capability}; this session has none.`);
  }
  if (!pattern.test(value)) {
    throw new Error(`--${option} must be a slug of the form ${pattern.source}.`);
  }
}

/** A recorded ticket reference: the bound tracker's slug form, else any reference without spaces. */
export function recordedTicketOk(worktree, ticket) {
  const pattern = trackerPattern(worktree, "tickets", "slugPattern");
  return typeof ticket === "string" && (pattern ? pattern.test(ticket) : GENERIC_REFERENCE.test(ticket));
}

/**
 * A seeded or blank start for a hosted environment (required with one); none without, where `--mode` is
 * refused because there is no environment for it to seed.
 */
function sessionMode(environment, values, requireOption) {
  if (environment) return requireMode(requireOption("mode"));
  if (values.mode) {
    throw new Error("--mode needs a hosted environment, and no provider recipe names one for this repository.");
  }
  return null;
}

function requireEnvironmentOrgId(id, environment) {
  if (!validEnvironmentOrgId(id, environment)) {
    throw new Error(environment
      ? `--environment-org must be an organization id of the form ${environment.orgIdPattern}.`
      : "--environment-org needs a hosted environment, and this session has none.");
  }
  return id;
}

/** The `<owner>/<repo>` the session's `origin` names on GitHub. */
function originRepository(worktree) {
  // The configured URL, before any `insteadOf` rewrite.
  const url = git(worktree, ["config", "--get", "remote.origin.url"]);
  const repository = githubRepository(url);
  if (!repository) throw new Error(`origin (${url}) is not a GitHub repository.`);
  return repository;
}

/** The person running a session with no tracker: their GitHub login and name from `gh`, with git's user email. */
function gitHubOperator(cwd) {
  let user;
  try {
    user = capturedJson(execFileSync("gh", ["api", "user"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    throw new Error("No operator: pass --operator-id and --operator-email, or sign in with `gh auth login`.");
  }
  let email = "";
  try {
    email = git(cwd, ["config", "--get", "user.email"]);
  } catch {
    email = "";
  }
  if (!email) {
    throw new Error("No operator email: set git's user.email in the repository, or pass --operator-email.");
  }
  return validateOperator({ id: user?.login, email, ...(user?.name ? { name: user.name } : {}) });
}

/** The main checkout that owns the working directory, or null outside a git checkout. */
function cwdCheckout() {
  try {
    if (git(process.cwd(), ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
    return path.dirname(git(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    return null;
  }
}

/**
 * A repository that does not ignore its session worktrees gets a local exclude rule for them, so the checkout's own
 * `git status` and `git add -A` never pick up a session worktree. The rule is local to this clone; nothing is committed.
 */
function excludeWorktrees(repo, worktree) {
  const inside = path.relative(repo, worktree);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return false;
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "-q", "--no-index", inside], { stdio: "ignore" });
    return false;
  } catch {
    // Not ignored yet: add the folder below.
  }
  const exclude = path.join(gitCommonDir(repo), "info", "exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const rule = `/${WORKTREE_DIR}/`;
  if (current.split("\n").includes(rule)) return false;
  writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`);
  return true;
}
