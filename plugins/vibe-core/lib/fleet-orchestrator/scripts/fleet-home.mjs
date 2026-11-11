#!/usr/bin/env node
// One fleet home holds everything an orchestrator chat reuses, and keeps one
// program's state away from the next. A new chat once inherited only part of
// a program: the resume log and lessons ledger lived outside the work dir,
// Codex writers started without fleet.sh kept their state in other
// directories, and Claude pane workers and the watcher lock died or stayed
// with the old chat.
//
// Layout (codex-fleet-monitor/scripts/work-dir.mjs resolves it for every script):
//   <fleetHome>/config.env, standing-rulings.md, lessons.md, handover.md   reused by every program
//   <fleetHome>/context-guard.json                                        compaction limits for vibe's context hooks
//   <fleetHome>/current                                                   the program of a chat with none bound
//   <fleetHome>/programs/<slug>/                                          that program's state
//
// Usage: fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet [--home <fleetHome>]
//        fleet-home.mjs shape no-writer|one-writer|fleet [--home <fleetHome>]
//        fleet-home.mjs close [--home <fleetHome>]
//        fleet-home.mjs resume [<slug> [--takeover]] [--home <fleetHome>]
//        fleet-home.mjs check [--home <fleetHome or program dir>]
//        fleet-home.mjs migrate --from <flat work dir> --program <slug> [--home <fleetHome, default --from>] [--dry-run]
//        fleet-home.mjs launcher [--install] [--bin <dir, default ~/.local/bin>] [--home <fleetHome>]
//
// Each orchestrator chat is bound to its own program (chat-binding.mjs,
// ISS-14028): `start`, `resume` and `migrate` bind the chat that runs them, and
// every vibe hook and script in that chat resolves that program with no
// environment variable. --home defaults to FLEET_HOME (an explicit override),
// else the chat's bound home, else ~/fleet-orchestrator. `current` is the
// program of anything with no binding (a chat from before bindings, a
// terminal, a worker given the home path); a chat with no binding gets it only
// while no other chat holds it, so with one orchestrator nothing changes.
// `start` creates programs/<slug>/ and binds this chat to it; it refuses while
// this chat's own program is open (with no chat id, while another program is
// current), so a new program never reads an older one's state, and it makes
// the program current only when the home has none. `close` unbinds the chat
// and clears `current` when it named that program. `resume <slug>` binds this
// chat to that program; one another chat holds is refused (`HELD`, naming
// that chat and when it bound) unless --takeover, which prints `TAKEOVER <chat>`.
// Every program records its shape in
// program.json (SKILL.md, "Programs with one writer or none"): `no-writer`
// (the orchestrator researches or designs with nobody writing code),
// `one-writer` (one writer and one PR) or `fleet` (several writers). Two
// audited sessions ran the skill as one person with no workers and as one
// writer on one PR, with no guidance for either. `shape` changes it when the
// program grows; board.mjs refuses a writer the shape does not allow.
// `resume` prints what a new chat reads, in order: the reusable files, then
// `ACTIVE <slug>` and the program's files (or `UNBOUND` with how to bind when
// the home's current program belongs to another chat), `RELAUNCH <writer> <prompt>` for
// each Claude writer on the board (its newest prompts/<writer>-*.md) and
// `WATCHER-LIVE <pid>` while another chat's watcher holds the lock; or
// `NO-ACTIVE-PROGRAM`. After `ACTIVE` it prints `SHAPE <shape>: <what
// applies>` (or `SHAPE-UNSET`) and the program's plugin version line from
// plugin-version.json: `PLUGIN-VERSION-UNCHECKED` when the check never ran,
// `PLUGIN-VERSION-UNANSWERED` while an outdated plugin has no recorded
// choice, else the last result. Every new chat runs the check again.
// `resume` also writes the default context-guard.json when the home has none
// (vibe's compaction hooks; the operator's 2026-11-09 ruling).
// `check` prints, and exits 1 on, state outside the home or the program:
// `FLAT <name>` (program state at the home's top), `OUTSIDE <link> -> <target>`
// (a symlink in the home resolving outside it), `CONFIG <key>` (a per-program
// key in the home's config.env), `SHARED-REMOTE` (REMOTE_STATE_DIR without
// REMOTE_FLEET_HOME, shared by every program), `UNMANAGED <where> <name>` (a
// sessions.txt session with no state file fleet.sh wrote) and
// `UNMANAGED-STATE <file>` (Codex thread state outside sessions/), and
// `PENDING-REMOTE remote <name>` (prepared ownership needing recover-marker).
// Given a
// flat work dir it prints `FLAT-LAYOUT`. board.mjs status prints the same lines.
// `migrate` turns a flat work dir into a home (fleet-migrate.mjs); it refuses
// while a watcher holds the lock and, in the dry run and the real run, on any
// collision. rulings.md moves with the program: copy its standing rulings into
// standing-rulings.md.
// `launcher` prints, or installs as `fleet-claude`, the command that starts
// Claude Code with the compaction window context-guard.json sets, so nobody
// has to know CLAUDE_CODE_AUTO_COMPACT_WINDOW.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PER_PROGRAM_KEYS, parseConfig, resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { bindChat, chatBinding, chatHome, commandChat, currentProgram, programChats, programFor, refuseHeld, unbindChat, unboundLine } from "./chat-binding.mjs";
import { migrate } from "./fleet-migrate.mjs";
import { skillFreshnessProblem } from "./skill-freshness.mjs";
import { vibeScriptPath } from "../../../shared/vibe-install.mjs";

