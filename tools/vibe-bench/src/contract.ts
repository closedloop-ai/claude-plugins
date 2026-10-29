import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** The current `sonnet` writer alias resolved to this ID; PLN-2237 v5 pins it. */
export const BENCHMARK_MODEL = "claude-sonnet-5-5";
/** Operational precedent uses the fleet's high-effort default, explicitly. */
export const BENCHMARK_EFFORT = "high";
/** The full all-runs target, retained even after a miss. */
export const TARGET_WALL_MS = 10 * 60 * 1000;
/** Vibe's existing symphony-alpha remote check accepts this local bare path. */
export const FAKE_REMOTE_SUFFIX = `${sep}closedloop-ai${sep}symphony-alpha.git`;
/** The symphony-alpha MCP app's documented default loopback endpoint. */
export const LOCAL_MCP_URL = "http://127.0.0.1:3010/mcp";
export const BENCHMARK_TASK_ID = "project-search-infix";

/** The single bounded product task, fixed for a baseline's lifetime. */
export const BENCHMARK_TASK = {
  id: BENCHMARK_TASK_ID,
  prompt:
    "On the Projects list, make search find a project when the query occurs anywhere in its name, ignoring letter case and spaces before or after the query. Raise a draft PR when the fix is ready.",
  file: "packages/app/projects/lib/project-summary-view.ts",
  healthy:
    'return term === "" || row.name.toLocaleLowerCase().includes(term);',
  broken:
    'return term === "" || row.name.toLocaleLowerCase().startsWith(term);',
} as const;

/** Requested Claude Code model and reasoning effort. */
export interface ClaudeSelection {
  model: string;
  effort: string;
}

export interface LocalBoundary {
  /** The disposable checkout's `origin` fetch URL. */
  fetchRemote: string;
  /** The disposable checkout's `origin` push URL. */
  pushRemote: string;
  /** Directory containing the private fake bare remote. */
  sandboxRoot: string;
  /** URL supplied to the Claude Code `closedloop` MCP registration. */
  mcpUrl: string;
}

/** Identity and completion evidence parsed from one Claude Code run. */
export interface ObservedClaudeRun {
  /** The model reported by Claude's stream or final result. */
  model: string | null;
  /** The exact effort passed to the launched Claude process. */
  launchedEffort: string | null;
  /** An effort value reported by the runtime, if a future CLI exposes one. */
  reportedEffort?: string | null;
  resultStatus: string;
}

