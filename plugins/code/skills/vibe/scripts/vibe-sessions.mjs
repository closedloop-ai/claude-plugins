#!/usr/bin/env node
// Manage vibe sessions: one git worktree per piece of work, on an
// `andy/<slug>` branch, with a session record kept in the worktree's private
// git directory so it is never tracked or committed.
//
// Usage:
//   vibe-sessions.mjs repo
//   vibe-sessions.mjs list            [--repo <symphony-alpha checkout>]
//   vibe-sessions.mjs show            --worktree <path>
//   vibe-sessions.mjs new             [--repo <checkout>] --slug <slug> --summary <text>
//                                     --scope draft|full --mode seeded|blank [--ticket ISS-123]
//                                     --operator-id <id> --operator-email <email> [--operator-name <name>]
//   vibe-sessions.mjs touch           --worktree <path> [--summary <text>] [--ticket ISS-123]
//                                     [--status active|handed-off] [--live-ticket ISS-123]
//                                     [--scope draft|full] [--mode seeded|blank]
//                                     [--vercel <json>] [--deployed <commit>] [--stack <json>]
//                                     [--clerk-org-id org_...]
//                                     [--operator-id <id> --operator-email <email> [--operator-name <name>]]
//   vibe-sessions.mjs flag-snapshot   --worktree <path> --file <snapshot.json>
//   vibe-sessions.mjs desktop-auth    --worktree <path> --file <auth-claim.json>
//   vibe-sessions.mjs dispatch-inputs --worktree <path> --out <inputs.json>
//                                     [--person-email <email>]
//   vibe-sessions.mjs codex-sessions  --worktree <path> [--thread <id>]
//   vibe-sessions.mjs ticket-sections --worktree <path>
//   vibe-sessions.mjs local-fix       --worktree <path> --ticket ISS-123 --path <file> [--path <file> ...]
//   vibe-sessions.mjs discard         --worktree <path> [--confirm]
//
// `--repo` defaults to the checkout vibe-preflight.sh remembered in
// ~/.codex/vibe/config.json; `repo` prints it. `local-fix` records files the
// setup worker changed to work around a symphony-alpha bug (filed as the
// ticket), so no redeploy or handoff commits them.
//
// `operator` is the person running the session, from ClosedLoop `get-me`
// (`--operator-*`, required on `new`; `touch` sets it on an older record):
// the live ticket is assigned to them and handoff checks it still is.
// The live ticket (ISS-12057) is `liveTicket`; `--handoff-ticket` and a
// record's `handoffTicket` are read as the same field for sessions started
// before it. `flag-snapshot` validates and saves the production flag snapshot
// (ISS-12048) next to the record; `codex-sessions` records this Codex thread
// (`--thread`, else CODEX_THREAD_ID) and every subagent thread it spawned;
// `ticket-sections` prints the live ticket's Environment, Production flag
// snapshot, and Sessions sections from the record. `dispatch-inputs` writes
// the inputs for the symphony-alpha vibe environment request workflow as a
// JSON file for `gh workflow run <workflow> --ref main --json < <file>`, so no
// JSON is ever quoted on a command line, with a fresh request id that names
// the runs it starts. `touch --clerk-org-id` records the stage org a seeded
// session's person chose when they belong to more than one; every later
// request sends it. `desktop-auth` validates and saves the Desktop profile's
// auth claim (`pnpm --filter desktop vibe:profile auth-claim`) next to the
// record; every later request sends it too, so the environment signs that
// profile in.
//
// Every command prints one JSON object on stdout. Errors print
// {"ok":false,"error":...} and exit non-zero.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildDispatchInputs,
  DISPATCH_WORKFLOW,
  DispatchInput,
  findCodexSubagents,
  validateDesktopAuth,
  renderRecordSections,
  VERCEL_URL_KEYS,
  validateFlagSnapshot,
  validateOperator,
  vercelAliases,
} from "./vibe-session-data.mjs";

const BRANCH_PREFIX = "andy/";
const WORKTREE_DIR = ".claude/worktrees";
const WORKTREE_NAME_PREFIX = "andy-";
const RECORD_FILE = "vibe-session.json";
const SNAPSHOT_FILE = "vibe-flag-snapshot.json";
const DESKTOP_AUTH_FILE = "vibe-desktop-auth.json";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Vercel's per-branch preview aliases are `<project>-git-andy-<slug>`, and a
// DNS label longer than 63 characters gets truncated and hashed, which would
// make the session's URLs unpredictable.
const MAX_SLUG_LENGTH = 40;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Written by vibe-preflight.sh; holds {"repo": "<symphony-alpha checkout>"}.
const CONFIG_FILE = path.join(os.homedir(), ".codex", "vibe", "config.json");
const TICKET_PATTERN = /^[A-Z]+-\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const THREAD_PATTERN = /^[A-Za-z0-9-]{8,100}$/;
const CLERK_ORG_PATTERN = /^org_[A-Za-z0-9]+$/;