export const REUSABLE = ["config.env", "standing-rulings.md", "lessons.md", "handover.md", "context-guard.json", "current", "programs"];
const PROGRAM_DIRS = ["sessions", "prompts", "requests", "findings", "evidence"];
const PROGRAM_FILES = ["resume-log.md", "rulings.md", "attention.md"];
/** The program files a new chat's reading list rereads, in reading order. */
export const PROGRAM_READING = Object.freeze(["rulings.md", "attention.md", "resume-log.md", "board.md"]);
export const Shape = Object.freeze({ NoWriter: "no-writer", OneWriter: "one-writer", Fleet: "fleet" });
const SHAPE_NOTES = Object.freeze({
  [Shape.NoWriter]: "nobody writes code; the resume log, rulings, research and evidence rules apply, the board, watcher, slots, QA and merge sections do not",
  [Shape.OneWriter]: "one writer, one PR; everything for that PR applies, the multi-writer board messaging, merge order, version-file and runtime-move rules do not",
  [Shape.Fleet]: "several writers; every section applies",
});
const PLUGIN_VERSION_SCRIPT = "skills/vibe/scripts/plugin-version.mjs";
export const FLEET_HOME_SCRIPT = "skills/fleet-orchestrator/scripts/fleet-home.mjs";

/** The fleet home of `chat` (default: the harness conversation running this command): FLEET_HOME, its bound home, else ~/fleet-orchestrator. */
export function defaultHome(env = process.env, chat = commandChat(env)) {
  return chatHome(chat, env);
}

/** `{ home, program, dir }` for the program `chat` resolves in `home`; throws the bind instruction when it has none. */
export function chatProgramDir(home, chat, env = process.env) {
  const resolved = programFor(home, chat, env);
  if (resolved.program) return { home: path.resolve(home), program: resolved.program, dir: path.join(path.resolve(home), "programs", resolved.program) };
  if (resolved.current) throw new Error(unboundLine(path.resolve(home), resolved, env));
  return resolveWorkDir(home, { env, chat });
}

