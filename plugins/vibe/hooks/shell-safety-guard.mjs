#!/usr/bin/env node
// PreToolUse guard for Bash: workers may not invent credential routes to fetch
// evidence or force-push any remote. Both mistakes can escape a written rule,
// especially through an ssh command aimed at another machine.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOKEN = /(?:\b(?:gh_token|github_token|[a-z][a-z0-9_]*token)\b|\$\{?[a-z][a-z0-9_]*token\}?|--password(?:-stdin)?\b|(?:^|\s)-p(?:\s|$)|["']?auth["']?\s*:)/i;
const CREDENTIAL_ROUTE = /(?:\bDOCKER_CONFIG\b|\bdocker\s+login\b|["']?auths["']?\s*:)/i;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const command = event?.tool_input?.command;
    if (event?.tool_name === "Bash" && typeof command === "string") {
      const problem = credentialProblem(command) ?? forcePushProblem(command);
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
