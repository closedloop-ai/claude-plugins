// Which fleet program an orchestrator chat runs (ISS-14028). A fleet home once
// had one `current` program, and every vibe hook and script resolved that home
// from FLEET_HOME at launch, so a second orchestrator chat on the same machine
// read and wrote the first chat's program unless it was launched with the
// variable (operator, 2026-11-11: "I know you're not expecting people to have
// to know to add those env variables before launching claude").
//
// `fleet-home.mjs start` and `resume` bind the chat that runs them: one file
// per chat under ~/.vibe-hook-scope/fleet-binding/, naming the home and the
// program, so a hook or script in that chat finds its program with no
// environment variable, even in a second home. A program has at most one
// chat. Binding a program another chat holds is refused, naming that chat and
// when it bound, unless the caller passes takeover (the hand-over to a new
// chat after the old one finished; orchestrator, 2026-11-11: an accidental
// resume must not steal a live chat's program). Each program has one claim
// file under fleet-binding/claims/, and a bind runs its check and writes
// (claim, binding, the claim it leaves, the chats it takes over) under that
// program's lock file, created exclusively, so of two chats claiming one
// program at the same moment exactly one wins and the other gets HELD. A lock
// whose owning process has exited is reclaimed. A claim whose holder has since
// bound another program is stale and is replaced. A chat taken over keeps a
// note under fleet-binding/taken/, so its scripts given the home path are
// refused (TAKEN-OVER) instead of resolving `current`. The chat is the harness
// conversation (harness-identity.mjs for a command; a hook passes its event's
// session_id, the same id). Only that one id is recorded: when both harness
// ids are set, the other one was inherited from another conversation.
//
// Resolution (programFor): FLEET_HOME names the home when set; else the
// chat's binding; else ~/fleet-orchestrator. In that home the chat's own
// program wins; else `current` when no other chat holds it, the
// single-orchestrator behavior from before bindings; else no program.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessActor } from "../../vibe/scripts/harness-identity.mjs";

const CHAT = /^[A-Za-z0-9_.:-]{1,128}$/;
const BINDING_DIR = path.join(".vibe-hook-scope", "fleet-binding");
const MAX_BINDING_BYTES = 4096;
const STALE_TRANSCRIPT_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 10;
// A bind holds its lock for a few file writes; an unreadable lock this old was left by a process that died mid-write.
const LOCK_STALE_MS = 30_000;

/** The chat a command runs in (CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID), or null outside a harness. */
export function commandChat(env = process.env) {
  return harnessActor(env)?.id ?? null;
}

/** A usable chat id, or null. */
export function validChat(chat) {
  return typeof chat === "string" && CHAT.test(chat) ? chat : null;
}

function bindingDir(env) {
  return path.join(env.HOME || os.homedir(), BINDING_DIR);
}

function bindingFile(chat, env) {
  return validChat(chat) ? path.join(bindingDir(env), `${chat}.json`) : null;
}

function readBindingFile(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BINDING_BYTES) return null;
    const record = JSON.parse(readFileSync(file, "utf8"));
    return typeof record?.home === "string" && typeof record.program === "string" && validChat(record.chat) ? record : null;
  } catch {
    return null;
  }
}

/** `{ chat, home, program, boundAt }` for `chat`, or null when it has none. */
export function chatBinding(chat, env = process.env) {
  if (!validChat(chat)) return null;
  const record = readBindingFile(bindingFile(chat, env));
  return record && record.chat === chat ? record : null;
}

function takenFile(chat, env) {
  return path.join(bindingDir(env), "taken", `${chat}.json`);
}

/**
 * `{ chat, home, program, takenBy, at }` when another chat took `chat`'s program, still holds it, and `chat` has
 * bound nothing since, else null.
 */
export function takenOver(chat, env = process.env) {
  if (!validChat(chat)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(takenFile(chat, env), "utf8"));
  } catch {
    return null;
  }
  if (record?.chat !== chat || typeof record.home !== "string" || typeof record.program !== "string") return null;
  return claimHolder(record.home, record.program, env)?.chat === record.takenBy ? record : null;
}

function claimsDir(env) {
  return path.join(bindingDir(env), "claims");
}

function homeKey(home) {
  return createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 16);
}

function claimFile(home, program, env) {
  return path.join(claimsDir(env), `${homeKey(home)}.${program}.json`);
}

/** The chat holding `program` in `home` with its binding (null while that binding is being written), or null when none does. */
function claimHolder(home, program, env) {
  const claim = readBindingFile(claimFile(home, program, env));
  if (!claim) return null;
  const binding = readBindingFile(bindingFile(claim.chat, env));
  // A holder whose binding names another program has moved on; its claim is stale.
  if (binding && (path.resolve(binding.home) !== path.resolve(home) || binding.program !== program)) return null;
  return { chat: claim.chat, binding };
}