/** Problems that put state outside the home or the program, as printable lines. */
export function homeProblems(dir) {
  const resolved = resolveWorkDir(dir);
  if (!resolved.home) return [`FLAT-LAYOUT ${resolved.dir}: migrate it into a fleet home with fleet-home.mjs migrate --from <dir> --program <slug>`];
  const problems = [];
  for (const name of readdirSync(resolved.home)) {
    if (!REUSABLE.includes(name) && !name.startsWith(".")) problems.push(`FLAT ${name}: program state belongs in programs/${resolved.program}/`);
  }
  problems.push(...outsideLinks(resolved.home, resolved.home));
  const homeConfig = readConfigFile(path.join(resolved.home, "config.env"));
  for (const key of PER_PROGRAM_KEYS) {
    if (homeConfig[key] !== undefined && !(key.startsWith("REMOTE_") && !homeConfig.REMOTE_FLEET_HOME)) {
      problems.push(`CONFIG ${key}: derived per program; remove it from config.env`);
    }
  }
  const config = { ...homeConfig, ...readConfigFile(path.join(resolved.dir, "config.env")) };
  if (config.REMOTE_STATE_DIR && !config.REMOTE_FLEET_HOME) {
    problems.push("SHARED-REMOTE REMOTE_STATE_DIR is shared by every program: set REMOTE_FLEET_HOME to the fleet home on REMOTE_HOST");
  }
  problems.push(...pendingRemoteMarkers(resolved.dir), ...unmanagedSessions(resolved.dir), ...unmanagedState(resolved.home), ...unmanagedState(resolved.dir));
  return problems;
}

function readConfigFile(file) {
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : {};
}

function outsideLinks(dir, home, depth = 0) {
  const problems = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(dir, readlinkSync(file));
      if (target !== home && !target.startsWith(`${home}${path.sep}`)) problems.push(`OUTSIDE ${path.relative(home, file)} -> ${target}`);
    } else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith(".")) {
      problems.push(...outsideLinks(file, home, depth + 1));
    }
  }
  return problems;
}

function unmanagedSessions(programDir) {
  const file = path.join(programDir, "sessions.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map((line) => line.trim().split(/\s+/)).filter((fields) => ["local", "remote"].includes(fields[0]) && fields[1])
    .filter(([where, name, threadId]) => threadId || (!existsSync(path.join(programDir, "sessions", where === "local" ? `${name}.json` : `${name}.remote.json`))
      && !(where === "remote" && (existsSync(path.join(programDir, "sessions", `${name}.remote.pending.json`))
        || existsSync(path.join(programDir, "sessions", `${name}.remote.pending`))))))
    .map(([where, name]) => `UNMANAGED ${where} ${name}: not started through fleet.sh; start its next turn with fleet.sh so its state lives in sessions/`);
}

/** Surface every prepared remote turn, even before sessions.txt names it, for exact recovery. */
function pendingRemoteMarkers(programDir) {
  const sessions = path.join(programDir, "sessions");
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions).flatMap((name) => {
    if (name.endsWith(".remote.pending.json")) {
      const writer = name.slice(0, -".remote.pending.json".length);
      return [`PENDING-REMOTE remote ${writer}: recover with fleet.sh <orchDir> remote session recover-marker ${writer}`];
    }
    if (name.endsWith(".remote.pending")) {
      const writer = name.slice(0, -".remote.pending".length);
      return [`PENDING-REMOTE-LEGACY remote ${writer}: preserve and audit this older prepared owner before another turn`];
    }
    return [];
  });
}

function unmanagedState(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).filter((name) => {
    try {
      return typeof JSON.parse(readFileSync(path.join(dir, name), "utf8")).threadId === "string";
    } catch {
      return false;
    }
  }).map((name) => `UNMANAGED-STATE ${path.join(dir, name)}: Codex thread state outside sessions/; start sessions with fleet.sh`);
}

/** The reading list a new chat follows; `chat` (default: this command's) picks its program in a home that runs several. */
export function resumeLines(home, { env = process.env, chat = commandChat(env) } = {}) {
  const lines = ["config.env", "standing-rulings.md", "lessons.md", "handover.md"].filter((name) => existsSync(path.join(home, name)))
    .map((name) => `READ ${path.join(home, name)}`);
  lines.push(...contextGuardLines(home));
  let resolved = { program: null };
  try {
    resolved = chatProgramDir(home, chat, env);
  } catch (error) {
    if (String(error?.message).startsWith("UNBOUND")) return [...lines, error.message, ...programLines(home, env)];
  }
  if (!resolved.program) return [...lines, `NO-ACTIVE-PROGRAM: start one with fleet-home.mjs start <slug>; it reads no earlier program's state`];
  lines.push(`ACTIVE ${resolved.program} ${resolved.dir}`, shapeLine(resolved.dir), pluginVersionLine(resolved.dir));
  for (const name of PROGRAM_READING) {
    if (existsSync(path.join(resolved.dir, name))) lines.push(`READ ${path.join(resolved.dir, name)}`);
  }
  lines.push(...relaunchLines(resolved.dir));
  const pid = Number(readOr(path.join(resolved.dir, "watch.lock", "pid"), "").trim());
  if (pid > 1 && alive(pid)) lines.push(`WATCHER-LIVE ${pid}: the previous chat still watches; stop its watcher there, then arm yours`);
  return lines;
}

