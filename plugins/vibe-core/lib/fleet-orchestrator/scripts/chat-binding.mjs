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
// resume must not steal a live chat's program). The chat is the harness
// conversation (harness-identity.mjs for a command; a hook passes its event's
// session_id, the same id).
//
// Resolution (programFor): FLEET_HOME names the home when set; else the
// chat's binding; else ~/fleet-orchestrator. In that home the chat's own
// program wins; else `current` when no other chat holds it, the
// single-orchestrator behavior from before bindings; else no program.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessActor } from "../../vibe/scripts/harness-identity.mjs";

const CHAT = /^[A-Za-z0-9_.:-]{1,128}$/;
const BINDING_DIR = path.join(".vibe-hook-scope", "fleet-binding");
const MAX_BINDING_BYTES = 4096;
const STALE_TRANSCRIPT_MS = 60 * 60 * 1000;

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

/** Every readable binding record. */
function allBindings(env) {
  const dir = bindingDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => readBindingFile(path.join(dir, name))).filter(Boolean);
}

/** Whether `record` is `chat`'s own: its id, or another id the same conversation carried when it bound. */
function isOwn(record, chat) {
  return record.chat === chat || (Array.isArray(record.aliases) && record.aliases.includes(chat));
}

/** `{ chat, aliases, home, program, boundAt }` for `chat`, or null when it has none. */
export function chatBinding(chat, env = process.env) {
  if (!validChat(chat)) return null;
  const record = readBindingFile(bindingFile(chat, env));
  if (record && record.chat === chat) return record;
  return allBindings(env).find((other) => isOwn(other, chat)) ?? null;
}

/** The chats bound to `program` in `home`. */
export function programChats(home, program, env = process.env) {
  const resolved = path.resolve(home);
  return allBindings(env).filter((record) => path.resolve(record.home) === resolved && record.program === program).map((record) => record.chat);
}

/** The chats other than `chat` bound to `program` in `home`. */
function programHolders(home, program, chat, env) {
  const resolved = path.resolve(home);
  return allBindings(env).filter((record) => path.resolve(record.home) === resolved && record.program === program && !isOwn(record, chat))
    .map((record) => record.chat);
}

/** The programs of `home` that some chat is bound to. */
export function boundPrograms(home, env = process.env) {
  const resolved = path.resolve(home);
  return [...new Set(allBindings(env).filter((record) => path.resolve(record.home) === resolved).map((record) => record.program))].sort();
}

/**
 * Binds `chat` to `program` in `home`; returns the other chats it was taken from. A null chat binds nothing.
 * Throws `HELD ...` when another chat holds the program, unless `takeover`. The command's other harness id,
 * when one is set (harness-identity.mjs picks between them), is kept as an alias, so a hook keyed by it agrees.
 */
export function bindChat(chat, home, program, env = process.env, { now = new Date(), takeover = false } = {}) {
  const file = bindingFile(chat, env);
  if (!file) return [];
  const resolved = path.resolve(home);
  const others = refuseHeld(chat, resolved, program, env, { now, takeover });
  for (const other of others) unbindChat(other, env);
  unbindChat(chat, env);
  const aliases = [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID].filter((id) => validChat(id) && id !== chat);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ chat, ...(aliases.length > 0 ? { aliases } : {}), home: resolved, program, boundAt: now.toISOString() })}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return others;
}

/** Removes `chat`'s binding; returns the binding it had, or null. */
export function unbindChat(chat, env = process.env) {
  const record = chatBinding(chat, env);
  if (record) unlinkSync(bindingFile(record.chat, env));
  return record;
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
  if (others.length > 0 && !takeover) throw new Error(`HELD ${program} is bound to ${describeHolders(others, env, now)}. Pass --takeover only if that chat has finished; it then resolves no program`);
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
