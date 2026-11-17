// Which fleet program an orchestrator chat runs. A fleet home once
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
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
// Each reclaimer that dies holding a tombstone adds one link to the chain; past this many the lock stays BUSY.
const MAX_RECLAIM_CHAIN = 16;

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

/**
 * A home's one spelling: its real path when it exists, so a symlinked, relative or (on a case-insensitive volume)
 * differently cased spelling of the same home gets the same claims and lock rather than a second set. The native
 * realpath returns the case on disk; the JavaScript one keeps the case it was given.
 */
export function canonicalHome(home) {
  const resolved = path.resolve(home);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * A program's one spelling: the name of the dir `program` opens, matched exactly first and then ignoring case, so
 * `P` and `p` on a case-insensitive volume get the same claim and lock. With no such dir the name stays as given:
 * on a case-sensitive volume `P` and `p` are two programs.
 */
export function canonicalProgram(home, program) {
  const programs = path.join(home, "programs");
  if (!isDir(path.join(programs, program))) return program;
  try {
    const names = readdirSync(programs);
    return names.find((name) => name === program) ?? names.find((name) => name.toLowerCase() === program.toLowerCase()) ?? program;
  } catch {
    return program;
  }
}

function homeKey(home) {
  return createHash("sha256").update(canonicalHome(home)).digest("hex").slice(0, 16);
}

function claimFile(home, program, env) {
  return path.join(claimsDir(env), `${homeKey(home)}.${canonicalProgram(canonicalHome(home), program)}.json`);
}

/** Whether two `{ home, program }` records name one program: they share its claim file, whatever their spelling. */
function sameProgram(a, b, env) {
  return Boolean(a && b) && claimFile(a.home, a.program, env) === claimFile(b.home, b.program, env);
}

/**
 * The chat holding `program` in `home`, with its binding, or null when none does. A claim whose chat is bound
 * elsewhere or not at all is stale: a bind writes the claim and the binding under the program's lock, and every
 * bind checks again under that lock, so a reader outside it never needs the moment between the two writes.
 */
function claimHolder(home, program, env) {
  const claim = readBindingFile(claimFile(home, program, env));
  if (!claim) return null;
  const binding = readBindingFile(bindingFile(claim.chat, env));
  if (!sameProgram(binding, claim, env)) return null;
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
  program = canonicalProgram(resolved, program);
  const bound = withProgramLock(resolved, program, env, () => {
    const others = refuseHeld(chat, resolved, program, env, { now, takeover });
    // Order matters if this process dies between writes: each chat taken over loses its binding (and gets its note)
    // before the claim changes hands, and the claim is written before this chat's binding, so a crash leaves at
    // worst a program nobody holds, never a binding beside another chat's claim.
    for (const other of others) {
      const record = chatBinding(other, env);
      if (sameProgram(record, { home: resolved, program }, env)) unlinkSync(bindingFile(other, env));
      writeAtomic(takenFile(other, env), `${JSON.stringify({ chat: other, home: resolved, program, takenBy: chat, at: now.toISOString() })}\n`);
    }
    const record = `${JSON.stringify({ chat, home: resolved, program, boundAt: now.toISOString() })}\n`;
    writeAtomic(claimFile(resolved, program, env), record);
    writeAtomic(file, record);
    try { unlinkSync(takenFile(chat, env)); } catch {}
    return { others };
  });
  // Released after this lock is let go, so two chats swapping programs never wait on each other's lock. Best effort, after the bind committed, each under its own program's lock: the claims this chat held
  // elsewhere, and any the chats it took over still hold. One left behind on a busy lock is released by the
  // chat's next bind or unbind, and reads as stale meanwhile, since that chat is bound elsewhere or not at all.
  releaseLeftoverClaims(chat, env, { home: resolved, program });
  for (const other of bound.others) releaseLeftoverClaims(other, env, null);
  return bound.others;
}

/**
 * Runs `fn` holding `program`'s lock in `home`. The lock is a file linked into place already holding
 * `<pid> <token>`, so no process ever reads it half written. A live owner is waited on, then refused (BUSY).
 * A lock whose owner has exited, or one older than LOCK_STALE_MS that cannot be read, is reclaimed (reclaimStaleLock),
 * after which every waiter goes back through the exclusive link, which one wins. The lock is removed at the end
 * only while it still holds this call's token.
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
      if (staleLock(lock, seen, owner) && reclaimStaleLock(lock, seen)) continue;
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

/**
 * Removes the abandoned lock holding `seen` and returns whether it did (the caller then retries at once; otherwise it
 * waits like any contender). Only the holder of a tombstone tied to that exact lock may remove it: a file linked
 * into place exclusively, holding the holder's pid and token, named `<lock>.reclaim.<key>` with key a hash of
 * `seen`. The holder re-reads the lock and unlinks it only if it still holds `seen`: while that lock exists nobody
 * can link a new one, and its dead owner never removes it, so the file unlinked is the one read, and lock contents
 * carry a unique token, so that lock never comes back. A tombstone is never moved or cleared by age. A live holder,
 * however slow, is waited on. When a holder died, the next reclaimer links a new tombstone whose key also hashes
 * the dead holder's, so exactly one process moves on from each dead holder; their tombstones are removed with a token lock and left
 * in place for an unreadable one. A tombstone whose pid was reused by a live process keeps the lock BUSY. `hooks.beforeRemove` runs just before the re-read, for the tests.
 */
export function reclaimStaleLock(lock, seen, hooks = {}) {
  const token = `${process.pid} ${randomUUID()}`;
  let key = createHash("sha256").update(seen).digest("hex").slice(0, 32);
  const passed = [];
  for (let depth = 0; depth < MAX_RECLAIM_CHAIN; depth += 1) {
    const tomb = `${lock}.reclaim.${key}`;
    if (!linkFilled(tomb, `${token}\n`)) {
      const holder = readOr(tomb).trim();
      // A tombstone is linked into place already filled, so one that is empty or unreadable was never a live holder's
      // (cut short by a crash, or unlinked just now by its holder after the removal): it is passed like a dead one.
      if (/^\d+ \S+$/.test(holder) && processAlive(Number(holder.split(/\s+/)[0]))) return false;
      passed.push(tomb);
      key = createHash("sha256").update(`${key}\n${holder}`).digest("hex").slice(0, 32);
      continue;
    }
    let removed = false;
    try {
      hooks.beforeRemove?.();
      if (readFileSync(lock, "utf8") === seen) {
        unlinkSync(lock);
        removed = true;
      }
    } catch {}
    // This call's own tombstone goes: a reclaimer that links it again re-reads a different lock. The dead holders'
    // tombstones go too once a lock with a unique token was removed, since no lock can hold `seen` again. For an
    // unreadable lock, whose contents can repeat, they stay, so every later taker passes the same chain links.
    // Each tombstone left behind is one reclaimer that died holding it, so they are bounded by crashes.
    const unique = /^\d+ \S+$/.test(seen.trim());
    for (const file of [tomb, ...(removed && unique ? passed : [])]) {
      try { unlinkSync(file); } catch {}
    }
    return removed;
  }
  return false;
}

/** Links a file holding `text` into place at `file` exclusively; returns false when one is already there. */
function linkFilled(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  } finally {
    try { unlinkSync(temp); } catch {}
  }
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
  withProgramLock(record.home, record.program, env, () => {
    // Read again under the lock, since a takeover may have removed the binding. The binding goes before the claim,
    // so a crash between them leaves a stale claim, never an unclaimed binding.
    if (sameProgram(chatBinding(chat, env), record, env)) unlinkSync(bindingFile(chat, env));
    releaseClaim(record.home, record.program, chat, env);
  });
  releaseLeftoverClaims(chat, env, null);
  return record;
}

