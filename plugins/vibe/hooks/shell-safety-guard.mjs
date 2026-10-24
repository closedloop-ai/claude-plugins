#!/usr/bin/env node
// PreToolUse guard for Bash: workers may not invent credential routes to fetch
// evidence or force-push any remote. Both mistakes can escape a written rule,
// especially through an ssh command aimed at another machine.
// Three more refusals, each from a written rule that was skipped (2026-10-23/24):
// the fleet watcher started with `&` or inside a compound command detached and
// held its lock while its events never arrived; `set -- $var` in a merge watcher
// never fired, because zsh (this tool's shell on macOS) does not word-split an
// unquoted parameter; and e2e-slot.sh reruns tested an old commit when they
// started before the push landed, because the slot captured whatever HEAD was.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commandSegments } from "./command-segments.mjs";

const TOKEN = /(?:\b(?:gh_token|github_token|[a-z][a-z0-9_]*token)\b|\$\{?[a-z][a-z0-9_]*token\}?|--password(?:-stdin)?\b|(?:^|\s)-p(?:\s|$)|["']?auth["']?\s*:)/i;
const CREDENTIAL_ROUTE = /(?:\bDOCKER_CONFIG\b|\bdocker\s+login\b|["']?auths["']?\s*:)/i;
const SHELLS = new Set(["bash", "sh", "zsh"]);
const BACKGROUND_AMPERSAND = /&/;
const REDIRECT_AMPERSAND = /\d*>&\d*|&>>?/g;
const ZSH_SPLIT = /(?:^|[\s;&|(])set\s+--\s+\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?=[\s;&|)]|$)/m;
const SHA = /^[0-9a-f]{7,40}$/i;
const FORCE_PUSH = /\bgit\b(?:(?![;&|\n]).)*?\bpush\b(?:(?![;&|\n]).)*(?:\s-f(?:\s|$)|--force(?:-with-lease)?\b|(?:^|\s)\+[^\s]+)/i;

/** The credential-safety refusal for a shell command, or null. */
export function credentialProblem(command) {
  if (!CREDENTIAL_ROUTE.test(command) || !TOKEN.test(command)) return null;
  return "credential workaround refused: after the first authentication failure, use CI logs or the API for the same evidence, or stop and ask; never write, export or route around the operator's credentials";
}

/** The force-push refusal for a shell command, or null. */
export function forcePushProblem(command) {
  if (!FORCE_PUSH.test(command)) return null;
  return "force push refused: never rewrite any remote, including another machine or a scratch ref; create a fresh proof/<sha>-<n> ref and push normally";
}

/** The refusal for a fleet watcher launch that is not its own background tool call, or null. */
export function watcherLaunchProblem(input) {
  const command = typeof input?.command === "string" ? input.command.replace(REDIRECT_AMPERSAND, " ") : "";
  const segments = commandSegments(command).filter(({ words }) => words.length > 0);
  if (!segments.some(({ words }) => invokes(words, "watch.sh"))) return null;
  if (input.run_in_background === true && segments.length === 1 && !BACKGROUND_AMPERSAND.test(command)) return null;
  return "start watch.sh only as its own Bash call with run_in_background, never with & or inside a compound command: a detached copy never reports to you and holds the lock (stop one with kill-guard.mjs own <pid>, then kill <pid>)";
}

/** The refusal for `set -- $var`, which splits nothing in zsh, or null. */
export function wordSplitProblem(command) {
  if (!ZSH_SPLIT.test(command)) return null;
  return "set -- $var does not word-split in zsh, so $1 holds the whole string: use read -r first second <<< \"$var\"";
}

/** The refusal for an e2e-slot.sh run that does not name the commit it must test, or null. */
export function e2eSlotProblem(command) {
  for (const { words } of commandSegments(command)) {
    const start = words.findIndex((word, index) => path.basename(word) === "e2e-slot.sh" && (index === 0 || SHELLS.has(path.basename(words[index - 1]))));
    if (start < 0) continue;
    const head = words.indexOf("--head", start);
    if (head < 0 || !SHA.test(words[head + 1] ?? "")) {
      return "e2e-slot.sh needs --head <sha> before the owner label, the pushed commit to test: without it a rerun started before the push tests the old HEAD";
    }
  }
  return null;
}

function invokes(words, script) {
  const name = path.basename(words[0]);
  return name === script || (SHELLS.has(name) && path.basename(words[1] ?? "") === script);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const command = event?.tool_input?.command;
    if (event?.tool_name === "Bash" && typeof command === "string") {
      const problem = credentialProblem(command) ?? forcePushProblem(command) ?? watcherLaunchProblem(event.tool_input)
        ?? wordSplitProblem(command) ?? e2eSlotProblem(command);
      if (problem) {
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: problem,
        } })}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`shell-safety-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