const SessionStatus = {
  Active: "active",
  HandedOff: "handed-off",
};

// Draft: frontend only, with stubs, for engineering to finish. Full: frontend
// and backend (ISS-12046). Both end on the branch, handed to design and then
// engineering, who open the pull request (ISS-12057).
const SessionScope = {
  Draft: "draft",
  Full: "full",
};

// Seeded: the session's Vercel environment is filled by the vibe seed under
// Acme Co. Blank: no data; the person creates their own org (ISS-12056).
const SessionMode = {
  Seeded: "seeded",
  Blank: "blank",
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    worktree: { type: "string" },
    slug: { type: "string" },
    summary: { type: "string" },
    ticket: { type: "string" },
    status: { type: "string" },
    scope: { type: "string" },
    mode: { type: "string" },
    "live-ticket": { type: "string" },
    "handoff-ticket": { type: "string" },
    vercel: { type: "string" },
    deployed: { type: "string" },
    file: { type: "string" },
    thread: { type: "string" },
    out: { type: "string" },
    "person-email": { type: "string" },
    "clerk-org-id": { type: "string" },
    "operator-id": { type: "string" },
    "operator-email": { type: "string" },
    "operator-name": { type: "string" },
    stack: { type: "string" },
    path: { type: "string", multiple: true },
    confirm: { type: "boolean", default: false },
  },
});

