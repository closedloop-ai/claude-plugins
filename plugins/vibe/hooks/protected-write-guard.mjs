#!/usr/bin/env node
// Writer-only Claude hook. It intentionally does not use the plugin-wide hook dispatcher:
// a thrown guard must reach Claude Code's onFailure: block policy.
// command-segments.mjs drops words containing < or >, which erases heredoc
// markers needed here; this narrow splitter retains them without importing the dispatcher.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const protectedDirectories = new Set([
  ".git", ".claude", ".vscode", ".idea", ".husky", ".cargo",
  ".devcontainer", ".yarn", ".mvn",
]);
const protectedFiles = new Set([
  ".gitconfig", ".gitmodules", ".mcp.json", ".claude.json", ".npmrc",
  ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs",
  ".envrc", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml",
]);
const writers = new Set(["python", "python3", "node"]);
const destinationWriters = new Set(["cp", "mv", "install", "rsync", "ln"]);
const wrappers = new Set(["env", "command", "exec", "sudo", "nohup"]);
const pythonOpen = /\bopen\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])[wax+][^'"`]*\3/g;
const pythonPath = /\bPath\s*\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/g;
const nodeWrite = /\b(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile)\s*\(\s*(['"`])([^'"`]+)\1/g;
const nodeSecond = /\b(?:copyFileSync|renameSync|copyFile|rename)\s*\(\s*(['"`])[^'"`]+\1\s*,\s*(['"`])([^'"`]+)\2/g;
const gitDirectoryCache = new Map();

/** Segment-aware membership in a canonical directory. */
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve a missing target through its nearest existing ancestor, preserving symlink checks. */
function targetPaths(root, cwd, raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw new Error("invalid target");
  const lexical = path.resolve(cwd, raw);
  let ancestor = lexical;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("target has no existing ancestor");
    ancestor = parent;
  }
  const effective = path.resolve(realpathSync(ancestor), path.relative(ancestor, lexical));
  const realRoot = realpathSync(root);
  const admitted = [".claude/skills", ".claude/commands"].some((part) =>
    inside(path.join(root, part), lexical) && inside(path.join(realRoot, part), effective));
  return { lexical, effective, admitted };
}

/** Match the one private change log owned by this exact linked worktree. */
function isOwnChangeLog(root, target) {
  try {
    let gitDir = gitDirectoryCache.get(root);
    if (!gitDir) {
      gitDir = path.resolve(execFileSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim());
      gitDirectoryCache.set(root, gitDir);
    }
    const lexical = path.join(gitDir, "vibe-changes.md");
    const effective = path.join(realpathSync(gitDir), "vibe-changes.md");
    if (target.lexical !== lexical || target.effective !== effective) return false;
    try {
      if (!lstatSync(target.lexical).isFile()) return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function protectedPath(root, target) {
  // A vibe worktree itself may live below a parent checkout's .claude/worktrees.
  // Strip that trusted prefix for local targets, but still recognize protected
  // directories reached outside the worktree through an absolute path or symlink.
  const parts = (inside(root, target) ? path.relative(root, target) : target).split(path.sep);
  return parts.some((part, index) => protectedDirectories.has(part)
    || protectedFiles.has(part) || (part === "git" && parts[index - 1] === ".config"));
}

function protectedWrite(root, cwd, raw, { allowOwnChangeLog = true } = {}) {
  const target = targetPaths(root, cwd, raw);
  if (allowOwnChangeLog && isOwnChangeLog(root, target)) return false;
  return protectedPath(root, target.lexical) || protectedPath(realpathSync(root), target.effective);
}

/** Shell words and command boundaries, retaining quoted interpreter payloads as one word. */
function shellCommands(command) {
  const commands = [];
  let words = [];
  let word = "";
  let quote = "";
  let started = false;
  const finishWord = () => { if (started) words.push(word); word = ""; started = false; };
  const finishCommand = () => { finishWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\" && index + 1 < command.length) { word += command[++index]; started = true; }
    else if (/\s/.test(char)) {
      if (char === "\n") finishCommand(); else finishWord();
    } else if (";|&".includes(char)) finishCommand();
    else { word += char; started = true; }
  }
  finishCommand();
  return commands;
}

function programWords(words) {
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])
    || wrappers.has(path.basename(words[index])))) {
    if (words[index] === "env" && words[index + 1]?.startsWith("-")) index += 1;
    index += 1;
  }
  return words.slice(index);
}

function scriptTargets(script) {
  const targets = [];
  for (const pattern of [pythonOpen, pythonPath, nodeWrite, nodeSecond]) {
    pattern.lastIndex = 0;
    for (const match of script.matchAll(pattern)) targets.push(pattern === nodeSecond ? match[3] : match[2]);
  }
  return targets.filter((value) => typeof value === "string");
}

function bashProtectedWrite(root, cwd, command) {
  const commands = shellCommands(command);
  const protectedReason = "shell write to a protected target refused";
  const unresolvedReason = "shell write after unresolved cd refused";
  const heredocWriter = commands.some((words) => {
    const [program, ...args] = programWords(words);
    return writers.has(path.basename(program ?? "")) && args.some((arg) => arg.startsWith("<<"));
  });
  if (heredocWriter && scriptTargets(command).some((target) => protectedWrite(root, cwd, target))) return protectedReason;
  let currentCwd = cwd;
  let unresolvedCwd = false;
  for (const words of commands) {
    const [program, ...args] = programWords(words);
    const name = path.basename(program ?? "");
    if (name === "cd") {
      const directory = args[0];
      if (args.length !== 1 || !directory || /[$*?`]/.test(directory) || directory.startsWith("~")) {
        unresolvedCwd = true;
      } else if (path.isAbsolute(directory)) {
        currentCwd = path.resolve(directory);
        unresolvedCwd = false;
      } else if (!unresolvedCwd) {
        currentCwd = path.resolve(currentCwd, directory);
      }
      continue;
    }
    const decisionFor = (target, allowOwnChangeLog = true) => {
      if (unresolvedCwd && !path.isAbsolute(target)) return unresolvedReason;
      return protectedWrite(root, currentCwd, target, { allowOwnChangeLog }) ? protectedReason : null;
    };
    if (writers.has(name)) {
      const inline = args.findIndex((arg) => ["-c", "-e", "--eval"].includes(arg));
      if (inline >= 0) {
        for (const target of scriptTargets(args[inline + 1] ?? "")) {
          const reason = decisionFor(target);
          if (reason) return reason;
        }
      }
    }
    if (destinationWriters.has(name) && args.length >= 2) {
      // The hook checks the whole command before execution. Any destination writer
      // can plant a symlink that an earlier path check cannot yet observe.
      const reason = decisionFor(args.at(-1), false);
      if (reason) return reason;
    }
    if (name === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))
      && args.length > 1) {
      const reason = decisionFor(args.at(-1));
      if (reason) return reason;
    }
  }
  return null;
}

function preToolDeny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: reason } };
}

function permissionDeny(reason) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: reason } } };
}

/** Return a decision only for a positive protected-write classification. */
export function protectedWriteDecision(event, root) {
  if (!event || typeof event !== "object" || typeof event.cwd !== "string") throw new Error("invalid hook event");
  const eventName = event.hook_event_name;
  const tool = event.tool_name;
  if (!["PreToolUse", "PermissionRequest"].includes(eventName)) throw new Error("unexpected hook event");
  const cwd = path.resolve(event.cwd);
  if (tool === "Edit" || tool === "Write") {
    const target = targetPaths(root, cwd, event.tool_input?.file_path);
    if (target.admitted || isOwnChangeLog(root, target)) {
      return eventName === "PermissionRequest"
        ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }
        : null;
    }
    if (protectedPath(root, target.lexical) || protectedPath(realpathSync(root), target.effective)) {
      return eventName === "PermissionRequest"
        ? permissionDeny("protected-write guard: native target is outside the two admitted roots")
        : preToolDeny("protected-write guard: native target is outside the two admitted roots");
    }
    return null;
  }
  if (eventName === "PreToolUse" && tool === "Bash") {
    if (typeof event.tool_input?.command !== "string") throw new Error("invalid Bash command");
    const reason = bashProtectedWrite(root, cwd, event.tool_input.command);
    return reason ? preToolDeny(`protected-write guard: ${reason}`) : null;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("missing worktree");
    const root = path.resolve(process.argv[2]);
    realpathSync(root);
    const event = JSON.parse(readFileSync(0, "utf8"));
    const decision = protectedWriteDecision(event, root);
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    process.stderr.write(`protected-write guard failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
