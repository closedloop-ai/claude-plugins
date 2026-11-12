// `fleet-home.mjs migrate`: turns a flat work dir into a fleet home in place, or
// moves it into another home (--home). The reusable files stay at (or move to)
// the home's top, everything else moves to programs/<slug>/, a LOCAL_STATE_DIR
// or REQUESTS_DIR inside it becomes the program's sessions/ or requests/, those
// keys are commented out of config.env, and symlinks beside the old dir or
// inside the moved state that pointed at a moved file are repointed.
//
// ISS-14024: a flat dir whose LOCAL_STATE_DIR and own sessions/ both planned
// to programs/<slug>/sessions threw ENOTEMPTY on the second move and left the
// tree half moved, with no relinks and no `current`; and with --home pointing
// at an existing home, config.env and lessons.md were renamed over the home's
// copies. So the plan names every collision (two sources for one target, a
// target that already exists) and both the dry run and the real run refuse
// before moving anything; an existing programs/<slug> in another home is a
// collision too. In an existing home the append-only files (lessons.md,
// standing-rulings.md) MERGE when every entry is one line (the source's lines
// the home lacks are appended), an identical file is SAME, and any other
// differing file is a COLLISION. The real run journals each step and, on any failure, undoes the
// completed ones in reverse (ROLLED-BACK), so it never ends half moved.
// `current` is written only when the home has no current program or already
// names this one; the calling chat is bound to the migrated program as the
// journal's last step, and a rollback puts its earlier binding, the claims and
// any chat it took over back as they were.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { bindChat, captureBinding, currentProgram, refuseHeld, restoreBinding } from "./chat-binding.mjs";

