#!/usr/bin/env node
// Manage vibe sessions: one git worktree per piece of work, on a
// `vibe/<slug>` branch, with a session record kept in the worktree's private
// git directory so it is never tracked or committed.
//
// Usage:
//   vibe-sessions.mjs repo
//   vibe-sessions.mjs list            [--repo <checkout>]
//   vibe-sessions.mjs show            --worktree <path>
//   vibe-sessions.mjs new             [--repo <checkout>] [--worktree <checkout>/.claude/worktrees/vibe-<slug>]
//                                     --slug <slug> --summary <text>
//                                     [--mode seeded|blank] [--ticket <tracker slug>]
//                                     [--operator-id <id> --operator-email <email> [--operator-name <name>]]
//   vibe-sessions.mjs new-prototype   same ownership/summary options, without --mode
//   vibe-sessions.mjs prototype-result --worktree <path> --file <canonical result.json>
//   vibe-sessions.mjs touch           --worktree <path> [--summary <text>] [--ticket <slug>]
//                                     [--status active|handed-off] [--live-ticket <slug>]
//                                     [--created-live-ticket] [--member-ticket <slug> ...]
//                                     [--live-plan <plan slug>] [--live-plan-status DRAFT|APPROVED|EXECUTED]
//                                     [--mode seeded|blank] [--stack <json>] [--main-merge deferred|final]
//                                     [--environment-org <id>]
//                                     [--pr-repo <owner/repo> --pr-number <n> --pr-head <sha>]
//                                     [--body-stale <the ruling that changed scope> | --body-refreshed]
//                                     [--operator-id <id> --operator-email <email> [--operator-name <name>]]
//   vibe-sessions.mjs flag-snapshot   --worktree <path> --file <snapshot.json> [--replace]
//   vibe-sessions.mjs desktop-auth    --worktree <path> --file <auth-claim.json>
//   vibe-sessions.mjs desktop-launched --worktree <path> --pid <launch pid> --log <launch log>
//   vibe-sessions.mjs desktop-tab     --worktree <path>
//   vibe-sessions.mjs stop            --worktree <path>
//   vibe-sessions.mjs link            --worktree <path> (--story <story id> [--local] | --page <path>)
//   vibe-sessions.mjs dispatch-inputs --worktree <path> --out <inputs.json>
//                                     [--person-email <email>] [--keep-flag-snapshot true|false]
//                                     (`true` is sent only when the session's previous request
//                                     published a verified result; otherwise `false`)
//   vibe-sessions.mjs codex-sessions  --worktree <path> [--thread <id>]
//   vibe-sessions.mjs claude-sessions --worktree <path> --transcript <Claude Code session .jsonl>
//   vibe-sessions.mjs ticket-sections --worktree <path>
//   vibe-sessions.mjs environment-result --worktree <path> --file <vibe-environment-result.json>
//                                     --request-id <id>
//   vibe-sessions.mjs local-fix       --worktree <path> --ticket <bug reference> --path <file> [--path <file> ...]
//   vibe-sessions.mjs story-replacement --worktree <path> --path <story file> --replacement <component>
//   vibe-sessions.mjs discard         --worktree <path> [--confirm]
//
// `--repo` defaults to the checkout vibe-preflight.sh remembered in
// ~/.codex/vibe/config.json; `repo` prints it. On `new`, `--worktree` names the
// checkout that owns that path instead, and a `--repo` of another repository is
// refused. `local-fix` records files the
// sole implementation writer changed to work around a bug in the repository (its
// reference names the report), so no redeploy or handoff commits them. `story-replacement` records
// an existing story file whose title changed because it became the entry of a
// sibling replacement component (such as a V3); handoff blocks any other
// retitled existing story file (design ruling, 2026-10-15).
//
// `new` also moves the questions session-questions.mjs kept before the
// session existed onto the new record, so none of them is asked again, and
// copies this conversation's plugin version check (plugin-version.mjs) onto it
// as `pluginVersion`. It refuses while that check found an outdated plugin and
// the person has not chosen to update or proceed.
//
// `operator` is the person running the session: the bound provider's user
// (`--operator-*`; `touch` sets it on an older record), else the GitHub login
// `gh` reports with git's user email. A provider's live ticket is assigned to
// them and handoff checks it still is.
// Tracker slugs (`--ticket`, `--live-ticket`, `--member-ticket`, `--live-plan`)
// take the bound provider's slug patterns; with no tracker bound there is no
// live ticket. The live ticket is `liveTicket`; `--handoff-ticket` and a
// record's `handoffTicket` are read as the same field for sessions started
// before it. `liveTicketCreatedBySession` distinguishes a ticket create mode
// made from a pre-existing issue that the session only bound. `memberTickets`
// (`touch --member-ticket`, only ever added to) are the other tickets a
// fleet unit delivers in this session's one PR; handoff audits each
// one's criteria and the scope checks count them as asked for. `livePlan` is the session plan's implementation plan document
// that the ticket worker publishes from the local plans and links from
// the live ticket, and `livePlanStatus` the status it last set on it
// (operator ruling, 2026-10-19). `flag-snapshot` validates and saves the production flag snapshot
// next to the record; `list` also shows the keys flag-keys.mjs
// recorded and the person's approval of each; `codex-sessions` records this Codex thread
// (`--thread`, else CODEX_THREAD_ID) and every subagent thread it spawned;
// `claude-sessions` records a Claude Code orchestrator only from its witnessed
// session transcript;
// `ticket-sections` prints the live ticket's Environment, Production flag
// snapshot, and Sessions sections from the record, with the branch's current
// merge-base as its base commit. `dispatch-inputs` writes
// the inputs for the provider's environment request workflow as a
// JSON file for `gh workflow run <workflow> --ref main --json < <file>`, so no
// JSON is ever quoted on a command line, with a fresh request id that names
// the runs it starts. `touch --environment-org` records the stage org a seeded
// session's person chose when they belong to more than one; every later
// request sends it. `desktop-auth` validates and saves the Desktop profile's
// auth claim (`pnpm --filter desktop vibe:profile auth-claim`) next to the
// record; every later request sends it too, so the environment signs that
// profile in. `desktop-launched` records a running `vibe:profile launch`
// (its pid and log) and the Desktop browser tab's URL it printed on the
// session's stack, or no URL for a worktree whose launcher
// predates the tab (the Desktop window still runs); `stop` stops the recorded
// Storybook and Desktop, each only when it is still the session's own process,
// and `discard --confirm` stops them first; `desktop-tab` reports
// whether that launch is still running and its URL only while it is, so a tab
// is never reopened on a closed Desktop's port. The URL carries the launch's bridge token, so the record is written
// owner-only and the URL never goes on the ticket. `link` prints the link to
// give the person for one story or one real app page (`person-links.mjs`). `environment-result` checks the result the environment workflow
// published for a request (its `vibe-environment-result` artifact) against
// that request and the worktree's HEAD and only then records the verified
// URLs, deployment ids, and deployed commit; nothing else records them, and
// the ticket shows no URL until one is verified.
//
// Every command prints one JSON object on stdout. Errors print
// {"ok":false,"error":...} and exit non-zero.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { readWriterSummary } from "./dist/writer-state.mjs";
import { admitMainSyncRequest, admitMainSyncShare, MainSyncError, mainSyncFailure, pushMainSync,
  readMainSyncInput, readMainSyncProvenance, readMainSyncRemoteInput, prepareMainSyncInputs, recordRemoteMainSync, validateMainSync } from "./dist/main-sync.mjs";