/** `PROGRAM <slug> chat <id>|unbound` for each program in `home`, for a chat choosing one to bind. */
function programLines(home, env) {
  const programs = path.join(home, "programs");
  if (!existsSync(programs)) return [];
  return readdirSync(programs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().map((slug) => {
    const chats = programChats(home, slug, env);
    return `PROGRAM ${slug} ${chats.length > 0 ? `chat ${chats.join(",")}` : "unbound"}`;
  });
}

function relaunchLines(programDir) {
  let board;
  try {
    board = JSON.parse(readFileSync(path.join(programDir, "board.json"), "utf8"));
  } catch {
    return [];
  }
  const prompts = existsSync(path.join(programDir, "prompts")) ? readdirSync(path.join(programDir, "prompts")).sort() : [];
  return Object.entries(board.writers ?? {}).filter(([, row]) => row.runtime === "claude").map(([name]) => {
    const prompt = prompts.filter((file) => file.startsWith(`${name}-`)).at(-1);
    return prompt ? `RELAUNCH ${name} ${path.join(programDir, "prompts", prompt)}` : `RELAUNCH ${name} (no saved prompt in prompts/)`;
  });
}

function readOr(file, fallback) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The shape a program dir recorded, or null for one started before shapes. */
export function programShape(programDir) {
  try {
    const shape = JSON.parse(readFileSync(path.join(programDir, "program.json"), "utf8")).shape;
    return Object.values(Shape).includes(shape) ? shape : null;
  } catch {
    return null;
  }
}

/** Records a program's shape. */
export function setShape(programDir, shape) {
  requireShape(shape);
  writeFileSync(path.join(programDir, "program.json"), `${JSON.stringify({ shape }, null, 2)}\n`);
}

function requireShape(shape) {
  if (!Object.values(Shape).includes(shape)) throw new Error(`--shape must be one of ${Object.values(Shape).join(", ")}: decide whether anyone writes code, one writer, or several`);
}

function shapeLine(programDir) {
  const shape = programShape(programDir);
  return shape ? `SHAPE ${shape}: ${SHAPE_NOTES[shape]}` : `SHAPE-UNSET: record it with fleet-home.mjs shape ${Object.values(Shape).join("|")}`;
}

function pluginVersionLine(programDir) {
  const file = path.join(programDir, "plugin-version.json");
  const check = `node ${vibeScriptPath(PLUGIN_VERSION_SCRIPT)} check --state ${file}`;
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return `PLUGIN-VERSION-UNCHECKED: run \`${check}\` before starting any worker`;
  }
  if (record.status === "outdated" && !record.choice) {
    return `PLUGIN-VERSION-UNANSWERED ${record.versions}: ask the operator to update now or proceed knowing an outdated plugin could give worse results, and record it with plugin-version.mjs choose --state ${file}`;
  }
  const freshness = skillFreshnessProblem(record);
  if (freshness) return `PLUGIN-RELOAD-REQUIRED: ${freshness}`;
  return `PLUGIN-VERSION ${record.status}${record.choice ? ` ${record.choice.choice}` : ""} at ${record.checkedAt}: run \`${check}\` in every chat; in the same chat it keeps the recorded answer`;
}

/**
 * Creates programs/<slug>/ with its shape and binds `chat` to it: `{ dir, takenFrom }`. Refuses while the
 * program the chat resolves is open (its own, or `current` while no other chat holds it; with no chat,
 * `current`), as before bindings. The program becomes current only when the home has none.
 */