try {
  const result = run(positionals[0]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exit(1);
}

function run(command) {
  switch (command) {
    case "repo":
      return { repo: resolveRepo() };
    case "list":
      return { sessions: listSessions(resolveRepo()) };
    case "show":
      return { session: showSession() };
    case "new":
      return { session: newSession() };
    case "touch":
      return { session: touchSession() };
    case "flag-snapshot":
      return { session: saveFlagSnapshot() };
    case "desktop-auth":
      return { session: saveDesktopAuth() };
    case "dispatch-inputs":
      return dispatchInputs();
    case "codex-sessions":
      return { session: recordCodexSessions() };
    case "ticket-sections":
      return { markdown: ticketSections() };
    case "local-fix":
      return { session: recordLocalFix() };
    case "discard":
      return discardSession();
    default:
      throw new Error(
        "Unknown command. Use one of: repo, list, show, new, touch, flag-snapshot, desktop-auth, dispatch-inputs, codex-sessions, ticket-sections, local-fix, discard."
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

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function recordPath(worktree) {
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  return path.join(gitDir, RECORD_FILE);
}

function readRecord(worktree) {
  const file = recordPath(worktree);
  if (!existsSync(file)) {
    return null;
  }
  return withDefaults(JSON.parse(readFileSync(file, "utf8")));
}

function requireRecord(worktree) {
  const record = readRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  return record;
}

function writeRecord(worktree, record) {
  const file = recordPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
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
    .filter((entry) => entry.branch?.startsWith(BRANCH_PREFIX))
    .map((entry) => {
      const record = readRecord(entry.worktree);
      return {
        slug: entry.branch.slice(BRANCH_PREFIX.length),
        branch: entry.branch,
        worktree: entry.worktree,
        summary: record?.summary ?? null,
        ticket: record?.ticket ?? null,
        status: record?.status ?? SessionStatus.Active,
        scope: record?.scope ?? SessionScope.Draft,
        mode: record?.mode ?? null,
        operator: record?.operator ?? null,
        liveTicket: record?.liveTicket ?? null,
        createdAt: record?.createdAt ?? null,
        lastActiveAt: record?.lastActiveAt ?? null,
        vercel: record?.vercel ?? vercelDefaults(entry.branch),
        flagSnapshotTakenAt: record?.flagSnapshot?.takenAt ?? null,
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

function newSession() {
  const repo = resolveRepo();
  const slug = requireOption("slug");
  const summary = requireOption("summary");
  const scope = requireScope(requireOption("scope"));
  const mode = requireMode(requireOption("mode"));
  const operator = operatorFromArgs({ required: true });
  if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Slug must be lowercase words joined by hyphens, at most ${MAX_SLUG_LENGTH} characters.`
    );
  }
  const branch = `${BRANCH_PREFIX}${slug}`;
  const worktree = path.join(
    git(repo, ["rev-parse", "--show-toplevel"]),
    WORKTREE_DIR,
    `${WORKTREE_NAME_PREFIX}${slug}`
  );
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
  git(repo, ["worktree", "add", "--no-track", "-b", branch, worktree, `origin/${base}`]);
  const now = new Date().toISOString();
  const record = {
    slug,
    branch,
    summary,
    ticket: values.ticket ?? null,
    status: SessionStatus.Active,
    scope,
    mode,
    operator,
    liveTicket: null,
    baseCommit: git(worktree, ["rev-parse", "HEAD"]),
    createdAt: now,
    lastActiveAt: now,
    vercel: vercelDefaults(branch),
    flagSnapshot: null,
    clerkOrgId: null,
    desktopAuthSavedAt: null,
    codexSessions: { orchestrators: [], subagents: [] },
    stack: null,
    localFixes: [],
  };
  writeRecord(worktree, record);
  return { worktree, ...record };
}

function touchSession() {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  if (values.status && !Object.values(SessionStatus).includes(values.status)) {
    throw new Error(`--status must be one of: ${Object.values(SessionStatus).join(", ")}.`);
  }
  const liveTicket = values["live-ticket"] ?? values["handoff-ticket"];
  if (liveTicket !== undefined && !TICKET_PATTERN.test(liveTicket)) {
    throw new Error("--live-ticket must be a ClosedLoop slug such as ISS-123.");
  }
  const now = new Date().toISOString();
  const updated = {
    ...record,
    summary: values.summary ?? record.summary,
    ticket: values.ticket ?? record.ticket,
    status: values.status ?? record.status,
    scope: values.scope ? requireScope(values.scope) : record.scope,
    mode: values.mode ? requireMode(values.mode) : record.mode,
    operator: operatorFromArgs({ required: false }) ?? record.operator,
    liveTicket: liveTicket ?? record.liveTicket,
    vercel: updateVercel(record.vercel, now),
    clerkOrgId: values["clerk-org-id"] ? requireClerkOrgId(values["clerk-org-id"]) : record.clerkOrgId,
    stack: values.stack ? JSON.parse(values.stack) : record.stack,
    lastActiveAt: now,
  };
  writeRecord(worktree, updated);
  return { worktree, ...updated };
}

function showSession() {
  const worktree = requireOption("worktree");
  return { worktree, ...requireRecord(worktree) };
}

/** Applies `--vercel` (URLs the environment reported) and `--deployed`. */
function updateVercel(current, now) {
  const next = { ...current };
  if (values.vercel) {
    const given = JSON.parse(values.vercel);
    for (const [key, value] of Object.entries(given)) {
      if (!VERCEL_URL_KEYS.includes(key)) {
        throw new Error(`--vercel accepts only ${VERCEL_URL_KEYS.join(", ")}.`);
      }
      if (typeof value !== "string" || !/^https:\/\/\S+$/.test(value)) {
        throw new Error(`--vercel ${key} must be an https URL.`);
      }
      next[key] = value.replace(/\/$/, "");
    }
  }
  if (values.deployed) {
    if (!COMMIT_PATTERN.test(values.deployed)) {
      throw new Error("--deployed must be a commit SHA.");
    }
    next.lastDeployedCommit = values.deployed;
    next.lastDeployedAt = now;
  }
  return next;
}

function discardSession() {
  const worktree = requireOption("worktree");
  const record = readRecord(worktree);
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(`${worktree} is not a vibe session (branch ${branch}).`);
  }
  const changed = git(worktree, ["status", "--porcelain"]);
  const wouldLose = {
    worktree,
    branch,
    summary: record?.summary ?? null,
    uncommittedFiles: changed ? changed.split("\n").map((line) => line.slice(3)) : [],
    pushed: git(worktree, ["ls-remote", "--heads", "origin", branch]) !== "",
  };
  if (!values.confirm) {
    return { discarded: false, wouldLose };
  }
  const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repo = path.dirname(commonDir);
  git(repo, ["worktree", "remove", "--force", worktree]);
  if (!wouldLose.pushed) {
    git(repo, ["branch", "-D", branch]);
  }
  return { discarded: true, wouldLose };
}

/**
 * The branch new sessions start from: `main`, unless the checkout sets git
 * config `vibe.baseRef` (a temporary override while the symphony-alpha vibe
 * environment is not on main yet; unset it once it is).
 */
function baseBranch(cwd) {
  try {
    return git(cwd, ["config", "--get", "vibe.baseRef"]) || "main";
  } catch {
    return "main";
  }
}

function requireClerkOrgId(id) {
  if (!CLERK_ORG_PATTERN.test(id)) {
    throw new Error("--clerk-org-id must be a Clerk organization id (org_...).");
  }
  return id;
}

function requireMode(mode) {
  if (!Object.values(SessionMode).includes(mode)) {
    throw new Error(`--mode must be one of: ${Object.values(SessionMode).join(", ")}.`);
  }
  return mode;
}

function requireScope(scope) {
  if (!Object.values(SessionScope).includes(scope)) {
    throw new Error(`--scope must be one of: ${Object.values(SessionScope).join(", ")}.`);
  }
  return scope;
}

/**
 * The symphony-alpha checkout: `--repo` when given, otherwise the one
 * vibe-preflight.sh remembered.
 */
function resolveRepo() {
  if (values.repo) {
    return values.repo;
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
      `No symphony-alpha checkout is remembered in ${CONFIG_FILE}. Run vibe-preflight.sh first, or pass --repo.`
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
 * Records files changed to work around a symphony-alpha bug, grouped by the
 * ticket that reports it. Repeating a ticket adds to its paths.
 */
function recordLocalFix() {
  const worktree = requireOption("worktree");
  const ticket = requireOption("ticket");
  if (!TICKET_PATTERN.test(ticket)) {
    throw new Error("--ticket must be a ClosedLoop slug such as ISS-123.");
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
  writeRecord(worktree, updated);
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

function vercelDefaults(branch) {
  return { ...vercelAliases(branch), lastDeployedCommit: null, lastDeployedAt: null };
}

/**
 * Fills fields added after a record was written, and reads the pre-ISS-12057
 * `handoffTicket` as `liveTicket`.
 */
function withDefaults(record) {
  const { handoffTicket, ...rest } = record;
  return {
    ...rest,
    scope: rest.scope ?? SessionScope.Draft,
    mode: rest.mode ?? null,
    operator: rest.operator ?? null,
    liveTicket: rest.liveTicket ?? handoffTicket ?? null,
    vercel: rest.vercel ?? (rest.branch ? vercelDefaults(rest.branch) : null),
    flagSnapshot: rest.flagSnapshot ?? null,
    clerkOrgId: rest.clerkOrgId ?? null,
    desktopAuthSavedAt: rest.desktopAuthSavedAt ?? null,
    codexSessions: rest.codexSessions ?? { orchestrators: [], subagents: [] },
    localFixes: rest.localFixes ?? [],
  };
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
  writeRecord(worktree, updated);
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
  writeRecord(worktree, updated);
  return { worktree, ...updated };
}

function ticketSections() {
  const worktree = requireOption("worktree");
  const record = requireRecord(worktree);
  return renderRecordSections(record, readSnapshot(worktree, record));
}

/** Writes the environment request workflow's inputs for this session to `--out`. */
function dispatchInputs() {
  const worktree = requireOption("worktree");
  const out = requireOption("out");
  const record = requireRecord(worktree);
  const inputs = buildDispatchInputs({
    record,
    snapshot: readSnapshot(worktree, record),
    personEmail: values["person-email"],
    clerkOrgId: record.clerkOrgId ?? undefined,
    desktopAuth: readDesktopAuth(worktree, record),
    requestId: randomUUID(),
  });
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(inputs)}\n`);
  return {
    workflow: DISPATCH_WORKFLOW,
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
  writeRecord(worktree, updated);
  return { worktree, ...updated };
}

function readDesktopAuth(worktree, record) {
  const file = desktopAuthPath(worktree);
  return record.desktopAuthSavedAt && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** The `--operator-*` options as a validated operator, or undefined when none is given and none is required. */
function operatorFromArgs({ required }) {
  const given = ["operator-id", "operator-email", "operator-name"].some((name) => values[name] !== undefined);
  if (!given && !required) {
    return undefined;
  }
  if (!given) {
    throw new Error("--operator-id and --operator-email are required: the person running the session, from ClosedLoop get-me.");
  }
  return validateOperator({
    id: values["operator-id"],
    email: values["operator-email"],
    name: values["operator-name"],
  });
}