import { migrationOrderProblems } from "./migration-order.mjs";
import { pageLink, storyLink } from "./person-links.mjs";
import { savePrototypePublication } from "./prototype-session.mjs";
import { captureSessionProcessIdentities } from "./session-processes.mjs";
import {
  buildDispatchInputs,
  DispatchInput,
  findCodexSubagents,
  findDesktopBrowserUrl,
  validateDesktopAuth,
  validateEnvironmentResult,
  renderRecordSections,
  validateFlagSnapshot,
} from "./vibe-session-data.mjs";
import { baseBranch, createSessionWorktreeCommands, environmentRecipe, recordedTicketOk, requireRecord, trackerPattern, writeVibeSessionRecord } from "./vibe-session-worktrees.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");

const SNAPSHOT_FILE = "vibe-flag-snapshot.json";
const DESKTOP_AUTH_FILE = "vibe-desktop-auth.json";
const THREAD_PATTERN = /^[A-Za-z0-9-]{8,100}$/;
const CLAUDE_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PID_PATTERN = /^[1-9]\d{0,9}$/;
const STORY_FILE_PATTERN = /\.stories\.tsx?$/;
const MAX_REPLACEMENT_LENGTH = 200;
// What the Desktop app's main process logs once its window is shown.
const DESKTOP_WINDOW_VISIBLE = /Desktop window visible/;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    worktree: { type: "string" },
    slug: { type: "string" },
    summary: { type: "string" },
    ticket: { type: "string" },
    status: { type: "string" },
    mode: { type: "string" },
    "live-ticket": { type: "string" },
    "created-live-ticket": { type: "boolean", default: false },
    "handoff-ticket": { type: "string" },
    "member-ticket": { type: "string", multiple: true },
    "body-stale": { type: "string" },
    "body-refreshed": { type: "boolean", default: false },
    "live-plan": { type: "string" },
    "live-plan-status": { type: "string" },
    "main-merge": { type: "string" },
    "pr-repo": { type: "string" },
    "pr-number": { type: "string" },
    "pr-head": { type: "string" },
    file: { type: "string" },
    thread: { type: "string" },
    transcript: { type: "string" },
    out: { type: "string" },
    "person-email": { type: "string" },
    "environment-org": { type: "string" },
    // The same option under its name before the environment recipe moved to the provider.
    "clerk-org-id": { type: "string" },
    "request-id": { type: "string" },
    "keep-flag-snapshot": { type: "string" },
    replace: { type: "boolean", default: false },
    "operator-id": { type: "string" },
    "operator-email": { type: "string" },
    "operator-name": { type: "string" },
    stack: { type: "string" },
    pid: { type: "string" },
    log: { type: "string" },
    path: { type: "string", multiple: true },
    replacement: { type: "string" },
    story: { type: "string" },
    page: { type: "string" },
    local: { type: "boolean", default: false },
    confirm: { type: "boolean", default: false },
  },
});

