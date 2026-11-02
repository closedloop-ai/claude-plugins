import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SLACK_POST_TOOL = "mcp__plugin_slack_slack__slack_send_message";

interface SlackPostInput {
  channel_id: string;
  message: string;
}

interface PreToolUseInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

interface PreToolUseDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
    updatedInput?: SlackPostInput;
  };
}

function deny(reason: string): PreToolUseDecision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: reason } };
}

/**
 * Permit exactly one byte-for-byte Slack post request. This runs before the
 * MCP side effect, so model-generated arguments cannot change the destination
 * or pre-rendered message.
 */
export function slackToolGateDecision(input: PreToolUseInput,
  expected: SlackPostInput): PreToolUseDecision {
  const actual = input.tool_input as Record<string, unknown> | undefined;
  if (input.tool_name !== SLACK_POST_TOOL || !actual ||
      Object.keys(actual).sort().join(",") !== "channel_id,message" ||
      actual.channel_id !== expected.channel_id || actual.message !== expected.message) {
    return deny("Vibe nightly Slack payload did not match the pre-rendered message");
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "allow", permissionDecisionReason: "Exact Vibe nightly payload",
    updatedInput: expected } };
}

function main(args: string[]): void {
  const [expectedPath, attemptPath] = args;
  if (!expectedPath || !attemptPath) {
    process.stdout.write(`${JSON.stringify(deny("Vibe nightly Slack gate configuration invalid"))}\n`);
    return;
  }
  let attempt: number;
  try { attempt = openSync(attemptPath, "wx", 0o600); }
  catch {
    process.stdout.write(`${JSON.stringify(deny("Vibe nightly Slack post already attempted"))}\n`);
    return;
  }
  let decision: PreToolUseDecision;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as PreToolUseInput;
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as SlackPostInput;
    decision = slackToolGateDecision(input, expected);
  } catch {
    decision = deny("Vibe nightly Slack gate input invalid");
  }
  try {
    writeFileSync(attempt, `${JSON.stringify({
      permissionDecision: decision.hookSpecificOutput.permissionDecision,
    })}\n`);
  } finally {
    closeSync(attempt);
  }
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
