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
//   <fleetHome>/current                                                   the active program's slug
//   <fleetHome>/programs/<slug>/                                          that program's state
//
// Usage: fleet-home.mjs start <slug> [--home <fleetHome>]
//        fleet-home.mjs close [--home <fleetHome>]
//        fleet-home.mjs resume [--home <fleetHome>]
//        fleet-home.mjs check [--home <fleetHome or program dir>]
//        fleet-home.mjs migrate --from <flat work dir> --program <slug> [--home <fleetHome, default --from>] [--dry-run]
//
// --home defaults to FLEET_HOME, else ~/fleet-orchestrator.
// `start` creates programs/<slug>/ and makes it current; it refuses while
// another program is current, so a new program never reads an older one's
// state. `close` clears `current`.
// `resume` prints what a new chat reads, in order: the reusable files, then
// `ACTIVE <slug>` and the program's files, `RELAUNCH <writer> <prompt>` for
// each Claude writer on the board (its newest prompts/<writer>-*.md) and
// `WATCHER-LIVE <pid>` while another chat's watcher holds the lock; or
// `NO-ACTIVE-PROGRAM`.
// `check` prints, and exits 1 on, state outside the home or the program:
// `FLAT <name>` (program state at the home's top), `OUTSIDE <link> -> <target>`
// (a symlink in the home resolving outside it), `CONFIG <key>` (a per-program
// key in the home's config.env), `SHARED-REMOTE` (REMOTE_STATE_DIR without
// REMOTE_FLEET_HOME, shared by every program), `UNMANAGED <where> <name>` (a
// sessions.txt session with no state file fleet.sh wrote) and
// `UNMANAGED-STATE <file>` (Codex thread state outside sessions/). Given a
// flat work dir it prints `FLAT-LAYOUT`. board.mjs status prints the same lines.
// `migrate` turns a flat work dir into a home in place (or moves it to
// --home): the reusable files stay at the top, everything else moves to
// programs/<slug>/, a LOCAL_STATE_DIR or REQUESTS_DIR inside it becomes the
// program's sessions/ or requests/, those keys are commented out of
// config.env, and symlinks beside the old dir that pointed at a moved file
// are repointed. It refuses while a watcher holds the lock. rulings.md moves
// with the program: copy its standing rulings into standing-rulings.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PER_PROGRAM_KEYS, parseConfig, resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

export const REUSABLE = ["config.env", "standing-rulings.md", "lessons.md", "handover.md", "current", "programs"];
const PROGRAM_DIRS = ["sessions", "prompts", "requests", "findings", "evidence"];
const PROGRAM_FILES = ["resume-log.md", "rulings.md", "attention.md"];