const worktreeCommands = createSessionWorktreeCommands(values, requireOption);

try {
  const result = await run(positionals[0]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, ...(error instanceof MainSyncError || ["main-sync-inputs", "main-sync-validate", "main-sync-record-remote", "main-sync-push", "main-sync-share"].includes(positionals[0])
      ? mainSyncFailure(error) : { error: error instanceof Error ? error.message : String(error) }) })}\n`
  );
  process.exit(1);
}

async function run(command) {
  if (["repo", "list", "new", "new-prototype"].includes(command)) {
    try { await worktreeCommands.sweepOwnedCleanups({ deadline: Date.now() + 2_000, maxRecords: 2 }); }
    catch { /* Session entry never fails because an unrelated deferred cleanup did. */ }
  }
  switch (command) {
    case "repo":
      return { repo: worktreeCommands.resolveRepo() };
    case "list":
      return { sessions: worktreeCommands.listSessions(worktreeCommands.resolveRepo()) };
    case "show":
      return { session: showSession() };
    case "new":
      return { session: worktreeCommands.newSession() };
    case "new-prototype":
      return { session: worktreeCommands.newSession({ prototype: true }) };
    case "prototype-result":
      return { session: savePrototypePublication(requireOption("worktree"), requireOption("file")) };
    case "touch":
      return { session: worktreeCommands.touchSession() };
    case "flag-snapshot":
      return { session: saveFlagSnapshot() };
    case "desktop-auth":
      return { session: saveDesktopAuth() };
    case "desktop-launched":
      return { session: recordDesktopLaunch() };
    case "desktop-tab":
      return desktopTab();
    case "link":
      return personLink();
    case "dispatch-inputs":
      return await dispatchInputs();
    case "main-sync-validate":
      return { mainSync: validateMainSync(await readMainSyncInput(requireOption("worktree"))) };
    case "main-sync-inputs":
      return { mainSync: prepareMainSyncInputs(await readMainSyncInput(requireOption("worktree"))) };
    case "main-sync-record-remote":
      return { mainSync: recordRemoteMainSync(await readMainSyncRemoteInput(requireOption("worktree"))) };
    case "main-sync-push":
      refuseLateMigrations(requireOption("worktree"));
      return { mainSync: pushMainSync(await readMainSyncInput(requireOption("worktree"))) };
    case "main-sync-share":
      return { mainSync: admitMainSyncShare(await readMainSyncInput(requireOption("worktree"))) };
    case "codex-sessions":
      return { session: recordCodexSessions() };
    case "claude-sessions":
      return { session: recordClaudeSessions() };
    case "ticket-sections":
      return { markdown: ticketSections() };
    case "environment-result":
      return { session: recordEnvironmentResult() };
    case "local-fix":
      return { session: recordLocalFix() };
    case "story-replacement":
      return { session: recordStoryReplacement() };
    case "stop":
      return worktreeCommands.stopSession();
    case "discard":
      return worktreeCommands.discardSession();
    default:
      throw new Error(
        "Unknown command. Use one of: repo, list, show, new, new-prototype, prototype-result, touch, flag-snapshot, desktop-auth, desktop-launched, desktop-tab, stop, link, dispatch-inputs, main-sync-inputs, main-sync-validate, main-sync-record-remote, main-sync-push, main-sync-share, codex-sessions, claude-sessions, ticket-sections, environment-result, local-fix, story-replacement, discard."
      );
  }
}

function requireOption(name) {
  const value = values[name];
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function showSession() {
  const worktree = requireOption("worktree");
  const implementationWriter = readWriterSummary(worktree);
  return { worktree, ...requireRecord(worktree), ...(implementationWriter ? { implementationWriter } : {}) };
}

/** Records the sole writer's managed local workaround paths under the owning bug ticket. */
function recordLocalFix() {
  const worktree = requireOption("worktree");
  const ticket = requireOption("ticket");
  if (!recordedTicketOk(worktree, ticket)) {
    throw new Error(trackerPattern(worktree, "tickets", "slugPattern")
      ? "--ticket must be a tracker slug of the bound provider's form."
      : "--ticket must name the bug report: its URL, `#<number>` or another reference without spaces.");
  }
  const paths = (values.path ?? []).map(normalizeRepoPath);
  if (paths.length === 0) {
    throw new Error("--path is required at least once.");
  }
  const record = requireRecord(worktree);
  const now = new Date().toISOString();
  const localFixes = [...(record.localFixes ?? [])];
  const existing = localFixes.findIndex((fix) => fix.ticket === ticket);
  if (existing === -1) {
    localFixes.push({ ticket, paths: [...new Set(paths)].sort(), recordedAt: now });
  } else {
    const merged = new Set([...localFixes[existing].paths, ...paths]);
    localFixes[existing] = { ...localFixes[existing], paths: [...merged].sort(), recordedAt: now };
  }
  const updated = { ...record, localFixes, lastActiveAt: now };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