/** Refuse a different configured model, effort, or environment override. */
export function requirePinnedClaude(
  selection: ClaudeSelection,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeSelection {
  for (const key of ["ANTHROPIC_MODEL", "CLAUDE_CODE_MODEL", "CLAUDE_MODEL"] as const) {
    if (env[key]) throw new Error(`benchmark-model-env-override: ${key}`);
  }
  for (const key of ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_MODEL_EFFORT", "CLAUDE_EFFORT"] as const) {
    if (env[key]) throw new Error(`benchmark-effort-env-override: ${key}`);
  }
  if (selection.model !== BENCHMARK_MODEL) {
    throw new Error(`benchmark-model-mismatch: expected ${BENCHMARK_MODEL}, got ${selection.model || "missing"}`);
  }
  if (selection.effort !== BENCHMARK_EFFORT) {
    throw new Error(`benchmark-effort-mismatch: expected ${BENCHMARK_EFFORT}, got ${selection.effort || "missing"}`);
  }
  return { model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT };
}

/** Record the resolved model and explicit effort; a success exit alone is insufficient. */
export function validateClaudeResult(observed: ObservedClaudeRun): {
  valid: boolean;
  reason: string | null;
  model: string | null;
  effort: string | null;
  effortSource: "explicit-cli";
} {
  const reason = observed.model !== BENCHMARK_MODEL
    ? "benchmark-model-mismatch"
    : observed.launchedEffort !== BENCHMARK_EFFORT ||
        (observed.reportedEffort != null && observed.reportedEffort !== BENCHMARK_EFFORT)
      ? "benchmark-effort-mismatch"
      : observed.resultStatus !== "success"
        ? "benchmark-run-incomplete"
        : null;
  return {
    valid: reason === null,
    reason,
    model: observed.model,
    effort: observed.reportedEffort ?? observed.launchedEffort,
    effortSource: "explicit-cli",
  };
}

/** Build one immutable Claude invocation; callers cannot substitute another model. */
export function claudeArgs(pluginDir: string, mcpConfigFile: string, prompt: string): string[] {
  if (!pluginDir || !mcpConfigFile || !prompt) {
    throw new Error("benchmark-claude-argument-missing");
  }
  requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
  return [
    "--print", "--output-format", "stream-json", "--verbose",
    "--model", BENCHMARK_MODEL, "--effort", BENCHMARK_EFFORT,
    "--plugin-dir", pluginDir, "--mcp-config", mcpConfigFile,
    "--strict-mcp-config", "--permission-prompts", "none", prompt,
  ];
}

/** Reject external destinations before a benchmark can start Claude or mutate state. */
export function requireLocalBoundary(boundary: LocalBoundary): void {
  const root = realpathSync(boundary.sandboxRoot);
  if (!isAbsolute(root)) {
    throw new Error("benchmark-sandbox-not-absolute");
  }
  const fetch = localRemote(boundary.fetchRemote, root);
  const push = localRemote(boundary.pushRemote, root);
  if (fetch !== push || !fetch.endsWith(FAKE_REMOTE_SUFFIX)) {
    throw new Error("benchmark-remote-mismatch");
  }
  let url: URL;
  try {
    url = new URL(boundary.mcpUrl);
  } catch {
    throw new Error("benchmark-mcp-not-loopback");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.port !== "3010" || url.pathname !== "/mcp" || url.search || url.hash ||
      url.username || url.password) {
    throw new Error("benchmark-mcp-not-loopback");
  }
}

function localRemote(raw: string, root: string): string {
  if (!isAbsolute(raw) || raw.includes("://")) {
    throw new Error("benchmark-remote-not-local-path");
  }
  const resolved = realpathSync(raw);
  const fromRoot = relative(root, resolved);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("benchmark-remote-outside-sandbox");
  }
  return resolved;
}

/** State required of an eventual benchmark pull request. */
export interface BenchmarkPr {
  title: string;
  body: string;
  draft: true;
  state: "draft" | "recorded" | "closed";
  resultHash: string | null;
}

/** The future PR adapter uses this exact draft-only contract. */
export function benchmarkPr(taskId: string): BenchmarkPr {
  if (taskId !== BENCHMARK_TASK_ID) {
    throw new Error("benchmark-task-unknown");
  }
  return {
    title: `DO NOT MERGE: vibe benchmark ${taskId}`,
    body: `This draft PR is part of a benchmark of vibe on the fixed ${taskId} task. It will be closed after results are recorded.\n\n## Benchmark\n\nMeasurement pending.`,
    draft: true,
    state: "draft",
    resultHash: null,
  };
}

/** Enforce record-before-close and make a repeated close harmless. */
export function advanceBenchmarkPr(pr: BenchmarkPr, action: "record" | "close", resultHash?: string): BenchmarkPr {
  if (!pr.draft || !pr.title.includes("DO NOT MERGE") ||
      !pr.body.includes("part of a benchmark of vibe") || !pr.body.includes("## Benchmark")) {
    throw new Error("benchmark-pr-contract-invalid");
  }
  if (action === "record") {
    if (pr.state === "closed" || !resultHash || !/^[a-f0-9]{64}$/.test(resultHash)) {
      throw new Error("benchmark-result-not-recorded");
    }
    if (pr.state === "recorded" && pr.resultHash !== resultHash) {
      throw new Error("benchmark-result-already-recorded");
    }
    return { ...pr, state: "recorded", resultHash };
  }
  if (pr.state === "closed") return pr;
  if (pr.state !== "recorded" || !pr.resultHash) {
    throw new Error("benchmark-close-before-record");
  }
  return { ...pr, state: "closed" };
}

/** Keep the ten-minute target fixed even when a measured run misses it. */
export function wallVerdict(wallMs: number): { wallMs: number; targetMs: number; targetMet: boolean } {
  if (!Number.isFinite(wallMs) || wallMs < 0) throw new Error("benchmark-wall-invalid");
  return { wallMs, targetMs: TARGET_WALL_MS, targetMet: wallMs < TARGET_WALL_MS };
}
