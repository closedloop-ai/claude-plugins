import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Executes bounded git reads and operations for the session's exact worktree. */
export function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout,
  }).trim();
}

/** Resolves the private record shared by vibe and handoff, never tracked files. */
function recordPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-session.json");
}

/** Where `worktree`'s session record lives (its private git directory); throws outside a git checkout. */
export function sessionRecordPath(worktree) {
  return recordPath(worktree);
}

/** Reads the persisted record without adding surface-specific defaults. */
export function readSessionRecord(worktree) {
  const file = recordPath(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Keeps Desktop bridge URLs and all ownership data readable only by the owner. */
export function writeSessionRecord(worktree, record) {
  const file = recordPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  // Written whole and renamed into place, so a reader never sees a half-written record (provider.mjs reads one as broken).
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** Reads older ticket records (`handoffTicket`) without inventing a ticket when neither field exists. */
export function sessionLiveTicket(record) {
  return record.liveTicket ?? record.handoffTicket ?? null;
}

/** Verify the linked, canonical worktree and private creation evidence written by `vibe new`. */
export function assertVibeCreatedWorktree(worktree, record) {
  if (typeof worktree !== "string" || !path.isAbsolute(worktree)) throw new Error("an absolute Vibe worktree is required");
  const root = git(worktree, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== realpathSync(worktree)) throw new Error("use the exact Vibe worktree root");
  const privateDir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!existsSync(path.join(privateDir, "commondir")) || !lstatSync(path.join(worktree, ".git")).isFile()) {
    throw new Error("a Vibe-created linked worktree is required");
  }
  const session = record ?? readSessionRecord(worktree);
  if (!session || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(session.slug ?? "") || session.branch !== `vibe/${session.slug}`) {
    throw new Error("a Vibe-created session record and branch are required");
  }
  const canonical = path.join(path.dirname(realpathSync(commonDir)), ".claude", "worktrees", `vibe-${session.slug}`);
  if (realpathSync(worktree) !== canonical) throw new Error("Vibe worktree is outside its canonical creation path");
  if (git(worktree, ["branch", "--show-current"]) !== session.branch) throw new Error("Vibe branch and worktree disagree");
  if (session.worktree && realpathSync(session.worktree) !== realpathSync(worktree)) throw new Error("Vibe record belongs to another worktree");
  if (typeof session.liveTicketCreatedBySession !== "boolean") throw new Error("Vibe ticket ownership provenance is missing");
  if (!session.operator?.id || !session.operator?.email) throw new Error("Vibe operator identity is missing");
  if (!/^[a-f0-9]{40}$/i.test(session.baseCommit ?? "") || !Number.isFinite(Date.parse(session.createdAt ?? ""))) {
    throw new Error("Vibe creation base and time are missing");
  }
  try { git(worktree, ["merge-base", "--is-ancestor", session.baseCommit, "HEAD"]); }
  catch { throw new Error("Vibe creation base is not an ancestor of this worktree"); }
  return session;
}
