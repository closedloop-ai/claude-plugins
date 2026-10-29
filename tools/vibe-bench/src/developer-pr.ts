import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SelectedPullRequest } from "./developer-benchmark.ts";
import { BENCHMARK_EVIDENCE_MARKER } from "./pr-body-gate.ts";
import type { BenchmarkEvidenceArtifact } from "./pr-body-gate.ts";

const REPOSITORY = "closedloop-ai/claude-plugins";

/** Minimal open pull request identity shown before paid benchmark work. */
export interface PullRequestCandidate extends SelectedPullRequest {
  title: string;
}

/** Injected Git and GitHub process boundary for selection and publication tests. */
export interface DeveloperPrCommands {
  run(command: string, args: string[], cwd: string): string;
}

/** System command adapter used only by the local developer skill. */
export class ProcessDeveloperPrCommands implements DeveloperPrCommands {
  run(command: string, args: string[], cwd: string): string {
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trimEnd();
  }
}

function parseCandidates(raw: string): PullRequestCandidate[] {
  const items: unknown = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("benchmark-pr-list-invalid");
  return items.map((value): PullRequestCandidate => {
    const item = value as Record<string, unknown>;
    if (!Number.isInteger(item.number) || Number(item.number) <= 0 || typeof item.url !== "string" ||
        typeof item.headRefName !== "string" || typeof item.headRefOid !== "string" ||
        !/^[a-f0-9]{40}$/.test(item.headRefOid) || typeof item.title !== "string") {
      throw new Error("benchmark-pr-list-invalid");
    }
    return { number: Number(item.number), url: item.url, branch: item.headRefName,
      headSha: item.headRefOid, title: item.title };
  });
}

/** List only the authenticated developer's open repository pull requests. */
export function listOpenPullRequests(repo: string,
  commands: DeveloperPrCommands = new ProcessDeveloperPrCommands(), gh = "gh"): PullRequestCandidate[] {
  return parseCandidates(commands.run(gh, ["pr", "list", "--repo", REPOSITORY, "--author", "@me",
    "--state", "open", "--json", "number,url,headRefName,headRefOid,title"], repo));
}

function selectedView(raw: string): SelectedPullRequest & { state: string; base: string } {
  const item = JSON.parse(raw) as Record<string, unknown>;
  if (!Number.isInteger(item.number) || Number(item.number) <= 0 || typeof item.url !== "string" ||
      typeof item.headRefName !== "string" || typeof item.headRefOid !== "string" ||
      !/^[a-f0-9]{40}$/.test(item.headRefOid) || typeof item.state !== "string" ||
      typeof item.baseRefName !== "string") throw new Error("benchmark-pr-view-invalid");
  return { number: Number(item.number), url: item.url, branch: item.headRefName,
    headSha: item.headRefOid, state: item.state, base: item.baseRefName };
}

/** Require an open selected PR whose branch and full head equal the clean checkout. */
export function preflightSelectedPullRequest(repo: string, number: number,
  commands: DeveloperPrCommands = new ProcessDeveloperPrCommands(), gh = "gh"): SelectedPullRequest {
  if (commands.run("git", ["status", "--porcelain"], repo)) throw new Error("benchmark-pr-checkout-dirty");
  const remote = commands.run("git", ["remote", "get-url", "origin"], repo);
  if (!/[:/]closedloop-ai\/claude-plugins(?:\.git)?$/.test(remote)) throw new Error("benchmark-pr-repository-invalid");
  const branch = commands.run("git", ["branch", "--show-current"], repo);
  const headSha = commands.run("git", ["rev-parse", "HEAD^{commit}"], repo);
  const selected = selectedView(commands.run(gh, ["pr", "view", String(number), "--repo", REPOSITORY,
    "--json", "number,url,headRefName,headRefOid,state,baseRefName"], repo));
  if (selected.state !== "OPEN" || selected.base !== "main" || selected.branch !== branch ||
      selected.headSha !== headSha) throw new Error("benchmark-pr-head-or-branch-mismatch");
  return { number: selected.number, url: selected.url, branch, headSha };
}

interface Heading {
  name: string;
  start: number;
}