/** Reusable files that hold one entry per line and only ever grow, so two copies merge by appending. */
const APPEND_ONLY = Object.freeze(["lessons.md", "standing-rulings.md"]);
// A line that is a whole entry on its own: blank, a heading, a list item, or a lessons.md row (state.md, "Lessons ledger").
const ENTRY_LINE = /^(?:\s*$|#|- |\d{4}-\d{2}-\d{2} \|)/;

/**
 * The steps that turn `from` into (or move it into) the home: `{ program, moves, merges, same, collisions,
 * configLines, notes }`. `reusable` names the files that stay at the home's top; `skip` the ones never moved.
 */
export function migrationPlan(from, home, slug, { reusable, skip }) {
  const fromDir = path.resolve(from);
  const homeDir = path.resolve(home);
  const program = path.join(homeDir, "programs", slug);
  const config = readConfigFile(path.join(fromDir, "config.env"));
  const renamed = {};
  for (const [key, sub] of [["LOCAL_STATE_DIR", "sessions"], ["REQUESTS_DIR", "requests"]]) {
    const value = config[key] && path.resolve(config[key]);
    if (value && path.dirname(value) === fromDir) renamed[path.basename(value)] = sub;
  }
  const moves = [];
  const merges = [];
  const same = [];
  const collisions = [];
  for (const name of readdirSync(fromDir).sort()) {
    if (skip.includes(name) || name.startsWith(".")) continue;
    const source = path.join(fromDir, name);
    if (!reusable.includes(name)) {
      moves.push([source, path.join(program, renamed[name] ?? name)]);
      continue;
    }
    if (fromDir === homeDir) continue;
    const target = path.join(homeDir, name);
    if (!present(target)) moves.push([source, target]);
    else if (sameFile(source, target)) same.push([source, target]);
    else if (APPEND_ONLY.includes(name) && isFile(source) && isFile(target) && oneLineEntries(source) && oneLineEntries(target)) merges.push([source, target]);
    else if (APPEND_ONLY.includes(name)) collisions.push(`COLLISION ${target} already exists and differs from ${source}, and an entry spans several lines, so the lines cannot be merged one by one: merge them by hand, then run migrate again`);
    else collisions.push(`COLLISION ${target} already exists and differs from ${source}: merge them by hand or remove one, then run migrate again`);
  }
  if (fromDir !== homeDir && present(program)) {
    collisions.push(`COLLISION ${program} already exists: migrate into a new program slug, or move that program aside, then run migrate again`);
  }
  const byTarget = new Map();
  for (const [source, target] of moves) byTarget.set(target, [...(byTarget.get(target) ?? []), source]);
  for (const [target, sources] of byTarget) {
    if (sources.length > 1) collisions.push(`COLLISION ${target} is the target of ${sources.join(" and ")}: move or merge all but one of them by hand, then run migrate again`);
    else if (present(target)) collisions.push(`COLLISION ${target} already exists (planned for ${sources[0]}): move it aside or merge it by hand, then run migrate again`);
  }
  const notes = [];
  if (existsSync(path.join(fromDir, "rulings.md"))) notes.push(`SPLIT-RULINGS copy the rulings that bind every program from ${path.join(program, "rulings.md")} into ${path.join(homeDir, "standing-rulings.md")}`);
  if (config.REMOTE_STATE_DIR && !config.REMOTE_FLEET_HOME) notes.push("SHARED-REMOTE keep REMOTE_STATE_DIR until this program's remote sessions finish, then set REMOTE_FLEET_HOME");
  const configLines = ["LOCAL_STATE_DIR", "REQUESTS_DIR"].filter((key) => config[key] !== undefined);
  return { program, moves, merges, same, collisions, configLines, notes };
}

/**
 * Runs (or with `dryRun` prints) the migration: `{ lines, refused }`. `programDirs` are created in the
 * program; `chat` is bound to it; `ops.rename` and `ops.bind` replace renameSync and bindChat (tests inject failures there).
 */
export function migrate(from, home, slug, { dryRun = false, reusable, skip, programDirs, chat = null, takeover = false, env = process.env, ops = {} }) {
  const rename = ops.rename ?? renameSync;
  const bind = ops.bind ?? bindChat;
  const fromDir = path.resolve(from);
  const homeDir = path.resolve(home);
  const plan = migrationPlan(fromDir, homeDir, slug, { reusable, skip });
  const lines = [
    ...plan.moves.map(([source, target]) => `MOVE ${source} -> ${target}`),
    ...plan.merges.map(([source, target]) => `MERGE ${source} -> ${target} (${newLines(source, target).length} lines the home lacks are appended)`),
    ...plan.same.map(([source, target]) => `SAME ${source} = ${target} (the home keeps its copy)`),
    ...plan.configLines.map((key) => `CONFIG comment out ${key} (derived per program)`),
    ...plan.notes,
  ];
  const relinks = movedLinks(path.dirname(fromDir), plan.moves, 0);
  lines.push(...relinks.map(([link, target]) => `RELINK ${link} -> ${target}`));
  const current = currentProgram(homeDir);
  const keepCurrent = current !== null && current !== slug;
  lines.push(keepCurrent
    ? `CURRENT kept ${current}: ${homeDir} already runs it; resume ${slug} with fleet-home.mjs resume ${slug} in the chat that runs it`
    : `CURRENT ${slug}`);
  const held = heldRefusal(chat, homeDir, slug, env, takeover);
  if (held) plan.collisions.push(held);
  if (plan.collisions.length > 0) return { lines: [...lines, ...plan.collisions, `REFUSED: nothing was moved; fix every COLLISION or HELD line above and run migrate again`], refused: true };
  if (dryRun) return { lines, refused: false };

  const undo = [];
  try {
    makeDir(plan.program, undo);
    for (const [source, target] of plan.moves) {
      rename(source, target);
      undo.push(() => renameSync(target, source));
    }
    for (const [source, target] of plan.merges) {
      const before = readFileSync(target, "utf8");
      const added = newLines(source, target);
      writeFileSync(target, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${added.map((line) => `${line}\n`).join("")}`);
      undo.push(() => writeFileSync(target, before));
      removeFile(source, undo);
    }
    for (const [source] of plan.same) removeFile(source, undo);
    for (const sub of programDirs) makeDir(path.join(plan.program, sub), undo);
    const configFile = path.join(homeDir, "config.env");
    if (existsSync(configFile) && plan.configLines.length > 0) {
      const before = readFileSync(configFile, "utf8");
      const pattern = new RegExp(`^(\\s*(?:export\\s+)?(?:${plan.configLines.join("|")})=)`, "gm");
      writeFileSync(configFile, before.replace(pattern, "# derived per program since vibe 1.0.78: $1"));
      undo.push(() => writeFileSync(configFile, before));
    }
    const inside = movedLinks(homeDir, plan.moves, 4);
    for (const [link, target] of [...relinks, ...inside]) {
      const before = readlinkSync(link);
      undo.push(() => {
        if (present(link)) unlinkSync(link);
        symlinkSync(before, link);
      });
      unlinkSync(link);
      symlinkSync(target, link);
    }
    lines.push(...inside.map(([link, target]) => `RELINK ${link} -> ${target}`));
    if (!keepCurrent) {
      const currentFile = path.join(homeDir, "current");
      const before = present(currentFile) ? readFileSync(currentFile, "utf8") : null;
      writeFileSync(currentFile, `${slug}\n`);
      undo.push(() => (before === null ? unlinkSync(currentFile) : writeFileSync(currentFile, before)));
    }
    if (chat) {
      const before = captureBinding(chat, homeDir, slug, env);
      undo.push(() => restoreBinding(before, env));
      bind(chat, homeDir, slug, env, { takeover });
    }
  } catch (error) {
    const failed = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (undoError) {
        failed.push(undoError instanceof Error ? undoError.message : String(undoError));
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(failed.length === 0
      ? `ROLLED-BACK migrate stopped (${reason}); every completed step was undone and ${fromDir} is as it was`
      : `ROLLBACK-INCOMPLETE migrate stopped (${reason}) and ${failed.length} undo steps failed: ${failed.join("; ")}`);
  }
  return { lines, refused: false };
}

/** Whether every line of `file` is a whole entry, so its entries can be merged line by line. */
function oneLineEntries(file) {
  return readFileSync(file, "utf8").split("\n").every((line) => ENTRY_LINE.test(line));
}

/** The HELD refusal when another chat holds `slug` in `home` and `takeover` is not set, else null. */
function heldRefusal(chat, home, slug, env, takeover) {
  if (!chat) return null;
  try {
    refuseHeld(chat, home, slug, env, { takeover });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Deletes `file` with an undo step that writes its bytes and mode back. */
function removeFile(file, undo) {
  const bytes = readFileSync(file);
  const { mode } = lstatSync(file);
  undo.push(() => {
    writeFileSync(file, bytes);
    chmodSync(file, mode & 0o7777);
  });
  unlinkSync(file);
}

/** The non-blank lines of `source` that `target` does not already hold, in order. */
function newLines(source, target) {
  const have = new Set(readFileSync(target, "utf8").split("\n"));
  const seen = new Set();
  return readFileSync(source, "utf8").split("\n").filter((line) => {
    if (line.trim() === "" || have.has(line) || seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function makeDir(dir, undo) {
  const missing = [];
  for (let at = dir; !present(at); at = path.dirname(at)) missing.unshift(at);
  if (missing.length === 0) return;
  mkdirSync(dir, { recursive: true });
  undo.push(() => {
    for (const created of missing.reverse()) rmdirSync(created);
  });
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

function readConfigFile(file) {
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : {};
}

/** Whether anything, a dangling symlink included, sits at `file`. */
function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function sameFile(a, b) {
  return isFile(a) && isFile(b) && readFileSync(a).equals(readFileSync(b));
}
