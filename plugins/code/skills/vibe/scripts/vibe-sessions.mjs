#!/usr/bin/env node
// Manage vibe sessions: one git worktree per piece of work, on an
// `andy/<slug>` branch, with a session record kept in the worktree's private
// git directory so it is never tracked or committed.
//
// Usage:
//   vibe-sessions.mjs list    --repo <symphony-alpha checkout>
//   vibe-sessions.mjs new     --repo <checkout> --slug <slug> --summary <text> [--ticket ISS-123]
//   vibe-sessions.mjs touch   --worktree <path> [--summary <text>] [--ticket ISS-123]
//                             [--status active|handed-off] [--handoff-ticket ISS-123]
//                             [--stack <json>]
//   vibe-sessions.mjs discard --worktree <path> [--confirm]
//
// Every command prints one JSON object on stdout. Errors print
// {"ok":false,"error":...} and exit non-zero.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const SessionStatus = {
  Active: "active",
  HandedOff: "handed-off",
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
    "handoff-ticket": { type: "string" },
    stack: { type: "string" },
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
    case "list":
      return { sessions: listSessions(requireOption("repo")) };
    case "new":
      return { session: newSession() };
    case "touch":
      return { session: touchSession() };
    case "discard":
      return discardSession();
    default:
      throw new Error(
        "Unknown command. Use one of: list, new, touch, discard."
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
        handoffTicket: record?.handoffTicket ?? null,
        createdAt: record?.createdAt ?? null,
        lastActiveAt: record?.lastActiveAt ?? null,
        stack: record?.stack ?? null,
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
  const repo = requireOption("repo");
  const slug = requireOption("slug");
  const summary = requireOption("summary");
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
    handoffTicket: null,
    baseCommit: git(worktree, ["rev-parse", "HEAD"]),
    createdAt: now,
    lastActiveAt: now,
    stack: null,
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
