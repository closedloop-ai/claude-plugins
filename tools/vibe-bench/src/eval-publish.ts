import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicEvalResult } from "./eval-public-result.ts";
import { validatePublicEvalResult } from "./eval-public-result.ts";

const CI_WAIT_MS = 30 * 60_000;
const CI_POLL_MS = 30_000;

interface Project { id: string; name: string }
interface Ticket { id: string; slug: string; title: string; version?: { content?: string } }
interface PullRequest { number: number; url: string; state: string; headRefOid: string;
  baseRefName: string; headRefName: string; headRepository: { nameWithOwner: string } | null;
  files: Array<{ path: string }> }

/** Testable external boundary; the system implementation uses Git, gh, and ClosedLoop MCP. */
export interface EvalPublishAdapter {
  git(repo: string, args: string[]): string;
  gitBlob(repo: string, ref: string, path: string): string;
  gh(repo: string, args: string[]): string;
  checks(repo: string, pr: number): Array<{ bucket: string }>;
  closedLoop(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  now(): number;
  wait(ms: number): Promise<void>;
}

/** Execute only exact argument vectors; no shell interpolation or credential arguments. */
export class SystemEvalPublishAdapter implements EvalPublishAdapter {
  private readonly ghExecutable: string;
  private readonly uvExecutable: string;
  constructor(ghExecutable: string, uvExecutable: string) {
    this.ghExecutable = ghExecutable;
    this.uvExecutable = uvExecutable;
  }