export function startProgram(home, slug, shape, { env = process.env, chat = commandChat(env), takeover = false } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new Error(`invalid program slug ${slug}`);
  requireShape(shape);
  const current = currentProgram(home);
  const open = chat ? programFor(home, chat, env).program : current;
  if (open && open !== slug) {
    const unbound = chat && !boundProgram(home, chat, env) ? `; if another chat runs ${open}, have it run fleet-home.mjs resume there so it is bound, then start ${slug} here` : "";
    throw new Error(`ACTIVE ${open}: close it with fleet-home.mjs close before starting ${slug}${unbound}`);
  }
  if (chat) refuseHeld(chat, home, slug, env, { takeover });
  const dir = path.join(home, "programs", slug);
  for (const sub of PROGRAM_DIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  for (const name of PROGRAM_FILES) if (!existsSync(path.join(dir, name))) writeFileSync(path.join(dir, name), "");
  setShape(dir, shape);
  if (!current || current === slug) writeFileSync(path.join(home, "current"), `${slug}\n`);
  return { dir, takenFrom: bindChat(chat, home, slug, env, { takeover }) };
}

/** The program `chat` is bound to in `home` when its dir still exists, else null. */
function boundProgram(home, chat, env) {
  const binding = chatBinding(chat, env);
  return binding && path.resolve(binding.home) === path.resolve(home) && existsSync(path.join(home, "programs", binding.program)) ? binding.program : null;
}

/** Unbinds `chat` from its program in `home` and clears `current` when it named that program; returns a line. */
export function closeProgram(home, { env = process.env, chat = commandChat(env) } = {}) {
  const own = boundProgram(home, chat, env);
  const current = currentProgram(home);
  if (own) unbindChat(chat, env);
  const others = current ? programChats(home, current, env).filter((other) => other !== chat) : [];
  const clear = own ? current === own : current !== null && others.length === 0;
  if (clear) unlinkSync(path.join(home, "current"));
  if (!own && others.length > 0) return `this chat has no program in ${home}; ${current} belongs to another chat (${others.join(", ")}) and stays current`;
  return own && current && !clear ? `closed ${own} for this chat; ${current} stays current in ${home}` : `no active program in ${home}`;
}

/** Binds `chat` to `slug` in `home` for `resume <slug>`; returns the TAKEOVER and BOUND lines. Another chat's program needs `takeover`. */
function resumeProgram(home, slug, chat, env, takeover) {
  if (!existsSync(path.join(home, "programs", slug))) throw new Error(`no program ${slug} in ${home}: start it with fleet-home.mjs start ${slug} --shape no-writer|one-writer|fleet`);
  const taken = chat ? bindChat(chat, home, slug, env, { takeover }) : [];
  if (!currentProgram(home)) writeFileSync(path.join(home, "current"), `${slug}\n`);
  if (!chat) return [`NO-CHAT: this command runs outside Claude Code and Codex, so no chat is bound; ${slug} resolves only as current or through its program dir`];
  return [...taken.map((other) => `TAKEOVER ${other}: that chat ran ${slug}; if it is still open, stop it there so only this chat writes the program`), `BOUND ${slug} ${chat}`];
}

/** The compaction limits file, read by vibe's PostToolUse and PreCompact hooks on every call. */
const CONTEXT_GUARD_FILE = "context-guard.json";
const CONTEXT_GUARD_DEFAULTS = Object.freeze({ enabled: true, compactWindowTokens: 300_000, flushAtPercent: 85 });
// Claude Code accepts an auto-compact window from 100k to 1M tokens.
export const COMPACT_WINDOW_RANGE = Object.freeze([100_000, 1_000_000]);

/** The limits: the defaults overlaid by `<home>/context-guard.json`; throws on a malformed file. */
export function contextGuardConfig(home) {
  const file = path.join(home, CONTEXT_GUARD_FILE);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
  const config = { ...CONTEXT_GUARD_DEFAULTS, ...raw };
  if (typeof config.enabled !== "boolean") throw new Error("enabled must be true or false");
  const [min, max] = COMPACT_WINDOW_RANGE;
  if (!Number.isInteger(config.compactWindowTokens) || config.compactWindowTokens < min || config.compactWindowTokens > max) {
    throw new Error(`compactWindowTokens must be a whole number from ${min} to ${max}`);
  }
  if (typeof config.flushAtPercent !== "number" || !(config.flushAtPercent > 0 && config.flushAtPercent < 100)) {
    throw new Error("flushAtPercent must be a number between 0 and 100");
  }
  return { ...config, file };
}

/** Writes the default context-guard.json into `home` when it has none, so the operator has a file to edit. */
function seedContextGuardConfig(home) {
  const file = path.join(home, CONTEXT_GUARD_FILE);
  if (existsSync(file)) return;
  const seed = {
    _comment: "Edit freely; vibe rereads this on every call. compactWindowTokens is the CLAUDE_CODE_AUTO_COMPACT_WINDOW a fleet-orchestrator chat should be launched with. At flushAtPercent of that window the chat is told to bring its program state files current before Claude Code compacts it.",
    ...CONTEXT_GUARD_DEFAULTS,
  };
  writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, { flag: "wx" });
}