function normalizeRepoPath(raw) {
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (
    !raw ||
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`--path must be relative to the worktree root: ${raw}`);
  }
  return normalized.replace(/\/$/, "");
}

function snapshotPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), SNAPSHOT_FILE);
}

/** Validates the flag snapshot file, saves it beside the record, and records a summary. */
function saveFlagSnapshot() {
  const worktree = requireOption("worktree");
  const file = requireOption("file");
  const record = requireRecord(worktree);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON flag snapshot from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshot = validateFlagSnapshot(parsed);
  // The snapshot is taken once, when the session starts,
  // and replaced only when the person asks (flags mode passes --replace).
  if (record.flagSnapshot && !values.replace) {
    throw new Error(
      `The session already has a flag snapshot (taken ${record.flagSnapshot.takenAt}); it is replaced only when the person asks for fresh flags (--replace).`
    );
  }
  const saved = snapshotPath(worktree);
  writeFileSync(saved, `${JSON.stringify(snapshot, null, 2)}\n`);
  const updated = {
    ...record,
    flagSnapshot: {
      takenAt: snapshot.takenAt,
      distinctId: snapshot.distinctId,
      ...(snapshot.orgId === undefined ? {} : { orgId: snapshot.orgId }),
      flagCount: Object.keys(snapshot.flags).length,
      file: saved,
    },
    lastActiveAt: new Date().toISOString(),
  };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

function readSnapshot(worktree, record) {
  if (!record.flagSnapshot) {
    return null;
  }
  const file = snapshotPath(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/**
 * Records this Codex thread as one of the session's orchestrators, then every
 * subagent thread any of them spawned, from Codex's own session files.
 */
function recordCodexSessions() {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  const thread = values.thread ?? process.env.CODEX_THREAD_ID ?? "";
  if (!THREAD_PATTERN.test(thread)) {
    throw new Error("No Codex thread id: pass --thread, or run inside Codex where CODEX_THREAD_ID is set.");
  }
  const now = new Date().toISOString();
  const orchestrators = [...record.codexSessions.orchestrators];
  if (!orchestrators.some((entry) => entry.id === thread)) {
    orchestrators.push({ id: thread, recordedAt: now });
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const subagents = findCodexSubagents({
    codexHome,
    orchestrators: orchestrators.map((entry) => entry.id),
    since: record.createdAt,
  });
  const updated = {
    ...record,
    codexSessions: { orchestrators, subagents },
    lastActiveAt: now,
  };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

/** Records only a Claude Code orchestrator ID witnessed by its own session transcript. */
function recordClaudeSessions() {
  const worktree = requireOption("worktree");
  const transcript = requireOption("transcript");
  const record = requireRecord(worktree);
  const projectRoot = realpathSync(path.join(os.homedir(), ".claude", "projects"));
  const file = realpathSync(transcript);
  if (!file.startsWith(`${projectRoot}${path.sep}`) || !file.endsWith(".jsonl")) {
    throw new Error("Claude transcript must be a session file under this user's Claude projects directory.");
  }
  const id = path.basename(file, ".jsonl");
  if (!CLAUDE_SESSION_PATTERN.test(id)) throw new Error("Claude transcript filename has no valid session id.");
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let count;
  try { count = readSync(fd, buffer, 0, buffer.length, 0); }
  finally { closeSync(fd); }
  const lines = buffer.toString("utf8", 0, count).split("\n").slice(0, -1);
  if (!lines.some((line) => {
    try { return JSON.parse(line).sessionId === id; }
    catch { return false; }
  })) throw new Error("Claude transcript does not witness the session id in its filename.");
  const now = new Date().toISOString();
  const orchestrators = [...(record.claudeSessions?.orchestrators ?? [])];
  if (!orchestrators.some((entry) => entry.id === id)) orchestrators.push({ id, recordedAt: now });
  const updated = { ...record, claudeSessions: { orchestrators }, lastActiveAt: now };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

function ticketSections() {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  const implementationWriter = readWriterSummary(worktree);
  return renderRecordSections({ ...record, baseCommit: currentBaseCommit(worktree, record),
    ...(implementationWriter ? { implementationWriter } : {}) }, readSnapshot(worktree, record), environmentRecipe(worktree));
}

/** Writes the environment request workflow's inputs for this session to `--out`. */
async function dispatchInputs() {
  const worktree = requireOption("worktree");
  const out = requireOption("out");
  const record = requireRecord(worktree);
  const environment = environmentRecipe(worktree);
  if (!environment?.requestWorkflow) {
    throw new Error("This session has no hosted environment: no provider recipe names a request workflow for the repository.");
  }
  // A snapshot is kept only when this session's previous
  // request published a verified result. A run that failed (perhaps before
  // posting the snapshot into a schema it built) gets it posted again.
  const previousVerified =
    typeof record.lastRequestId === "string" && record.vercel?.verifiedRequestId === record.lastRequestId;
  const asked = values["keep-flag-snapshot"];
  const keepFlagSnapshot = asked === "true" && !previousVerified ? "false" : asked;
  const inputs = buildDispatchInputs({
    record,
    snapshot: readSnapshot(worktree, record),
    personEmail: values["person-email"],
    environmentOrgId: record.environmentOrgId ?? undefined,
    desktopAuth: readDesktopAuth(worktree, record),
    requestId: randomUUID(),
    keepFlagSnapshot,
    environment,
  });
  try {
    const mainSync = admitMainSyncRequest(await readMainSyncInput(worktree));
    if (mainSync.alreadyPublished) return { mainSync: { status: "DONE", ...mainSync } };
  }
  catch (error) {
    const failure = mainSyncFailure(error);
    throw new MainSyncError(failure.error, failure.status);
  }
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(inputs)}\n`);
  writeVibeSessionRecord(worktree, { ...record, lastRequestId: inputs[DispatchInput.RequestId] });
  return {
    workflow: environment.requestWorkflow,
    ref: "main",
    out,
    requestId: inputs[DispatchInput.RequestId],
    runTitle: `Vibe environment ${record.branch} (${inputs[DispatchInput.RequestId]})`,
    inputNames: Object.keys(inputs),
  };
}

function desktopAuthPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), DESKTOP_AUTH_FILE);
}

/** Validates the Desktop profile's auth claim and saves it beside the record. */
function saveDesktopAuth() {
  const worktree = requireOption("worktree");
  const file = requireOption("file");
  const record = requireRecord(worktree);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON auth claim from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeFileSync(desktopAuthPath(worktree), `${JSON.stringify(validateDesktopAuth(parsed))}\n`);
  const now = new Date().toISOString();
  const updated = { ...record, desktopAuthSavedAt: now, lastActiveAt: now };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

function readDesktopAuth(worktree, record) {
  const file = desktopAuthPath(worktree);
  return record.desktopAuthSavedAt && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/**
 * Records the verified result of the environment run for `--request-id`: the
 * URLs, deployment ids, and deployed commit, only when the result answers that
 * request for this session's branch and mode at the worktree's HEAD.
 */
function recordEnvironmentResult() {
  const worktree = requireOption("worktree");
  const file = requireOption("file");
  const requestId = requireOption("request-id");
  const record = requireRecord(worktree);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON environment result from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verified = validateEnvironmentResult(parsed, {
    requestId,
    branch: record.branch,
    mode: record.mode,
    headSha: git(worktree, ["rev-parse", "HEAD"]),
  });
  const now = new Date().toISOString();
  const updated = {
    ...record,
    vercel: {
      ...record.vercel,
      appUrl: verified.appUrl,
      apiUrl: verified.apiUrl,
      storybookUrl: verified.storybookUrl,
      lastDeployedCommit: verified.headSha,
      lastDeployedAt: now,
      deploymentIds: verified.deploymentIds,
      verifiedAt: verified.verifiedAt,
      verifiedRequestId: requestId,
    },
    lastActiveAt: now,
  };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

/**
 * The branch's base as the handoff inventory computes it: its merge-base with
 * the base branch, which moves when the session merges main. The
 * commit the session started from is only the fallback when there is none.
 */
function currentBaseCommit(worktree, record) {
  if (record.status === "active" && record.operator) {
    const provenance = readMainSyncProvenance(worktree);
    if (provenance) return provenance.mainSha;
  }
  try {
    return git(worktree, ["merge-base", "HEAD", `origin/${baseBranch(worktree)}`]);
  } catch {
    return record.baseCommit;
  }
}

/**
 * Records a running `vibe:profile launch` on the session's stack, keeping what
 * else the stack lists: its pid, its log, and the Desktop browser tab's URL
 * from that log. A log that shows the window up but no URL is a worktree whose
 * launcher predates the tab: the launch is
 * recorded with no URL, so Desktop still runs as its own window. A log with
 * neither is refused: Desktop has not started.
 */
function recordDesktopLaunch() {
  const worktree = requireOption("worktree");
  const pidText = requireOption("pid");
  const log = path.resolve(requireOption("log"));
  if (!PID_PATTERN.test(pidText)) {
    throw new Error("--pid must be the launch command's process id.");
  }
  const record = requireRecord(worktree);
  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch (error) {
    throw new Error(`Could not read the Desktop launch log ${log}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const desktopBrowserUrl = findDesktopBrowserUrl(text, environmentRecipe(worktree));
  if (desktopBrowserUrl === null && !DESKTOP_WINDOW_VISIBLE.test(text)) {
    throw new Error(`${log} shows neither a "Desktop browser URL:" line nor "Desktop window visible": Desktop has not started yet.`);
  }
  const now = new Date().toISOString();
  const updated = {
    ...record,
    stack: captureSessionProcessIdentities(worktree, { ...record.stack, desktopPid: Number(pidText), desktopLog: log, desktopBrowserUrl },
      { previous: record.stack }),
    lastActiveAt: now,
  };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

/**
 * Whether the recorded Desktop launch is still running, and the browser tab's
 * URL only while it is. `running: false` means Desktop was never started here,
 * quit, or was stopped, and must be launched again; `running: true` with no
 * URL is a launch that predates the tab, open as its own window only.
 */
function desktopTab() {
  const worktree = requireOption("worktree");
  const { stack } = requireRecord(worktree);
  const running = isRunning(stack?.desktopPid);
  return { worktree, running, url: running ? (stack.desktopBrowserUrl ?? null) : null };
}

/**
 * The link to give the person for one story (`--story <id>`, `--local` for a
 * story built since the last redeploy) or one real app page (`--page <path>`),
 * built from the session record; `url: null` with `missing` when nothing is
 * deployed or running yet (`plain-words.md`, "Links to what the person
 * should look at").
 */
function personLink() {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  if (Boolean(values.story) === Boolean(values.page)) {
    throw new Error("Pass exactly one of --story <story id> or --page <path>.");
  }
  if (values.page && values.local) {
    throw new Error("--local applies to --story only.");
  }
  const link = values.story
    ? storyLink(record, values.story, { local: values.local, isRunning })
    : pageLink(record, values.page);
  return { worktree, ...link };
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Records an existing story file retitled as a sibling replacement's own entry, replacing an earlier entry for it. */
function recordStoryReplacement() {
  const worktree = requireOption("worktree");
  const paths = (values.path ?? []).map(normalizeRepoPath);
  if (paths.length !== 1 || !STORY_FILE_PATTERN.test(paths[0])) {
    throw new Error("--path is required once and must name a story file.");
  }
  const replacement = requireOption("replacement").trim();
  if (!replacement || replacement.length > MAX_REPLACEMENT_LENGTH) {
    throw new Error(`--replacement must name the replacing component in at most ${MAX_REPLACEMENT_LENGTH} characters.`);
  }
  const record = requireRecord(worktree);
  const now = new Date().toISOString();
  const storyReplacements = [
    ...(record.storyReplacements ?? []).filter((entry) => entry.path !== paths[0]),
    { path: paths[0], replacement, recordedAt: now },
  ];
  const updated = { ...record, storyReplacements, lastActiveAt: now };
  writeVibeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

/** Refuses a push while a branch migration sorts before main's newest one (`migration-order.mjs`). */
function refuseLateMigrations(worktree) {
  const { problems } = migrationOrderProblems(worktree);
  if (problems.length > 0) {
    throw new MainSyncError(`Nothing was pushed: ${problems.join("; ")}`, "NEEDS_CHANGE");
  }
}
