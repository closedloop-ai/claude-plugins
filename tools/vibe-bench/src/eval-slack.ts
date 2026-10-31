import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { EvalQuarantineEntry } from "./eval-baseline.ts";

const SLACK_POST_TIMEOUT_MS = 30_000;

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
  const cases = notice.cases.length ? notice.cases
    .map((item) => `• ${item.runtime}: ${item.case}`)
    .join("\n") : "• None";
  const changes = [
    ...notice.mergedPullRequests.map((item) =>
      `• <${item.url}|#${item.number}> by @${item.author}: ${slackText(item.title)}`),
    ...notice.directCommits.map((item) =>
      `• <${item.url}|direct commit ${item.commit.slice(0, 12)}> by ${slackText(item.author)}: ` +
      slackText(item.title)),
  ];
  const expired = notice.expiredQuarantine.map((item) =>
    `• ${item.runtime}: ${item.case}, owner @${slackText(item.owner)}, expired ${item.deadline}`);
  return [
    ":rotating_light: Vibe nightly eval attention required",
    ...(notice.cases.length ? [
      `Confirmed regressions between ${notice.baselineSha.slice(0, 12)} and ` +
        `${notice.currentSha.slice(0, 12)}:`, cases,
      "Changes since the last green nightly:",
      changes.length ? changes.join("\n") : "• None",
    ] : []),
    ...(expired.length ? ["Expired quarantine entries are gating:", expired.join("\n")] : []),
    `Quarantine owner: ${notice.quarantineOwner}`,
    "PR authors and the quarantine owner: coordinate a fix-forward or revert.",
    `Full results: ${notice.resultsArtifact}`,
  ].join("\n");
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
  return value.replaceAll(/[\r\n\t\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function deliveryId(notice: NightlyRegressionNotice): string {
  const hex = createHash("sha256").update(JSON.stringify({ currentSha: notice.currentSha,
    baselineSha: notice.baselineSha, cases: notice.cases,
    expiredQuarantine: notice.expiredQuarantine })).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Attribute every first-parent main commit to a merged PR or a direct commit. */
export function nightlyChangesSince(input: {
  repo: string;
  ghExecutable: string;
  baselineSha: string;
  currentSha: string;
}): { mergedPullRequests: NightlyMergedPullRequest[]; directCommits: NightlyDirectCommit[] } {
  const commits = spawnSync("git", ["-C", input.repo, "rev-list", "--first-parent",
    `${input.baselineSha}..${input.currentSha}`], { encoding: "utf8", timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024 });
  if (commits.status !== 0) throw new Error("eval-regression-commit-range-unavailable");
  const range = new Set(commits.stdout.split("\n").filter(Boolean));
  const repository = spawnSync(input.ghExecutable,
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: input.repo, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (repository.status !== 0 || !repository.stdout.trim()) {
    throw new Error("eval-regression-repository-unavailable");
  }
  const listed = spawnSync(input.ghExecutable, ["pr", "list", "--repo", repository.stdout.trim(),
    "--state", "merged", "--base", "main", "--limit", "200", "--json",
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
  const directCommits = [...range].filter((commit) => !matchedCommits.has(commit)).map((commit) => {
    const parents = spawnSync("git", ["-C", input.repo, "rev-list", "--parents", "-n", "1", commit],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    if (parents.status !== 0) throw new Error("eval-regression-commit-attribution-unavailable");
    if (parents.stdout.trim().split(/\s+/).length > 2) {
      throw new Error("eval-regression-pull-request-attribution-incomplete");
    }
    const detail = spawnSync("git", ["-C", input.repo, "show", "-s",
      "--format=%H%x00%s%x00%an%x00%ae", commit],
    { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    const [sha, title, authorName, authorEmail] = detail.stdout.trim().split("\0");
    if (detail.status !== 0 || sha !== commit || !title || !authorName || !authorEmail) {
      throw new Error("eval-regression-direct-commit-invalid");
    }
    return { commit, title, author: `${authorName} <${authorEmail}>`,
      url: `https://github.com/${repository.stdout.trim()}/commit/${commit}` };
  });
  return { mergedPullRequests: matched, directCommits };
}

/** Post through the existing team Slack bot without storing credentials. */
export class SlackNightlyRegressionReporter implements NightlyRegressionReporter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly send: typeof fetch;

  constructor(env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
    this.env = env;
    this.send = send;
  }

  async report(notice: NightlyRegressionNotice): Promise<void> {
    await this.post(formatNightlyRegressionMessage(notice), deliveryId(notice));
  }

  /** Post one non-model infrastructure failure when credentials are available. */
  async reportInfrastructure(notice: NightlyInfrastructureNotice): Promise<void> {
    const hex = createHash("sha256").update(JSON.stringify(notice)).digest("hex").slice(0, 32);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`;
    await this.post(formatNightlyInfrastructureMessage(notice), id);
  }

  private async post(text: string, clientMessageId: string): Promise<void> {
    const token = this.env.SLACK_BOT_TOKEN?.trim();
    const channel = this.env.SLACK_CHANNEL_ID?.trim();
    if (!token || !channel) throw new Error("eval-slack-credentials-missing");
    const response = await this.send("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text, client_msg_id: clientMessageId,
        unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error("eval-slack-response-malformed"); }
    if (!response.ok || !(body as { ok?: unknown }).ok) throw new Error("eval-slack-post-failed");
  }
}