/** The chats bound to `program` in `home` (at most one). */
export function programChats(home, program, env = process.env) {
  const holder = claimHolder(home, program, env);
  return holder ? [holder.chat] : [];
}

/** The chats other than `chat` bound to `program` in `home`. */
function programHolders(home, program, chat, env) {
  const holder = claimHolder(home, program, env);
  return !holder || holder.chat === chat ? [] : [holder.chat];
}

/** The programs of `home` that some chat holds. */
export function boundPrograms(home, env = process.env) {
  const prefix = `${homeKey(home)}.`;
  let names = [];
  try { names = readdirSync(claimsDir(env)); } catch {}
  return names.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).map((name) => name.slice(prefix.length, -".json".length))
    .filter((program) => claimHolder(home, program, env)).sort();
}

/** Removes the claim on `program` in `home` when `chat` holds it. */
function releaseClaim(home, program, chat, env) {
  const file = claimFile(home, program, env);
  if (readBindingFile(file)?.chat === chat) unlinkSync(file);
}

/**
 * Binds `chat` to `program` in `home`; returns the other chats it was taken from. A null chat binds nothing.
 * Throws `HELD ...` when another chat holds the program, unless `takeover`. The check and every write run under
 * the program's lock, so two chats binding one program at once cannot both pass the check.
 */
export function bindChat(chat, home, program, env = process.env, { now = new Date(), takeover = false } = {}) {
  const file = bindingFile(chat, env);
  if (!file) return [];
  const resolved = path.resolve(home);
  const bound = withProgramLock(resolved, program, env, () => {
    const others = refuseHeld(chat, resolved, program, env, { now, takeover });
    const record = `${JSON.stringify({ chat, home: resolved, program, boundAt: now.toISOString() })}\n`;
    writeAtomic(claimFile(resolved, program, env), record);
    const previous = chatBinding(chat, env);
    writeAtomic(file, record);
    try { unlinkSync(takenFile(chat, env)); } catch {}
    for (const other of others) {
      const record = chatBinding(other, env);
      if (record && path.resolve(record.home) === resolved && record.program === program) unlinkSync(bindingFile(other, env));
      writeAtomic(takenFile(other, env), `${JSON.stringify({ chat: other, home: resolved, program, takenBy: chat, at: now.toISOString() })}\n`);
    }
    return { others, previous };
  });
  // The program left behind is released under its own lock, after this one is let go, so two chats swapping
  // programs never wait on each other's lock.
  const left = bound.previous;
  if (left && (path.resolve(left.home) !== resolved || left.program !== program)) {
    withProgramLock(left.home, left.program, env, () => releaseClaim(left.home, left.program, chat, env));
  }
  return bound.others;
}

/**
 * Runs `fn` holding `program`'s lock in `home`. The lock is a file linked into place already holding
 * `<pid> <token>`, so no process ever reads it half written. A live owner is waited on, then refused (BUSY).
 * A lock whose owner has exited, or one older than LOCK_STALE_MS that cannot be read, is reclaimed by
 * renaming exactly that file aside and checking it is the one read; one renamed by mistake is put back.
 * The lock is removed at the end only while it still holds this call's token.
 */
