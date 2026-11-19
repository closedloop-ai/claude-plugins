// PreToolUse guard for Bash: no command runs a macOS app bundle's own executable (`*.app/Contents/MacOS/*`).
// 2026-11-18: an orchestrator ran a desktop app's `<App>.app/Contents/MacOS/<App> --version` to read its version.
// The Electron binary has no --version: it booted as a GUI app inside the terminal's process tree, lost its
// single-instance lock and quit, and the Dock tile it left owned the terminal's server tree, so force-quitting it
// killed every Claude and Codex session on the machine. A Node helper that ships inside an Electron app runs with
// ELECTRON_RUN_AS_NODE=1 set for that command, which keeps the binary a plain Node process.

// Runs from pre-tool-use.mjs.

import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny } from "./hook-dispatch.mjs";

const APP_EXECUTABLE = /(?:^|\/)[^/]+\.app\/Contents\/MacOS\/[^/]+$/;
const VARIABLE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const AS_NODE = "ELECTRON_RUN_AS_NODE";

/** The refusal for a command that runs an app bundle's executable without ELECTRON_RUN_AS_NODE=1, or null. */
export function appBinaryProblem(command) {
  const variables = new Map();
  // Only an exported variable reaches the child; a bare `NAME=value;` stays in the shell.
  const exported = new Map();
  let directory = "";
  for (const segment of commandSegments(command, { expandShellPayloads: true })) {
    if (segment.words[0] === "cd") {
      const target = segment.words[1] ?? "";
      directory = target.startsWith("/") ? target : path.posix.join(directory, target);
      continue;
    }
    const isExport = segment.words[0] === "export";
    if (segment.words.length === 0 || isExport) {
      for (const [name, value] of Object.entries(segment.env ?? {})) variables.set(name, value);
      for (const word of isExport ? segment.words.slice(1) : []) {
        const at = word.indexOf("=");
        if (at > 0) variables.set(word.slice(0, at), word.slice(at + 1));
        const name = at > 0 ? word.slice(0, at) : word;
        if (variables.has(name)) exported.set(name, variables.get(name));
      }
      continue;
    }
    const { words, env } = runnerFree(segment.words, segment.env ?? {});
    const named = VARIABLE.test(words[0] ?? "") ? variables.get(VARIABLE.exec(words[0])[1]) ?? "" : words[0] ?? "";
    // A relative program path runs from the directory an earlier `cd` in the same command moved to.
    const program = named.includes("/") && !named.startsWith("/") ? path.posix.join(directory, named) : named;
    if (!APP_EXECUTABLE.test(program)) continue;
    if ((env[AS_NODE] ?? exported.get(AS_NODE)) === "1") continue;
    const app = program.slice(0, program.indexOf(".app/") + ".app".length);
    return `running ${program} starts the app itself in this terminal's process tree (an Electron app has no --version; force-quitting the app it leaves can kill every session on the machine). Read its version with \`defaults read "${app}/Contents/Info.plist" CFBundleShortVersionString\`, launch it deliberately with \`open -a "${app}"\`, or set ${AS_NODE}=1 on the command for a Node helper inside it.`;
  }
  return null;
}

/**
 * The command a runner (`timeout`, `nice`, `arch`, `caffeinate`, `stdbuf`, `taskpolicy`) runs, its options and
 * operands skipped, with any `env` and NAME=value
 * words in front of it folded into `env`; command-segments.mjs already unwraps sudo, env, exec and the like.
 */
function runnerFree(words, env) {
  let rest = words;
  const assigned = { ...env };
  for (;;) {
    const program = path.basename(rest[0] ?? "");
    const runner = RUNNERS[program];
    if (runner) {
      let at = 1;
      while (rest[at]?.startsWith("-") && rest[at] !== "--") at += runner.valued.has(rest[at]) ? 2 : 1;
      if (rest[at] === "--") at += 1;
      rest = rest.slice(at + runner.operands);
    } else if (program === "env" || ASSIGNMENT.test(rest[0] ?? "")) {
      let at = program === "env" ? 1 : 0;
      for (; at < rest.length; at += 1) {
        if (rest[at] === "-u" || rest[at] === "--unset") { delete assigned[rest[at + 1]]; at += 1; }
        else if (ASSIGNMENT.test(rest[at])) { const split = rest[at].indexOf("="); assigned[rest[at].slice(0, split)] = rest[at].slice(split + 1); }
        else if (!rest[at].startsWith("-")) break;
      }
      rest = rest.slice(at);
    } else return { words: rest, env: assigned };
  }
}

// Commands that run the command after their own options (and, for timeout, one duration operand). A valued option
// written apart from its value takes the next word.
const TIMEOUT = { valued: new Set(["-s", "-k", "--signal", "--kill-after"]), operands: 1 };
const RUNNERS = Object.assign(Object.create(null), {
  timeout: TIMEOUT,
  gtimeout: TIMEOUT,
  nice: { valued: new Set(["-n", "--adjustment"]), operands: 0 },
  arch: { valued: new Set(["-arch", "-e"]), operands: 0 },
  caffeinate: { valued: new Set(["-t", "-w"]), operands: 0 },
  stdbuf: { valued: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]), operands: 0 },
  taskpolicy: { valued: new Set(["-c", "-t", "-l", "-p", "-g"]), operands: 0 },
});
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Bash PreToolUse: refuse running an app bundle's executable. */
export function appBinaryGuard(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string" || !command.includes(".app") && !command.includes("$")) return null;
  const problem = appBinaryProblem(command);
  return problem ? deny(problem) : null;
}
