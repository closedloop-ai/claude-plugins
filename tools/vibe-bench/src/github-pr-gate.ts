import { BENCHMARK_BYPASS_LABEL, BENCHMARK_EVIDENCE_MARKER,
  BENCHMARK_RED_ACCEPTANCE_LABEL } from "./pr-body-gate.ts";
import type { BenchmarkGateInput, GateTimelineEvent } from "./pr-body-gate.ts";
import type { BenchmarkEvidenceArtifact } from "./pr-body-gate.ts";

/** Minimal fetch boundary injected by tests. */
export type GateFetch = (input: string, init?: RequestInit) => Promise<Response>;

function repositoryParts(repository: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("benchmark-github-repository-invalid");
  return [match[1], match[2]];
}

function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const item of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(item);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

async function requestJson(url: string, token: string, fetcher: GateFetch): Promise<unknown> {
  const response = await fetcher(url, { headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (!response.ok) throw new Error(`benchmark-github-http:${response.status}`);
  try { return await response.json() as unknown; }
  catch { throw new Error("benchmark-github-json-invalid"); }
}

async function paginatedArray(firstUrl: string, token: string, repositoryPath: string,
  fetcher: GateFetch): Promise<unknown[]> {
  const rows: unknown[] = [];
  const visited = new Set<string>();
  let url: string | null = firstUrl;
  for (let page = 0; url && page < 100; page += 1) {
    if (visited.has(url)) throw new Error("benchmark-github-pagination-loop");
    visited.add(url);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.host !== "api.github.com" ||
        !parsed.pathname.startsWith(`/repos/${repositoryPath}/`)) {
      throw new Error("benchmark-github-pagination-origin");
    }
    const response = await fetcher(url, { headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    } });
    if (!response.ok) throw new Error(`benchmark-github-http:${response.status}`);
    let value: unknown;
    try { value = await response.json() as unknown; }
    catch { throw new Error("benchmark-github-json-invalid"); }
    if (!Array.isArray(value)) throw new Error("benchmark-github-page-invalid");
    rows.push(...value);
    url = nextPage(response.headers.get("link"));
  }
  if (url) throw new Error("benchmark-github-pagination-limit");
  return rows;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function attachedEvidence(body: string): BenchmarkEvidenceArtifact | null {
  if (!body.includes(BENCHMARK_EVIDENCE_MARKER)) return null;
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("benchmark-github-evidence-format-invalid");
  let value: unknown;
  try { value = JSON.parse(match[1]); }
  catch { throw new Error("benchmark-github-evidence-json-invalid"); }
  return object(value, "benchmark-github-evidence-invalid") as unknown as BenchmarkEvidenceArtifact;
}

/** Fetch the exact live pull request, changed paths and label provenance used by the gate. */
export async function fetchBenchmarkGateInput(repository: string, number: number, token: string,
  fetcher: GateFetch = fetch): Promise<BenchmarkGateInput> {
  if (!Number.isInteger(number) || number <= 0) throw new Error("benchmark-github-pr-number-invalid");
  if (!token) throw new Error("benchmark-github-token-missing");
  const [owner, repo] = repositoryParts(repository);
  const repositoryPath = `${owner}/${repo}`;
  const root = `https://api.github.com/repos/${repositoryPath}`;
  const pull = object(await requestJson(`${root}/pulls/${number}`, token, fetcher),
    "benchmark-github-pull-invalid");
  const head = object(pull.head, "benchmark-github-head-invalid");
  const headSha = text(head.sha, "benchmark-github-head-sha-invalid");
  const body = pull.body === null ? "" : text(pull.body, "benchmark-github-body-invalid");
  if (!Array.isArray(pull.labels)) throw new Error("benchmark-github-labels-invalid");
  const labels = pull.labels.map((item) => text(object(item,
    "benchmark-github-label-invalid").name, "benchmark-github-label-name-invalid"));

  const fileRows = await paginatedArray(`${root}/pulls/${number}/files?per_page=100`, token,
    repositoryPath, fetcher);
  const changedFiles = new Set<string>();
  for (const value of fileRows) {
    const row = object(value, "benchmark-github-file-invalid");
    changedFiles.add(text(row.filename, "benchmark-github-filename-invalid"));
    if (row.previous_filename !== undefined) {
      changedFiles.add(text(row.previous_filename, "benchmark-github-previous-filename-invalid"));
    }
  }

  const timelineRows = await paginatedArray(`${root}/issues/${number}/timeline?per_page=100`, token,
    repositoryPath, fetcher);
  const watched = new Set([BENCHMARK_BYPASS_LABEL, BENCHMARK_RED_ACCEPTANCE_LABEL]);
  const timelineEvents: GateTimelineEvent[] = [];
  for (const value of timelineRows) {
    const row = object(value, "benchmark-github-timeline-invalid");
    if (row.event === "labeled" || row.event === "unlabeled") {
      const label = text(object(row.label, "benchmark-github-event-label-invalid").name,
        "benchmark-github-event-label-name-invalid");
      if (!watched.has(label)) continue;
      const actor = text(object(row.actor, "benchmark-github-event-actor-invalid").login,
        "benchmark-github-event-actor-login-invalid");
      timelineEvents.push({ event: row.event, label, actor });
    } else if (row.event === "committed") {
      timelineEvents.push({ event: "committed", sha: text(row.sha,
        "benchmark-github-commit-sha-invalid") });
    } else if (row.event === "head_ref_force_pushed") {
      timelineEvents.push({ event: "head_ref_force_pushed", sha: text(row.commit_id,
        "benchmark-github-force-push-sha-invalid") });
    }
  }
  const commentRows = await paginatedArray(`${root}/issues/${number}/comments?per_page=100`, token,
    repositoryPath, fetcher);
  const evidenceArtifacts = commentRows.flatMap((value) => {
    const row = object(value, "benchmark-github-comment-invalid");
    const commentBody = text(row.body, "benchmark-github-comment-body-invalid");
    const artifact = attachedEvidence(commentBody);
    return artifact ? [artifact] : [];
  });
  return { number, headSha, body, changedFiles: [...changedFiles].sort(), labels, timelineEvents,
    evidenceArtifacts };
}