/**
 * Releases, best effort and each under its program's lock, every claim naming `chat` except the one at `keep` and
 * the one `chat` is bound to when the lock is taken: a chat taken over may have bound another program meanwhile.
 * Exported for the tests.
 */
export function releaseLeftoverClaims(chat, env, keep) {
  let names = [];
  try { names = readdirSync(claimsDir(env)); } catch {}
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const claim = readBindingFile(path.join(claimsDir(env), name));
    if (claim?.chat !== chat || sameProgram(claim, keep, env)) continue;
    try {
      withProgramLock(claim.home, claim.program, env, () => {
        const bound = chatBinding(chat, env);
        if (sameProgram(bound, claim, env)) return;
        releaseClaim(claim.home, claim.program, chat, env);
      });
    } catch {}
  }
}

/**
 * What a bind of `chat` to `program` in `home` may change, for restoreBinding: the chat's binding and takeover note,
 * the program's claim, and the chat's previous program and its claim. Contents are null when absent.
 */
export function captureBinding(chat, home, program, env = process.env) {
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const resolved = path.resolve(home);
  const previous = chatBinding(chat, env);
  return {
    chat, home: resolved, program: canonicalProgram(resolved, program),
    binding: read(bindingFile(chat, env)), taken: read(takenFile(chat, env)), claim: read(claimFile(resolved, program, env)),
    previous: previous && { home: path.resolve(previous.home), program: previous.program, claim: read(claimFile(previous.home, previous.program, env)) },
  };
}