/** Seeds context-guard.json for `resume`; a failed write is reported, never a reason to drop the reading list. */
function seedLines(home) {
  if (!existsSync(home)) return [];
  try {
    seedContextGuardConfig(home);
    return [];
  } catch (error) {
    if (error?.code === "EEXIST") return [];
    const reason = error instanceof Error ? error.message : String(error);
    return [`CONTEXT-GUARD-UNSEEDED ${path.join(home, CONTEXT_GUARD_FILE)}: ${reason}; the guard runs on its defaults`];
  }
}

function contextGuardLines(home) {
  try {
    contextGuardConfig(home);
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`CONTEXT-GUARD-INVALID ${path.join(home, CONTEXT_GUARD_FILE)}: ${reason}; the context guard stays silent until it is fixed`];
  }
}

const LAUNCHER_NAME = "fleet-claude";
const LAUNCHER_MARK = "# Written by vibe fleet-home.mjs launcher (ISS-14028).";

/** The `fleet-claude` script: Claude Code with `home`'s compaction window (FLEET_HOME overrides it), every argument passed through. */
export function launcherScript(home) {
  const [min, max] = COMPACT_WINDOW_RANGE;
  const fallback = CONTEXT_GUARD_DEFAULTS.compactWindowTokens;
  const read = `try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).compactWindowTokens;process.stdout.write(String(Number.isInteger(v)&&v>=${min}&&v<=${max}?v:${fallback}))}catch{process.stdout.write("${fallback}")}`;
  return [
    "#!/bin/sh",
    LAUNCHER_MARK,
    "# Starts Claude Code for a fleet-orchestrator chat with CLAUDE_CODE_AUTO_COMPACT_WINDOW, which Claude Code",
    "# reads only at launch, set to compactWindowTokens in the fleet home's context-guard.json",
    "# (FLEET_HOME, else the home it was installed for). A window already set in the environment wins.",
    "# Every argument goes to claude: fleet-claude, fleet-claude --resume <id>.",
    `installed_home='${String(path.resolve(home)).replaceAll("'", "'\\''")}'`,
    'home="${FLEET_HOME:-$installed_home}"',
    `window=$(node -e '${read}' "$home/context-guard.json" 2>/dev/null) || window=${fallback}`,
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-${window:-' + fallback + '}}" exec claude "$@"',
    "",
  ].join("\n");
}