  git(repo: string, args: string[]): string {
    try {
      return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { throw new Error(`eval-publish-git-${args[0]}-failed`); }
  }
  gitBlob(repo: string, ref: string, path: string): string {
    try {
      return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8",
        timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch { throw new Error("eval-publish-git-blob-failed"); }
  }
  gh(repo: string, args: string[]): string {
    try {
      return execFileSync(this.ghExecutable, args, { cwd: repo, encoding: "utf8", timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { throw new Error(`eval-publish-gh-${args[0]}-${args[1]}-failed`); }
  }
  checks(repo: string, pr: number): Array<{ bucket: string }> {
    const result = spawnSync(this.ghExecutable, ["pr", "checks", String(pr), "--json", "bucket"],
      { cwd: repo, encoding: "utf8", timeout: 90_000 });
    // gh exits nonzero for pending/red checks; JSON remains the source of truth.
    if (result.error) throw new Error("eval-publish-checks-unavailable");
    if (!result.stdout?.trim()) {
      if (/no checks reported/i.test(result.stderr ?? "")) return [];
      throw new Error("eval-publish-checks-unavailable");
    }
    const rows = JSON.parse(result.stdout) as Array<{ bucket: string }>;
    if (!Array.isArray(rows) || rows.some((row) => typeof row.bucket !== "string")) {
      throw new Error("eval-publish-checks-invalid");
    }
    return rows;
  }
  async closedLoop(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const script = fileURLToPath(new URL("./eval-publish-closedloop.py", import.meta.url));
    let output: string;
    try {
      output = execFileSync(this.uvExecutable, ["run", "--no-project", "--with",
        "mcp[cli]>=2,<3", "--with", "httpx2", script], { encoding: "utf8", timeout: 180_000,
        input: JSON.stringify({ operation, args }), stdio: ["pipe", "pipe", "pipe"] });
    } catch { throw new Error("eval-publish-closedloop-unavailable"); }
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("eval-publish-closedloop-response-invalid");
    }
    return parsed as Record<string, unknown>;
  }
  now(): number { return Date.now(); }
  wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}

/** Select the date-named workweek containing a UTC nightly start, not the newest project by update time. */
export function projectForRun(projects: Project[], runAt: string): Project {
  const date = new Date(runAt);
  if (Number.isNaN(date.valueOf())) throw new Error("eval-publish-run-date-invalid");
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  const name = `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}-` +
    `${friday.getUTCMonth() + 1}/${friday.getUTCDate()}`;
  const matching = projects.filter((project) => project.name === name);
  if (matching.length !== 1) throw new Error("eval-publish-week-project-unavailable");
  return matching[0]!;
}

function counts(result: PublicEvalResult): { pass: number; fail: number; unavailable: number } {
  return result.runtimes.flatMap((runtime) => runtime.cases).reduce((sum, item) => {
    sum[item.status] += 1;
    return sum;
  }, { pass: 0, fail: 0, unavailable: 0 });
}

function resultPaths(result: PublicEvalResult): [string, string] {
  const date = result.runAt.slice(0, 10);
  return [`evals/results/vibe/${result.pluginVersion}/${date}.json`, "evals/results/vibe/latest.json"];
}

function rejectSymlinkSegments(root: string, path: string): void {
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("eval-publish-symlink-invalid");
    }
  }
}

function parseItems<T>(response: Record<string, unknown>): T[] {
  if (!Array.isArray(response.items)) throw new Error("eval-publish-list-invalid");
  return response.items as T[];
}

async function findOrCreateTicket(adapter: EvalPublishAdapter, result: PublicEvalResult,
  title: string, body: string): Promise<Ticket> {
  const projects = parseItems<Project>(await adapter.closedLoop("list-projects", { limit: 100 }));
  const project = projectForRun(projects, result.runAt);
  let offset = 0;
  for (;;) {
    const page = await adapter.closedLoop("list-documents", {
      projectId: project.id, type: "ISSUE", limit: 100, offset,
    });
    const items = parseItems<Ticket>(page);
    const found = items.find((item) => item.title === title);
    if (found) return found;
    if (items.length < 100) break;
    offset += items.length;
  }
  const created = await adapter.closedLoop("create-document", { projectId: project.id,
    type: "ISSUE", status: "IN_PROGRESS", title, content: body });
  if (typeof created.id !== "string" || typeof created.slug !== "string") {
    throw new Error("eval-publish-ticket-create-invalid");
  }
  return created as unknown as Ticket;
}

async function appendTicket(adapter: EvalPublishAdapter, ticket: Ticket, line: string,
  status?: "DONE"): Promise<void> {
  const current = await adapter.closedLoop("get-document", { documentId: ticket.id,
    includeContent: true, contentMaxChars: 120000 });
  const version = current.version as { content?: string; contentTruncated?: boolean } | undefined;
  if (typeof version?.content !== "string" || version.contentTruncated) {
    throw new Error("eval-publish-ticket-content-unavailable");
  }
  if (!version.content.split("\n").includes(line)) {
    await adapter.closedLoop("create-document-version", { documentId: ticket.id,
      content: `${version.content.trimEnd()}\n${line}\n` });
  }
  if (status && current.status !== status) {
    await adapter.closedLoop("update-document", { documentId: ticket.id,
      status, expectedStatus: "IN_PROGRESS" });
  }
}

/** Require at least one passing CI check and no failed, canceled, or pending check. */
export async function waitForPassingCi(adapter: EvalPublishAdapter, repo: string,
  pr: number, expectedHead?: string): Promise<"green" | "red" | "timeout"> {
  const deadline = adapter.now() + CI_WAIT_MS;
  while (adapter.now() < deadline) {
    if (expectedHead && readPr(adapter, repo, String(pr)).headRefOid !== expectedHead) {
      throw new Error("eval-publish-pr-head-changed");
    }
    const checks = adapter.checks(repo, pr);
    if (checks.some((check) => ["fail", "cancel"].includes(check.bucket))) return "red";
    if (checks.some((check) => check.bucket === "pass") &&
        checks.every((check) => ["pass", "skipping"].includes(check.bucket))) return "green";
    await adapter.wait(CI_POLL_MS);
  }
  return "timeout";
}

function readPr(adapter: EvalPublishAdapter, repo: string, reference: string): PullRequest {
  const value = JSON.parse(adapter.gh(repo, ["pr", "view", reference, "--json",
    "number,url,state,headRefOid,headRefName,headRepository,baseRefName,files"])) as PullRequest;
  if (!Number.isInteger(value.number) || typeof value.url !== "string" ||
      !/^[a-f0-9]{40}$/.test(value.headRefOid) || !Array.isArray(value.files)) {
    throw new Error("eval-publish-pr-invalid");
  }
  return value;
}

/** Prove the named branch head is a two-file regular-blob commit with exact projected bytes. */
function verifyResultHead(adapter: EvalPublishAdapter, repo: string, ref: string,
  head: string, allowed: string[], content: string): void {
  adapter.git(repo, ["fetch", "origin", ref]);
  if (adapter.git(repo, ["rev-parse", "FETCH_HEAD"]) !== head ||
      adapter.git(repo, ["diff", "--name-only", "origin/main...FETCH_HEAD"])
        .split("\n").filter(Boolean).sort().join("\0") !== allowed.join("\0")) {
    throw new Error("eval-publish-head-path-invalid");
  }
  for (const path of allowed) {
    const tree = adapter.git(repo, ["ls-tree", "FETCH_HEAD", "--", path]);
    if (!/^100644 blob [a-f0-9]{40}\t/.test(tree) || tree.split("\t")[1] !== path) {
      throw new Error("eval-publish-head-mode-invalid");
    }
    if (adapter.gitBlob(repo, "FETCH_HEAD", path) !== content) {
      throw new Error("eval-publish-head-content-invalid");
    }
  }
}

function verifyPr(adapter: EvalPublishAdapter, repo: string, pr: PullRequest,
  branch: string, allowed: string[], content: string): void {
  const own = JSON.parse(adapter.gh(repo, ["repo", "view", "--json", "nameWithOwner"])) as {
    nameWithOwner?: string;
  };
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(own.nameWithOwner ?? "") ||
      pr.url !== `https://github.com/${own.nameWithOwner}/pull/${pr.number}` ||
      pr.baseRefName !== "main" || pr.headRefName !== branch ||
      (pr.state === "OPEN" && pr.headRepository?.nameWithOwner !== own.nameWithOwner) ||
      pr.files.map((file) => file.path).sort().join("\0") !== allowed.join("\0")) {
    throw new Error("eval-publish-pr-identity-invalid");
  }
  verifyResultHead(adapter, repo, pr.state === "MERGED" ? `pull/${pr.number}/head` : branch,
    pr.headRefOid, allowed, content);
}

/** Publish one sanitized completed nightly through a result-only PR and CI-gated merge. */
export async function publishNightlyEval(input: { repo: string; runRoot: string;
  result: PublicEvalResult }, adapter: EvalPublishAdapter): Promise<{
  ticket: string; pr: string; outcome: "merged" | "ci-red" | "ci-timeout";
}> {
  const result = validatePublicEvalResult(input.result);
  const [datedPath, latestPath] = resultPaths(result);
  const allowed = [datedPath, latestPath].sort();
  const content = `${JSON.stringify(result, null, 2)}\n`;
  const summary = counts(result);
  const title = `Vibe eval ${result.pluginVersion} ${result.runAt.slice(0, 10)} ${result.pluginSha.slice(0, 8)}`;
  const body = `Nightly vibe eval for ${result.pluginVersion} (${result.pluginSha}).\n\n` +
    `Pass: ${summary.pass}; fail: ${summary.fail}; unavailable: ${summary.unavailable}.\n`;
  const ticket = await findOrCreateTicket(adapter, result, title, body);
  const branch = `vibe-eval-${result.pluginVersion}-${result.runAt.slice(0, 10)}-${result.pluginSha.slice(0, 8)}`;
  const listed = JSON.parse(adapter.gh(input.repo, ["pr", "list", "--state", "all", "--head",
    branch, "--json", "number,url,state"])) as Array<{ url: string }>;
  if (!Array.isArray(listed) || listed.length > 1) throw new Error("eval-publish-pr-list-invalid");
  let pr: PullRequest;
  if (listed.length) {
    pr = readPr(adapter, input.repo, listed[0]!.url);
  } else {
    adapter.git(input.repo, ["fetch", "origin", "main"]);
    const remote = adapter.git(input.repo, ["ls-remote", "--heads", "origin", branch]);
    let head: string;
    if (remote) {
      head = remote.split(/\s+/)[0]!;
      if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("eval-publish-remote-head-invalid");
      verifyResultHead(adapter, input.repo, branch, head, allowed, content);
    } else {
      const worktree = join(input.runRoot, `publish-${adapter.now()}-${process.pid}`);
      if (existsSync(worktree)) throw new Error("eval-publish-worktree-exists");
      adapter.git(input.repo, ["worktree", "add", "--detach", worktree, "origin/main"]);
      try {
        for (const path of allowed) {
          rejectSymlinkSegments(worktree, path);
          const destination = join(worktree, path);
          mkdirSync(join(destination, ".."), { recursive: true });
          if (path === datedPath && existsSync(destination) &&
              readFileSync(destination, "utf8") !== content) throw new Error("eval-publish-date-conflict");
          writeFileSync(destination, content);
        }
        adapter.git(worktree, ["add", "--", datedPath, latestPath]);
        const staged = adapter.git(worktree, ["diff", "--cached", "--name-only"]).split("\n")
          .filter(Boolean).sort();
        if (staged.join("\0") !== allowed.join("\0")) {
          throw new Error("eval-publish-staged-path-invalid");
        }
        adapter.git(worktree, ["diff", "--cached", "--check"]);
        const message = join(input.runRoot, `publish-commit-${process.pid}.txt`);
        writeFileSync(message, `Publish vibe eval baseline\n\n- Add reviewed ${result.pluginVersion} nightly result\n` +
          `- Advance the latest baseline pointer\n\nTesting: Nightly eval completed\nRisks: None identified\n`);
        try { adapter.git(worktree, ["commit", "-F", message]); }
        finally { rmSync(message, { force: true }); }
        head = adapter.git(worktree, ["rev-parse", "HEAD"]);
        const committed = adapter.git(worktree, ["diff-tree", "--no-commit-id", "--name-only",
          "-r", "HEAD"]).split("\n").filter(Boolean).sort();
        if (committed.join("\0") !== allowed.join("\0") ||
            adapter.git(worktree, ["status", "--porcelain"]) !== "") {
          throw new Error("eval-publish-commit-path-invalid");
        }
        adapter.git(worktree, ["push", "origin", `HEAD:refs/heads/${branch}`]);
      } finally {
        // The worktree contains only publisher-owned files. Keep it on an unclean failure.
        if (adapter.git(worktree, ["status", "--porcelain"]) === "") {
          adapter.git(input.repo, ["worktree", "remove", worktree]);
        }
      }
    }
    const prBody = join(input.runRoot, `publish-pr-${process.pid}.txt`);
    writeFileSync(prBody, `${ticket.slug}\n\n${body}`);
    let url: string;
    try { url = adapter.gh(input.repo, ["pr", "create", "--base", "main", "--head",
      branch, "--title", title, "--body-file", prBody]); }
    catch {
      const recovered = JSON.parse(adapter.gh(input.repo, ["pr", "list", "--state", "all",
        "--head", branch, "--json", "number,url,state"])) as Array<{ url: string }>;
      if (recovered.length !== 1) throw new Error("eval-publish-pr-create-failed");
      url = recovered[0]!.url;
    } finally { rmSync(prBody, { force: true }); }
    pr = readPr(adapter, input.repo, url);
    if (pr.headRefOid !== head) throw new Error("eval-publish-pr-head-mismatch");
  }
  adapter.git(input.repo, ["fetch", "origin", "main"]);
  verifyPr(adapter, input.repo, pr, branch, allowed, content);
  await appendTicket(adapter, ticket, `PR: ${pr.url}`);
  if (pr.state === "MERGED") {
    await appendTicket(adapter, ticket, `Merged PR: ${pr.url}`, "DONE");
    return { ticket: ticket.slug, pr: pr.url, outcome: "merged" };
  }
  if (pr.state !== "OPEN") throw new Error("eval-publish-pr-not-open");
  const ci = await waitForPassingCi(adapter, input.repo, pr.number, pr.headRefOid);
  if (ci !== "green") {
    await appendTicket(adapter, ticket, `CI ${ci}: PR left open for follow-up.`);
    return { ticket: ticket.slug, pr: pr.url, outcome: ci === "red" ? "ci-red" : "ci-timeout" };
  }
  verifyPr(adapter, input.repo, readPr(adapter, input.repo, pr.url), branch, allowed, content);
  adapter.gh(input.repo, ["pr", "merge", pr.url, "--squash", "--match-head-commit", pr.headRefOid]);
  if (readPr(adapter, input.repo, pr.url).state !== "MERGED") {
    throw new Error("eval-publish-merge-unconfirmed");
  }
  await appendTicket(adapter, ticket, `Merged PR: ${pr.url}`, "DONE");
  return { ticket: ticket.slug, pr: pr.url, outcome: "merged" };
}