/**
 * Undoes a bind captureBinding recorded, under the program's lock and then the previous program's, re-reading every
 * file inside the lock. It never gives a program to a chat that does not hold it already, so the worst it leaves is
 * a chat with no program, never a program with two holders:
 * - it removes the chat's claim and binding on the program while they are still the chat's;
 * - it puts the program's earlier claim back only for a chat whose binding still names the program (a bind that
 *   failed before it took that chat's binding over);
 * - a chat this bind did take over stays taken over and can resume the program, which nobody then holds;
 * - it gives the chat its previous program back only when the captured claim and binding were the chat's own and
 *   nobody claims that program now.
 * A bind to the program the chat already held is left as it is.
 */
export function restoreBinding(snapshot, env = process.env) {
  const { chat, home, program, previous } = snapshot;
  if (!validChat(chat)) return;
  const samePlace = (record, at) => sameProgram(record, at, env);
  if (samePlace(previous, { home, program })) return;
  // A bind that failed before writing anything left nothing to undo.
  const now = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  if (now(claimFile(home, program, env)) === snapshot.claim && now(bindingFile(chat, env)) === snapshot.binding
    && (!previous || now(claimFile(previous.home, previous.program, env)) === previous.claim)) return;
  const parse = (text) => {
    try { return text === null ? null : JSON.parse(text); } catch { return null; }
  };
  withProgramLock(home, program, env, () => {
    // The binding goes before the claim, so a crash between them leaves a stale claim, never an unclaimed binding.
    if (samePlace(chatBinding(chat, env), { home, program })) unlinkSync(bindingFile(chat, env));
    if (readBindingFile(claimFile(home, program, env))?.chat === chat) unlinkSync(claimFile(home, program, env));
    const earlier = parse(snapshot.claim);
    if (!existsSync(claimFile(home, program, env)) && validChat(earlier?.chat) && earlier.chat !== chat
      && samePlace(chatBinding(earlier.chat, env), { home, program })) {
      writeAtomic(claimFile(home, program, env), snapshot.claim);
    }
    if (snapshot.taken !== null && !existsSync(takenFile(chat, env))) writeAtomic(takenFile(chat, env), snapshot.taken);
  });
  if (!previous || parse(previous.claim)?.chat !== chat || !samePlace(parse(snapshot.binding), previous)) return;
  withProgramLock(previous.home, previous.program, env, () => {
    const holder = readBindingFile(claimFile(previous.home, previous.program, env));
    if (holder && holder.chat !== chat) return;
    if (existsSync(bindingFile(chat, env))) return;
    writeAtomic(claimFile(previous.home, previous.program, env), previous.claim);
    writeAtomic(bindingFile(chat, env), snapshot.binding);
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
  if (binding && canonicalHome(binding.home) === canonicalHome(resolved) && isDir(path.join(resolved, "programs", binding.program))) {
    return { program: canonicalProgram(resolved, binding.program), source: "bound" };
  }
  const taken = takenOver(chat, env);
  if (taken && canonicalHome(taken.home) === canonicalHome(resolved)) return { program: null, current: taken.program, owners: [taken.takenBy] };
  const current = currentProgram(resolved);
  if (!current) return { program: null, current: null };
  const owners = programHolders(resolved, current, chat, env);
  return owners.length === 0 ? { program: current, source: "current" } : { program: null, current, owners };
}

/** The program `<home>/current` names, spelled as its dir is, when that dir exists, else null. */
export function currentProgram(home) {
  const file = path.join(home, "current");
  const slug = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return slug && isDir(path.join(home, "programs", slug)) ? canonicalProgram(home, slug) : null;
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
  const others = boundPrograms(home, env).filter((program) => canonicalProgram(home, program) !== current);
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
