import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalQuarantineEntry } from "./eval-baseline.ts";

const SLACK_POST_TIMEOUT_MS = 20_000;
const SLACK_HEALTH_TIMEOUT_MS = 10_000;
const SLACK_CHANNEL_ID = "C0CC9G7V01G";
const SLACK_POST_TOOL = "mcp__plugin_slack_slack__slack_send_message";
const SLACK_DELIVERY_MODEL = "claude-haiku-5-5";
const SLACK_PLUGIN_ID = "slack@anthropic-plugin-directory";
const SLACK_MCP_SERVER = "plugin:slack:slack";
const SLACK_DETAIL_LIMIT = 50;
const SLACK_FIELD_LIMIT = 500;
const SLACK_MESSAGE_BYTE_LIMIT = 30_000;
const CHANGE_ATTRIBUTION_LIMIT = 1_000;

/** Operator-approved one-shot message for validating the nightly Slack relay. */
export const SLACK_DELIVERY_TEST_MESSAGE =
  "vibe nightly: test post from the second laptop to confirm Slack delivery (ISS-13478). " +
  "No action needed.";

/** Observable delivery metadata returned by Slack's send-message result. */
export interface SlackDeliveryReceipt {
  timestamp: string | null;
  permalink: string | null;
}

/** One unchanged, reliable case that failed all nightly attempts. */
export interface NightlyRegressionCase {
  runtime: "claude" | "codex";
  case: string;
}

/** GitHub attribution for one main commit after the last green nightly. */
export interface NightlyMergedPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  mergeCommit: string;
}

/** A first-parent main commit that GitHub does not associate with a pull request. */
export interface NightlyDirectCommit {
  commit: string;
  title: string;
  url: string;
  author: string;
}

/** Complete model-free payload rendered into one #vibe message. */
export interface NightlyRegressionNotice {
  baselineSha: string;
  currentSha: string;
  cases: NightlyRegressionCase[];
  mergedPullRequests: NightlyMergedPullRequest[];
  directCommits: NightlyDirectCommit[];
  expiredQuarantine: EvalQuarantineEntry[];
  quarantineOwner: string;
  resultsArtifact: string;
}

/** Operator-visible scheduler failure that happened outside model evaluation. */
export interface NightlyInfrastructureNotice {
  reason: string;
  occurredAt: string;
}

/** Delivery boundary injected by T0 tests. */
export interface NightlyRegressionReporter {
  report(notice: NightlyRegressionNotice): Promise<void>;
}

/** Format one compact message for the team-owned #vibe channel. */
export function formatNightlyRegressionMessage(notice: NightlyRegressionNotice): string {
  if (!notice.cases.length && !notice.expiredQuarantine.length) {
    throw new Error("eval-slack-alert-empty");
  }
  const cases = notice.cases.length ? limitedLines(notice.cases
    .map((item) => `• ${item.runtime}: ${slackText(item.case)}`)).join("\n") : "• None";
  const changes = [
    ...notice.mergedPullRequests.map((item) =>
      `• <${item.url}|#${item.number}> by @${item.author}: ${slackText(item.title)}`),
    ...notice.directCommits.map((item) =>
      `• <${item.url}|direct commit ${item.commit.slice(0, 12)}> by ${slackText(item.author)}: ` +
      slackText(item.title)),
  ];
  const expired = notice.expiredQuarantine.map((item) =>
    `• ${item.runtime}: ${slackText(item.case)}, owner @${slackText(item.owner)}, ` +
      `expired ${slackText(item.deadline)}`);
  const message = [
    ":rotating_light: Vibe nightly eval attention required",
    ...(notice.cases.length ? [
      `Confirmed regressions between ${notice.baselineSha.slice(0, 12)} and ` +
        `${notice.currentSha.slice(0, 12)}:`, cases,
      "Changes since the last green nightly:",
      changes.length ? limitedLines(changes).join("\n") : "• None",
    ] : []),
    ...(expired.length ? ["Expired quarantine entries are gating:",
      limitedLines(expired).join("\n")] : []),
    `Quarantine owner: ${slackText(notice.quarantineOwner)}`,
    "PR authors and the quarantine owner: coordinate a fix-forward or revert.",
    `Full results: ${slackText(notice.resultsArtifact)}`,
  ].join("\n");
  if (Buffer.byteLength(message, "utf8") > SLACK_MESSAGE_BYTE_LIMIT) {
    throw new Error("eval-slack-message-too-large");
  }
  return message;
}

/** Format a scheduler failure for the same team-owned channel. */
export function formatNightlyInfrastructureMessage(notice: NightlyInfrastructureNotice): string {
  if (!notice.reason.trim()) throw new Error("eval-slack-infrastructure-reason-empty");
  return [
    ":warning: Vibe nightly infrastructure failure",
    `Reason: ${slackText(notice.reason)}`,
    `Occurred at: ${slackText(notice.occurredAt)}`,
    "No model result was accepted. Inspect the nightly machine log before the next run.",
  ].join("\n");
}