function withProgramLock(home, program, env, fn) {
  const lock = `${claimFile(home, program, env)}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${randomUUID()}`;
  const temp = `${lock}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(temp, lock);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const seen = readOr(lock);
      const owner = Number(seen.trim().split(/\s+/)[0]);
      if (staleLock(lock, seen, owner)) {
        reclaim(lock, seen);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`BUSY ${program}: another fleet-home.mjs (pid ${owner || "unknown"}) is binding it; run the command again`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  } finally {
    try { unlinkSync(temp); } catch {}
  }
  try {
    return fn();
  } finally {
    if (readOr(lock).trim() === token) {
      try { unlinkSync(lock); } catch {}
    }
  }
}

/** Whether the lock holding `seen` is abandoned: its owner exited, or it cannot be read and is older than LOCK_STALE_MS. */
function staleLock(lock, seen, owner) {
  if (/^\d+ \S+$/.test(seen.trim())) return !processAlive(owner);
  try {
    return Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Moves the abandoned lock holding `seen` aside; a lock that changed in between is put back. */
function reclaim(lock, seen) {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  if (readOr(aside) === seen) {
    try { unlinkSync(aside); } catch {}
    return;
  }
  try {
    linkSync(aside, lock);
  } catch {}
  try { unlinkSync(aside); } catch {}
}

function readOr(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

/** Removes `chat`'s binding and its claim; returns the binding it had, or null. */
export function unbindChat(chat, env = process.env) {
  const record = chatBinding(chat, env);
  if (!record) return null;
  return withProgramLock(record.home, record.program, env, () => {
    releaseClaim(record.home, record.program, chat, env);
    try { unlinkSync(bindingFile(chat, env)); } catch {}
    return record;
  });
}

/** The home a chat works in: FLEET_HOME when set, else its binding's home, else ~/fleet-orchestrator. */
export function chatHome(chat, env = process.env) {
  if (env.FLEET_HOME) return path.resolve(env.FLEET_HOME);
  const binding = chatBinding(chat, env);
  if (binding && isDir(path.join(binding.home, "programs"))) return path.resolve(binding.home);
  return path.join(env.HOME || os.homedir(), "fleet-orchestrator");
}

/**
 * The program `chat` resolves in `home`:
 * `{ program, source: "bound" | "current" }`, `{ program: null, current, owners }` when `current`
 * belongs to another chat, or `{ program: null, current: null }` when the home has none.
 */
export function programFor(home, chat, env = process.env) {
  const resolved = path.resolve(home);
  const binding = chatBinding(chat, env);
  if (binding && path.resolve(binding.home) === resolved && isDir(path.join(resolved, "programs", binding.program))) {
    return { program: binding.program, source: "bound" };
  }
  const taken = takenOver(chat, env);
  if (taken && path.resolve(taken.home) === resolved) return { program: null, current: taken.program, owners: [taken.takenBy] };
  const current = currentProgram(resolved);
  if (!current) return { program: null, current: null };
  const owners = programHolders(resolved, current, chat, env);
  return owners.length === 0 ? { program: current, source: "current" } : { program: null, current, owners };
}

/** The slug `<home>/current` names when its program dir exists, else null. */
export function currentProgram(home) {
  const file = path.join(home, "current");
  const slug = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return slug && isDir(path.join(home, "programs", slug)) ? slug : null;
}

/** The other chats holding `program` in `home`; throws `HELD ...` when there are any and `takeover` is not set. */
export function refuseHeld(chat, home, program, env = process.env, { now = new Date(), takeover = false } = {}) {
  const others = programHolders(home, program, chat, env);
  if (others.length > 0 && !takeover) throw new Error(`HELD ${program} is bound to ${describeHolders(others, env, now)}. Pass --takeover only if that chat has finished; it is then told it has no program, and its scripts given the home path are refused`);
  return others;
}

/** Each holder chat, when it bound and, for a Claude Code chat, when its transcript was last written and whether it looks finished. */
function describeHolders(others, env, now = new Date()) {
  return others.map((other) => {
    const boundAt = chatBinding(other, env)?.boundAt ?? "an unknown time";
    const written = claudeTranscriptTime(other, env);
    if (written === null) return `chat ${other} (bound ${boundAt})`;
    const stale = now.getTime() - written.getTime() > STALE_TRANSCRIPT_MS ? "; it looks stale" : "";
    return `chat ${other} (bound ${boundAt}; its transcript was last written ${written.toISOString()}${stale})`;
  }).join(" and ");
}

/** When the Claude Code transcript of `chat` was last written (~/.claude/projects/<project>/<chat>.jsonl), or null. */
function claudeTranscriptTime(chat, env) {
  const projects = path.join(env.HOME || os.homedir(), ".claude", "projects");
  try {
    for (const project of readdirSync(projects)) {
      const file = path.join(projects, project, `${chat}.jsonl`);
      if (existsSync(file)) return statSync(file).mtime;
    }
  } catch {}
  return null;
}

/** The line telling a chat with no program of its own how to bind one. */
export function unboundLine(home, resolved, env = process.env) {
  return `UNBOUND: this chat has no fleet program in ${home}; its current program ${resolved.current} is bound to ${describeHolders(resolved.owners, env)}. If that chat has finished, take the program over with fleet-home.mjs resume ${resolved.current} --takeover; otherwise start your own with fleet-home.mjs start <slug>. Write no program state before either`;
}

/**
 * Why `home` is ambiguous for a caller with no program of its own (null when it is not): a program other
 * than `current` is bound to a chat, so `current` may be another chat's program.
 */
export function ambiguousHome(home, env = process.env) {
  const current = currentProgram(home);
  const others = boundPrograms(home, env).filter((program) => program !== current);
  if (others.length === 0) return null;
  return `AMBIGUOUS-HOME ${path.resolve(home)} runs several chats' programs (${[...(current ? [`${current} current`] : []), ...others].join(", ")}): pass the program dir (${path.join(path.resolve(home), "programs", "<slug>")}) instead of the home, or run this from the chat bound to the program`;
}

function isDir(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