/** The fleet home: --home, FLEET_HOME, else ~/fleet-orchestrator. */
export function defaultHome(env = process.env) {
  return path.resolve(env.FLEET_HOME || path.join(os.homedir(), "fleet-orchestrator"));
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
  problems.push(...unmanagedSessions(resolved.dir), ...unmanagedState(resolved.home), ...unmanagedState(resolved.dir));
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
    .filter(([where, name, threadId]) => threadId || !existsSync(path.join(programDir, "sessions", where === "local" ? `${name}.json` : `${name}.remote.json`)))
    .map(([where, name]) => `UNMANAGED ${where} ${name}: not started through fleet.sh; start its next turn with fleet.sh so its state lives in sessions/`);
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

/** The reading list a new chat follows. */
export function resumeLines(home) {
  const lines = ["config.env", "standing-rulings.md", "lessons.md", "handover.md"].filter((name) => existsSync(path.join(home, name)))
    .map((name) => `READ ${path.join(home, name)}`);
  let resolved = { program: null };
  try {
    resolved = resolveWorkDir(home);
  } catch {}
  if (!resolved.program) return [...lines, `NO-ACTIVE-PROGRAM: start one with fleet-home.mjs start <slug>; it reads no earlier program's state`];
  lines.push(`ACTIVE ${resolved.program} ${resolved.dir}`);
  for (const name of ["rulings.md", "attention.md", "resume-log.md", "board.md"]) {
    if (existsSync(path.join(resolved.dir, name))) lines.push(`READ ${path.join(resolved.dir, name)}`);
  }
  lines.push(...relaunchLines(resolved.dir));
  const pid = Number(readOr(path.join(resolved.dir, "watch.lock", "pid"), "").trim());
  if (pid > 1 && alive(pid)) lines.push(`WATCHER-LIVE ${pid}: the previous chat still watches; stop its watcher there, then arm yours`);
  return lines;
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

/** Creates programs/<slug>/ and makes it current; refuses while another program is current. */
export function startProgram(home, slug) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new Error(`invalid program slug ${slug}`);
  const current = readOr(path.join(home, "current"), "").trim();
  if (current && current !== slug && existsSync(path.join(home, "programs", current))) {
    throw new Error(`ACTIVE ${current}: close it with fleet-home.mjs close before starting ${slug}`);
  }
  const dir = path.join(home, "programs", slug);
  for (const sub of PROGRAM_DIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  for (const name of PROGRAM_FILES) if (!existsSync(path.join(dir, name))) writeFileSync(path.join(dir, name), "");
  writeFileSync(path.join(home, "current"), `${slug}\n`);
  return dir;
}

/** The moves that turn a flat work dir into a fleet home: `{ moves, configLines, notes }`. */
export function migrationPlan(from, home, slug) {
  const program = path.join(home, "programs", slug);
  const config = readConfigFile(path.join(from, "config.env"));
  const renamed = {};
  for (const [key, sub] of [["LOCAL_STATE_DIR", "sessions"], ["REQUESTS_DIR", "requests"]]) {
    const value = config[key] && path.resolve(config[key]);
    if (value && value.startsWith(`${path.resolve(from)}${path.sep}`) && path.dirname(value) === path.resolve(from)) renamed[path.basename(value)] = sub;
  }
  const moves = [];
  for (const name of readdirSync(from)) {
    if (name === "programs" || name === "current" || name.startsWith(".")) continue;
    if (REUSABLE.includes(name)) {
      if (path.resolve(from) !== path.resolve(home)) moves.push([path.join(from, name), path.join(home, name)]);
      continue;
    }
    moves.push([path.join(from, name), path.join(program, renamed[name] ?? name)]);
  }
  const notes = [];
  if (existsSync(path.join(from, "rulings.md"))) notes.push(`SPLIT-RULINGS copy the rulings that bind every program from ${path.join(program, "rulings.md")} into ${path.join(home, "standing-rulings.md")}`);
  if (config.REMOTE_STATE_DIR && !config.REMOTE_FLEET_HOME) notes.push("SHARED-REMOTE keep REMOTE_STATE_DIR until this program's remote sessions finish, then set REMOTE_FLEET_HOME");
  const configLines = ["LOCAL_STATE_DIR", "REQUESTS_DIR"].filter((key) => config[key] !== undefined);
  return { program, moves, configLines, notes };
}

function migrate(from, home, slug, dryRun) {
  const fromDir = path.resolve(from);
  const pid = Number(readOr(path.join(fromDir, "watch.lock", "pid"), "").trim());
  if (pid > 1 && alive(pid)) throw new Error(`WATCHER-LIVE ${pid}: stop the watcher for ${fromDir} first`);
  const plan = migrationPlan(fromDir, home, slug);
  const lines = plan.moves.map(([source, target]) => `MOVE ${source} -> ${target}`);
  lines.push(...plan.configLines.map((key) => `CONFIG comment out ${key} (derived per program)`), ...plan.notes);
  const relinks = siblingLinks(fromDir, plan.moves);
  lines.push(...relinks.map(([link, target]) => `RELINK ${link} -> ${target}`));
  if (dryRun) return lines;
  mkdirSync(plan.program, { recursive: true });
  for (const [source, target] of plan.moves) renameSync(source, target);
  for (const sub of PROGRAM_DIRS) mkdirSync(path.join(plan.program, sub), { recursive: true });
  const configFile = path.join(home, "config.env");
  if (existsSync(configFile) && plan.configLines.length > 0) {
    const pattern = new RegExp(`^(\\s*(?:export\\s+)?(?:${plan.configLines.join("|")})=)`, "gm");
    writeFileSync(configFile, readFileSync(configFile, "utf8").replace(pattern, "# derived per program since vibe 1.0.78: $1"));
  }
  const inside = movedLinks(home, plan.moves, 4);
  for (const [link, target] of [...relinks, ...inside]) {
    unlinkSync(link);
    symlinkSync(target, link);
  }
  lines.push(...inside.map(([link, target]) => `RELINK ${link} -> ${target}`));
  writeFileSync(path.join(home, "current"), `${slug}\n`);
  return lines;
}

/** Symlinks beside `fromDir` whose target was moved, with the target's new path. */
function siblingLinks(fromDir, moves) {
  return movedLinks(path.dirname(fromDir), moves, 0);
}

/** Symlinks under `dir` (to `depth` levels) whose absolute target was moved, with the target's new path. */
function movedLinks(dir, moves, depth) {
  const links = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const link = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) links.push(...movedLinks(link, moves, depth - 1));
    if (!entry.isSymbolicLink()) continue;
    const target = path.resolve(dir, readlinkSync(link));
    const move = moves.find(([source]) => target === source || target.startsWith(`${source}${path.sep}`));
    if (move) links.push([link, move[1] + target.slice(move[0].length)]);
  }
  return links;
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    home: { type: "string" }, from: { type: "string" }, program: { type: "string" }, "dry-run": { type: "boolean" },
  } });
  const home = values.home ? path.resolve(values.home) : defaultHome();
  const print = (lines) => process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  if (command === "start") {
    if (!positionals[0]) throw new Error("Usage: fleet-home.mjs start <slug> [--home <fleetHome>]");
    print([`started ${startProgram(home, positionals[0])}`]);
    return 0;
  }
  if (command === "close") {
    if (existsSync(path.join(home, "current"))) unlinkSync(path.join(home, "current"));
    print([`no active program in ${home}`]);
    return 0;
  }
  if (command === "resume") {
    print(resumeLines(home));
    return 0;
  }
  if (command === "check") {
    const problems = homeProblems(home);
    print(problems.length > 0 ? problems : [`fleet-home: ok ${resolveWorkDir(home).dir}`]);
    return problems.length > 0 ? 1 : 0;
  }
  if (command === "migrate") {
    if (!values.from || !values.program) throw new Error("Usage: fleet-home.mjs migrate --from <flat work dir> --program <slug> [--home <fleetHome>] [--dry-run]");
    const target = values.home ? home : path.resolve(values.from);
    print(migrate(values.from, target, values.program, values["dry-run"]));
    return 0;
  }
  throw new Error("Usage: fleet-home.mjs start|close|resume|check|migrate ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