function slackText(value: string): string {
  const sanitized = value.replaceAll(/[\r\n\t\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const characters = [...sanitized];
  return characters.length > SLACK_FIELD_LIMIT
    ? `${characters.slice(0, SLACK_FIELD_LIMIT).join("")}…` : sanitized;
}

function limitedLines(lines: string[]): string[] {
  return lines.length <= SLACK_DETAIL_LIMIT ? lines
    : [...lines.slice(0, SLACK_DETAIL_LIMIT), `• … ${lines.length - SLACK_DETAIL_LIMIT} more`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Attribute every first-parent main commit to a merged PR or a direct commit. */
export function nightlyChangesSince(input: {
  repo: string;
  ghExecutable: string;
  baselineSha: string;
  currentSha: string;
}): { mergedPullRequests: NightlyMergedPullRequest[]; directCommits: NightlyDirectCommit[] } {
  const commits = spawnSync("git", ["-C", input.repo, "rev-list", "--parents", "--first-parent",
    `${input.baselineSha}..${input.currentSha}`], { encoding: "utf8", timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024 });
  if (commits.status !== 0) throw new Error("eval-regression-commit-range-unavailable");
  const commitRows = commits.stdout.split("\n").filter(Boolean).map((line) => line.split(/\s+/));
  if (commitRows.length > CHANGE_ATTRIBUTION_LIMIT) {
    throw new Error("eval-regression-commit-range-too-large");
  }
  const range = new Set(commitRows.map(([commit]) => commit));
  const parentCounts = new Map(commitRows.map(([commit, ...parents]) => [commit, parents.length]));
  const repository = spawnSync(input.ghExecutable,
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: input.repo, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (repository.status !== 0 || !repository.stdout.trim()) {
    throw new Error("eval-regression-repository-unavailable");
  }
  const listed = spawnSync(input.ghExecutable, ["pr", "list", "--repo", repository.stdout.trim(),
    "--state", "merged", "--base", "main", "--limit", String(CHANGE_ATTRIBUTION_LIMIT), "--json",
    "number,title,url,author,mergeCommit"], { cwd: input.repo, encoding: "utf8", timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error("eval-regression-pull-requests-unavailable");
  let raw: unknown;
  try { raw = JSON.parse(listed.stdout); }
  catch { throw new Error("eval-regression-pull-requests-malformed"); }
  if (!Array.isArray(raw)) throw new Error("eval-regression-pull-requests-malformed");
  const matched = raw.flatMap((item): NightlyMergedPullRequest[] => {
    const value = item as { number?: unknown; title?: unknown; url?: unknown;
      author?: { login?: unknown }; mergeCommit?: { oid?: unknown } };
    const oid = value.mergeCommit?.oid;
    if (typeof oid !== "string" || !range.has(oid)) return [];
    if (typeof value.number !== "number" || typeof value.title !== "string" ||
        typeof value.url !== "string" || typeof value.author?.login !== "string") {
      throw new Error("eval-regression-pull-request-invalid");
    }
    return [{ number: value.number, title: value.title, url: value.url,
      author: value.author.login, mergeCommit: oid }];
  }).sort((left, right) => left.number - right.number);
  const matchedCommits = new Set(matched.map((item) => item.mergeCommit));
  const directShas = [...range].filter((commit) => !matchedCommits.has(commit));
  for (const commit of directShas) {
    if ((parentCounts.get(commit) ?? 0) > 1) {
      throw new Error("eval-regression-pull-request-attribution-incomplete");
    }
  }
  if (!directShas.length) return { mergedPullRequests: matched, directCommits: [] };
  const detail = spawnSync("git", ["-C", input.repo, "show", "-s",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1e", ...directShas],
    { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (detail.status !== 0) throw new Error("eval-regression-commit-attribution-unavailable");
  const details = new Map(detail.stdout.split("\x1e").flatMap((record) => {
    const [sha, title, authorName, authorEmail] = record.trim().split("\x1f");
    return sha && title && authorName && authorEmail
      ? [[sha, { title, authorName, authorEmail }] as const] : [];
  }));
  const directCommits = directShas.map((commit) => {
    const value = details.get(commit);
    if (!value) {
      throw new Error("eval-regression-direct-commit-invalid");
    }
    return { commit, title: value.title, author: `${value.authorName} <${value.authorEmail}>`,
      url: `https://github.com/${repository.stdout.trim()}/commit/${commit}` };
  });
  return { mergedPullRequests: matched, directCommits };
}

/** Captured synchronous Claude CLI result used by the injectable transport boundary. */
export interface SlackClaudeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Stable relay failure that identifies whether no Slack side effect was attempted. */
export class SlackDeliveryError extends Error {
  readonly retrySafe: boolean;

  constructor(message: string, retrySafe: boolean) {
    super(message);
    this.name = "SlackDeliveryError";
    this.retrySafe = retrySafe;
  }
}

/** Return true only for failures proven to happen before the Slack tool process starts. */
export function isRetrySafeSlackFailure(error: unknown): boolean {
  return error instanceof SlackDeliveryError && error.retrySafe;
}

/** Injectable process boundary; tests never launch Claude or contact Slack. */
export type SlackClaudeRunner = (command: string, args: string[], options: {
  input: string;
  timeout: number;
}) => SlackClaudeResult;

const runSlackClaude: SlackClaudeRunner = (command, args, options) => {
  const result = spawnSync(command, args, { input: options.input, encoding: "utf8",
    timeout: options.timeout, maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    error: result.error };
};

function deliveryPrompt(text: string): string {
  return [
    "Act only as a deterministic transport.",
    `Call ${SLACK_POST_TOOL} exactly once with the JSON object below.`,
    "Copy both values exactly. Do not compose, summarize, escape, reformat, or add text.",
    "Do not call any other tool and do not write prose.",
    JSON.stringify({ channel_id: SLACK_CHANNEL_ID, message: text }),
  ].join("\n");
}

function embeddedValues(value: unknown): unknown[] {
  const values: unknown[] = [];
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    values.push(current);
    if (Array.isArray(current)) {
      queue.push(...current);
    } else if (current && typeof current === "object") {
      queue.push(...Object.values(current));
    } else if (typeof current === "string") {
      const trimmed = current.trim();
      const candidates = [trimmed];
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
      }
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (parsed !== current) queue.push(parsed);
        } catch { /* Non-JSON tool-result text has no structured receipt fields. */ }
      }
    }
  }
  return values;
}

function firstReceiptValue(value: unknown, keys: string[]): string | null {
  for (const candidate of embeddedValues(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key];
    }
  }
  return null;
}

function verifySlackTranscript(stdout: string, expectedText: string): SlackDeliveryReceipt {
  const events = stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error("eval-slack-claude-output-malformed"); }
  });
  const toolUses = events.flatMap((event) => {
    if (event.type !== "assistant") return [];
    const message = event.message as { content?: unknown } | undefined;
    return Array.isArray(message?.content) ? message.content.filter((block) =>
      (block as { type?: unknown }).type === "tool_use") as Array<{
        id?: unknown; name?: unknown; input?: unknown;
      }> : [];
  });
  if (toolUses.length !== 1) throw new Error("eval-slack-tool-call-count-invalid");
  const toolUse = toolUses[0];
  const input = toolUse.input as Record<string, unknown> | undefined;
  if (toolUse.name !== SLACK_POST_TOOL || typeof toolUse.id !== "string" || !input ||
      Object.keys(input).sort().join(",") !== "channel_id,message" ||
      input.channel_id !== SLACK_CHANNEL_ID || input.message !== expectedText) {
    throw new Error("eval-slack-tool-call-altered");
  }
  const matchingResults = events.flatMap((event) => {
    if (event.type !== "user") return [];
    const message = event.message as { content?: unknown } | undefined;
    return Array.isArray(message?.content) ? message.content.filter((block) => {
      const value = block as { type?: unknown; tool_use_id?: unknown };
      return value.type === "tool_result" && value.tool_use_id === toolUse.id;
    }) as Array<{ is_error?: unknown; content?: unknown }> : [];
  });
  if (matchingResults.length !== 1 || matchingResults[0].is_error === true) {
    throw new Error("eval-slack-tool-result-failed");
  }
  const content = matchingResults[0].content;
  return {
    timestamp: firstReceiptValue(content, ["ts", "message_ts", "timestamp"]),
    permalink: firstReceiptValue(content, ["permalink", "message_link"]),
  };
}

function requireSlackMcpConnection(result: SlackClaudeResult): void {
  const output = `${result.stdout}\n${result.stderr}`;
  const slackLine = output.split(/\r?\n/).find((line) => line.includes(SLACK_MCP_SERVER));
  if (!result.error && result.status === 0 && slackLine && /\bConnected\b/.test(slackLine)) return;
  if (slackLine && /credential|authenticat|keychain/i.test(slackLine)) {
    throw new SlackDeliveryError(
      "eval-slack-credentials-unavailable: macOS login keychain is locked or Slack MCP " +
      "credentials are missing; unlock the login keychain or keep the GUI session logged in",
      true,
    );
  }
  throw new SlackDeliveryError("eval-slack-mcp-unavailable", true);
}

function requireSlackGateOutcome(attemptPath: string): void {
  let value: unknown;
  try { value = JSON.parse(readFileSync(attemptPath, "utf8")); }
  catch { throw new SlackDeliveryError("eval-slack-gate-not-confirmed", false); }
  const decision = (value as { permissionDecision?: unknown } | null)?.permissionDecision;
  if (decision === "deny") throw new SlackDeliveryError("eval-slack-gate-denied", true);
  if (decision !== "allow") {
    throw new SlackDeliveryError("eval-slack-gate-not-confirmed", false);
  }
}

/** Post a pre-rendered notice through the authenticated Slack MCP connection. */
export class SlackNightlyRegressionReporter implements NightlyRegressionReporter {
  private readonly claudeExecutable: string;
  private readonly run: SlackClaudeRunner;

  constructor(claudeExecutable = "claude", run: SlackClaudeRunner = runSlackClaude) {
    this.claudeExecutable = claudeExecutable;
    this.run = run;
  }

  async report(notice: NightlyRegressionNotice): Promise<void> {
    await this.post(formatNightlyRegressionMessage(notice));
  }

  /** Post one non-model infrastructure failure when user auth and Slack MCP are available. */
  async reportInfrastructure(notice: NightlyInfrastructureNotice): Promise<void> {
    await this.post(formatNightlyInfrastructureMessage(notice));
  }

  /** Send the single operator-approved fixed relay test and return its Slack receipt. */
  async reportApprovedTest(): Promise<SlackDeliveryReceipt> {
    return await this.post(SLACK_DELIVERY_TEST_MESSAGE);
  }

  private async post(text: string): Promise<SlackDeliveryReceipt> {
    const plugins = this.run(this.claudeExecutable, ["plugin", "list", "--json"], {
      input: "", timeout: 5_000,
    });
    if (plugins.error || plugins.status !== 0) {
      throw new SlackDeliveryError("eval-slack-plugin-unavailable", true);
    }
    let installed: unknown;
    try { installed = JSON.parse(plugins.stdout); }
    catch { throw new SlackDeliveryError("eval-slack-plugin-list-malformed", true); }
    const slack = Array.isArray(installed) ? installed.find((item) =>
      (item as { id?: unknown }).id === SLACK_PLUGIN_ID) as {
        enabled?: unknown; installPath?: unknown;
      } | undefined : undefined;
    if (slack?.enabled !== true || typeof slack.installPath !== "string" ||
        !slack.installPath.startsWith("/")) {
      throw new SlackDeliveryError("eval-slack-plugin-unavailable", true);
    }
    const health = this.run(this.claudeExecutable, ["--plugin-dir", slack.installPath,
      "--setting-sources", "", "--settings", "{}", "mcp", "list"], {
      input: "", timeout: SLACK_HEALTH_TIMEOUT_MS,
    });
    requireSlackMcpConnection(health);
    const gateRoot = mkdtempSync(join(tmpdir(), "vibe-slack-gate-"));
    try {
      const expectedPath = join(gateRoot, "expected.json");
      const attemptPath = join(gateRoot, "attempted");
      writeFileSync(expectedPath, JSON.stringify({ channel_id: SLACK_CHANNEL_ID, message: text }),
        { mode: 0o600 });
      const gate = fileURLToPath(new URL("./slack-tool-gate.ts", import.meta.url));
      const gateCommand = [process.execPath, "--experimental-strip-types", gate,
        expectedPath, attemptPath].map(shellQuote).join(" ");
      const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: SLACK_POST_TOOL, hooks: [{
        type: "command", command: gateCommand, timeout: 5,
      }] }] } });
      const args = ["-p", "--model", SLACK_DELIVERY_MODEL, "--effort", "low",
        "--max-turns", "2", "--max-budget-usd", "0.20", "--permission-mode", "dontAsk",
        "--permission-prompts", "none", "--no-session-persistence", "--output-format",
        "stream-json", "--verbose", "--tools", "", "--setting-sources", "", "--settings",
        settings, "--plugin-dir", slack.installPath, "--allowedTools", SLACK_POST_TOOL];
      const result = this.run(this.claudeExecutable, args, {
        input: deliveryPrompt(text), timeout: SLACK_POST_TIMEOUT_MS,
      });
      try {
        requireSlackGateOutcome(attemptPath);
        return verifySlackTranscript(result.stdout, text);
      }
      catch (error) {
        if (error instanceof SlackDeliveryError) throw error;
        if (result.error?.message.includes("ETIMEDOUT") ||
            result.error?.message.includes("timed out")) {
          throw new SlackDeliveryError("eval-slack-claude-timeout", false);
        }
        if (result.error || result.status !== 0) {
          throw new SlackDeliveryError("eval-slack-claude-failed", false);
        }
        throw new SlackDeliveryError(error instanceof Error ? error.message
          : "eval-slack-transcript-invalid", false);
      }
    } finally {
      rmSync(gateRoot, { recursive: true, force: true });
    }
  }
}
