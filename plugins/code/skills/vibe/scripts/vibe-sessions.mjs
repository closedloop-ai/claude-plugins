#!/usr/bin/env node
// Manage vibe sessions: one git worktree per piece of work, on an
// `andy/<slug>` branch, with a session record kept in the worktree's private
// git directory so it is never tracked or committed.
//
// Usage:
//   vibe-sessions.mjs repo
//   vibe-sessions.mjs list      [--repo <symphony-alpha checkout>]
//   vibe-sessions.mjs new       [--repo <checkout>] --slug <slug> --summary <text>
//                               --scope draft|full [--ticket ISS-123]
//   vibe-sessions.mjs touch     --worktree <path> [--summary <text>] [--ticket ISS-123]
//                               [--status active|handed-off] [--handoff-ticket ISS-123]
//                               [--scope draft|full]
//                               [--stack <json>]
//   vibe-sessions.mjs local-fix --worktree <path> --ticket ISS-123 --path <file> [--path <file> ...]
//   vibe-sessions.mjs discard   --worktree <path> [--confirm]
//
// `--repo` defaults to the checkout vibe-preflight.sh remembered in
// ~/.codex/vibe/config.json; `repo` prints it. `local-fix` records files the
// setup worker changed to work around a symphony-alpha bug (filed as the
// ticket), so handoff keeps them out of the person's commit.
//
// Every command prints one JSON object on stdout. Errors print
// {"ok":false,"error":...} and exit non-zero.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const BRANCH_PREFIX = "andy/";
const WORKTREE_DIR = ".claude/worktrees";
const WORKTREE_NAME_PREFIX = "andy-";
const RECORD_FILE = "vibe-session.json";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Vercel's per-branch preview alias is `app-stage-git-andy-<slug>`, and a DNS
// label longer than 63 characters gets truncated and hashed, which would make
// the handoff link unpredictable.
const MAX_SLUG_LENGTH = 40;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Written by vibe-preflight.sh; holds {"repo": "<symphony-alpha checkout>"}.
const CONFIG_FILE = path.join(os.homedir(), ".codex", "vibe", "config.json");
const TICKET_PATTERN = /^[A-Z]+-\d+$/;

const SessionStatus = {
  Active: "active",
  HandedOff: "handed-off",
};

// Draft: frontend only, with stubs, handed to engineering to finish. Full:
// frontend and backend, shipped as a PR an engineer reviews (ISS-12046).
const SessionScope = {
  Draft: "draft",
  Full: "full",
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
    "handoff-ticket": { type: "string" },
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
    case "new":
      return { session: newSession() };
    case "touch":
      return { session: touchSession() };
    case "local-fix":
      return { session: recordLocalFix() };
    case "discard":
      return discardSession();
    default:
      throw new Error(
        "Unknown command. Use one of: repo, list, new, touch, local-fix, discard."
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
  return JSON.parse(readFileSync(file, "utf8"));
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
        handoffTicket: record?.handoffTicket ?? null,
        createdAt: record?.createdAt ?? null,
        lastActiveAt: record?.lastActiveAt ?? null,
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
    handoffTicket: null,
    baseCommit: git(worktree, ["rev-parse", "HEAD"]),
    createdAt: now,
    lastActiveAt: now,
    stack: null,
    localFixes: [],
  };
  writeRecord(worktree, record);
  return { worktree, ...record };
}

function touchSession() {
  const worktree = requireOption("worktree");
  const record = readRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  if (values.status && !Object.values(SessionStatus).includes(values.status)) {
    throw new Error(`--status must be one of: ${Object.values(SessionStatus).join(", ")}.`);
  }
  const updated = {
    ...record,
    summary: values.summary ?? record.summary,
    ticket: values.ticket ?? record.ticket,
    status: values.status ?? record.status,
    scope: values.scope ? requireScope(values.scope) : (record.scope ?? SessionScope.Draft),
    handoffTicket: values["handoff-ticket"] ?? record.handoffTicket,
    stack: values.stack ? JSON.parse(values.stack) : record.stack,
    lastActiveAt: new Date().toISOString(),
  };
  writeRecord(worktree, updated);
  return { worktree, ...updated };
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
  const record = readRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
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