/** `launcher`: the launch command, or (--install) writes `fleet-claude` into `bin`; refuses a file it did not write. */
export function launcherLines(home, { install = false, bin, env = process.env } = {}) {
  const window = (() => {
    try {
      return contextGuardConfig(home).compactWindowTokens;
    } catch {
      return CONTEXT_GUARD_DEFAULTS.compactWindowTokens;
    }
  })();
  const dir = path.resolve(bin ?? path.join(env.HOME || os.homedir(), ".local", "bin"));
  const file = path.join(dir, LAUNCHER_NAME);
  if (!install) {
    return [
      `LAUNCH CLAUDE_CODE_AUTO_COMPACT_WINDOW=${window} claude`,
      `INSTALL node ${vibeScriptPath(FLEET_HOME_SCRIPT)} launcher --install puts it in ${file}; start every orchestrator chat with ${LAUNCHER_NAME} (any claude arguments pass through)`,
    ];
  }
  if (existsSync(file) && !readOr(file, "").includes(LAUNCHER_MARK)) throw new Error(`${file} exists and was not written by fleet-home.mjs launcher: move it aside or pass --bin <dir>`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, launcherScript(home), { mode: 0o755 });
  chmodSync(file, 0o755);
  const onPath = String(env.PATH ?? "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir);
  return [`INSTALLED ${file}: start every orchestrator chat with ${LAUNCHER_NAME} (any claude arguments pass through)`,
    ...(onPath ? [] : [`NOT-ON-PATH ${dir}: add it to PATH, or run ${file} by its full path`])];
}

function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    home: { type: "string" }, from: { type: "string" }, program: { type: "string" }, shape: { type: "string" }, "dry-run": { type: "boolean" },
    install: { type: "boolean" }, bin: { type: "string" }, takeover: { type: "boolean" },
  } });
  const chat = commandChat(env);
  const home = values.home ? path.resolve(values.home) : defaultHome(env, chat);
  const print = (lines) => process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  if (command === "start") {
    if (!positionals[0]) throw new Error("Usage: fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet [--home <fleetHome>]");
    const { dir, takenFrom } = startProgram(home, positionals[0], values.shape, { env, chat, takeover: values.takeover });
    print([`started ${dir}`, shapeLine(dir), ...takenFrom.map((other) => `TAKEOVER ${other}: that chat ran ${positionals[0]}; if it is still open, stop it there`),
      ...(chat ? [`BOUND ${positionals[0]} ${chat}`] : [])]);
    return 0;
  }
  if (command === "shape") {
    const dir = chatProgramDir(home, chat, env).dir;
    setShape(dir, positionals[0]);
    print([shapeLine(dir)]);
    return 0;
  }
  if (command === "close") {
    print([closeProgram(home, { env, chat })]);
    return 0;
  }
  if (command === "resume") {
    const seeded = seedLines(home);
    const bound = positionals[0] ? resumeProgram(home, positionals[0], chat, env, values.takeover) : bindCurrent(home, chat, env);
    print([...seeded, ...bound, ...resumeLines(home, { env, chat })]);
    return 0;
  }
  if (command === "check") {
    let dir = home;
    try {
      if (existsSync(path.join(home, "programs"))) dir = chatProgramDir(home, chat, env).dir;
    } catch (error) {
      if (String(error?.message).startsWith("UNBOUND")) {
        print([error.message]);
        return 1;
      }
    }
    const problems = homeProblems(dir);
    print(problems.length > 0 ? problems : [`fleet-home: ok ${resolveWorkDir(dir, { env, chat }).dir}`]);
    return problems.length > 0 ? 1 : 0;
  }
  if (command === "migrate") {
    if (!values.from || !values.program) throw new Error("Usage: fleet-home.mjs migrate --from <flat work dir> --program <slug> [--home <fleetHome>] [--dry-run]");
    const fromDir = path.resolve(values.from);
    const pid = Number(readOr(path.join(fromDir, "watch.lock", "pid"), "").trim());
    if (pid > 1 && alive(pid)) throw new Error(`WATCHER-LIVE ${pid}: stop the watcher for ${fromDir} first`);
    const { lines, refused } = migrate(fromDir, values.home ? home : fromDir, values.program, {
      dryRun: values["dry-run"], reusable: REUSABLE, skip: ["programs", "current"], programDirs: PROGRAM_DIRS, chat, takeover: values.takeover, env,
    });
    print(lines);
    return refused ? 1 : 0;
  }
  if (command === "launcher") {
    print(launcherLines(home, { install: values.install, bin: values.bin, env }));
    return 0;
  }
  throw new Error("Usage: fleet-home.mjs start|shape|close|resume|check|migrate|launcher ...");
}

/** For a plain `resume`: binds `chat` to the home's current program when no other chat holds it. */
function bindCurrent(home, chat, env) {
  if (!chat || !existsSync(path.join(home, "programs"))) return [];
  const resolved = programFor(home, chat, env);
  if (resolved.source !== "current") return [];
  bindChat(chat, home, resolved.program, env);
  return [`BOUND ${resolved.program} ${chat}`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