function renderedH2(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fence: { char: string; length: number } | null = null;
  let comment = false;
  let offset = 0;
  for (const lineWithNewline of markdown.match(/.*(?:\n|$)/g) ?? []) {
    if (!lineWithNewline) continue;
    const line = lineWithNewline.endsWith("\n") ? lineWithNewline.slice(0, -1) : lineWithNewline;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!comment && fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (fence.char === marker[0] && marker.length >= fence.length) fence = null;
      offset += lineWithNewline.length;
      continue;
    }
    if (!fence) {
      let rendered = line;
      while (true) {
        if (comment) {
          const end = rendered.indexOf("-->");
          if (end < 0) { rendered = ""; break; }
          rendered = rendered.slice(end + 3);
          comment = false;
        }
        const start = rendered.indexOf("<!--");
        if (start < 0) break;
        const end = rendered.indexOf("-->", start + 4);
        if (end < 0) { rendered = rendered.slice(0, start); comment = true; break; }
        rendered = rendered.slice(0, start) + rendered.slice(end + 3);
      }
      const heading = /^\s{0,3}##(?!#)\s+(.+?)\s*#*\s*$/.exec(rendered);
      if (heading) headings.push({ name: heading[1].trim(), start: offset });
    }
    offset += lineWithNewline.length;
  }
  return headings;
}

/** Replace exactly one rendered Benchmark section, or append it when absent. */
export function replaceBenchmarkSection(body: string, section: string): string {
  if (!/^## Benchmark\n/m.test(section) || renderedH2(section).filter((item) => item.name === "Benchmark").length !== 1) {
    throw new Error("benchmark-publish-section-invalid");
  }
  const headings = renderedH2(body);
  const matches = headings.filter((heading) => heading.name === "Benchmark");
  if (matches.length > 1) throw new Error("benchmark-publish-section-duplicate");
  const normalized = section.trimEnd();
  if (!matches.length) {
    const separator = !body ? "" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return `${body}${separator}${normalized}\n`;
  }
  const start = matches[0].start;
  const next = headings.find((heading) => heading.start > start);
  const prefix = body.slice(0, start);
  const suffix = body.slice(next?.start ?? body.length);
  return next ? `${prefix}${normalized}\n\n${suffix}` : `${prefix}${normalized}\n`;
}

/** Recheck the head, edit only the PR body, and confirm the exact live result. */
export function publishBenchmarkSection(repo: string, selected: SelectedPullRequest, sectionFile: string,
  evidence: BenchmarkEvidenceArtifact,
  commands: DeveloperPrCommands = new ProcessDeveloperPrCommands(), gh = "gh"): void {
  const live = preflightSelectedPullRequest(repo, selected.number, commands, gh);
  if (live.headSha !== selected.headSha || live.branch !== selected.branch) {
    throw new Error("benchmark-pr-head-moved");
  }
  const viewArgs = ["pr", "view", String(selected.number), "--repo", REPOSITORY, "--json", "body,headRefOid"];
  const before = JSON.parse(commands.run(gh, viewArgs, repo)) as { body?: unknown; headRefOid?: unknown };
  if (before.headRefOid !== selected.headSha || typeof before.body !== "string") {
    throw new Error("benchmark-pr-live-body-invalid");
  }
  const body = replaceBenchmarkSection(before.body, readFileSync(sectionFile, "utf8"));
  const bodyFile = join(dirname(sectionFile), `.benchmark-pr-${selected.number}-body.md`);
  const evidenceFile = join(dirname(sectionFile), `.benchmark-pr-${selected.number}-evidence.md`);
  writeFileSync(bodyFile, body, { flag: "wx", mode: 0o600 });
  writeFileSync(evidenceFile, `${BENCHMARK_EVIDENCE_MARKER}\n\n\`\`\`json\n${JSON.stringify(evidence)}\n\`\`\`\n`,
    { flag: "wx", mode: 0o600 });
  try {
    commands.run(gh, ["pr", "edit", String(selected.number), "--repo", REPOSITORY,
      "--body-file", bodyFile], repo);
    commands.run(gh, ["pr", "comment", String(selected.number), "--repo", REPOSITORY,
      "--body-file", evidenceFile], repo);
  } finally {
    unlinkSync(bodyFile);
    unlinkSync(evidenceFile);
  }
  const after = JSON.parse(commands.run(gh, viewArgs, repo)) as { body?: unknown; headRefOid?: unknown };
  if (after.headRefOid !== selected.headSha || after.body !== body) throw new Error("benchmark-pr-publish-confirmation-failed");
}
