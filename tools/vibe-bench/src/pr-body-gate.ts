/** GitHub label that permits the benchmark approver to waive one head SHA. */
export const BENCHMARK_BYPASS_LABEL = "benchmark-not-needed";
/** GitHub label that records approver acceptance of one red result at one head SHA. */
export const BENCHMARK_RED_ACCEPTANCE_LABEL = "benchmark-regression-accepted";
/** Authorized benchmark approver login. */
export const BENCHMARK_APPROVER_LOGIN = "shafty023";
export const BENCHMARK_EVIDENCE_MARKER = "<!-- vibe-benchmark-evidence-v1 -->";

const PROTECTED_PATHS = [
  /^plugins\/vibe(?:\/|$)/,
  /^tools\/vibe-bench(?:\/|$)/,
  /^tools\/vibe-workers(?:\/|$)/,
  /^\.github\/workflows\/vibe-benchmark-gate\.yml$/,
  /^\.github\/pull_request_template\.md$/,
];

const PLACEHOLDER = /^(?:tbd|todo|not run|measurement pending|replace this section)$/i;
const FULL_SHA = /^[0-9a-f]{40}$/;
const EVAL_EVIDENCE = /^### Model-driven evals$[\s\S]*^Full shared corpus: \d+ cases; result hash `[0-9a-f]{64}`; plugin `[0-9a-f]{40}`\.$[\s\S]*^- claude: \d+\/\d+ passed;[\s\S]*^- codex: \d+\/\d+ passed;/m;

/** Relevant GitHub issue timeline event, preserved in API order. */
export type GateTimelineEvent =
  | { event: "labeled" | "unlabeled"; label: string; actor: string }
  | { event: "committed" | "head_ref_force_pushed"; sha: string };

/** Exact live pull request state consumed by the model-free gate. */
export interface BenchmarkGateInput {
  number: number;
  headSha: string;
  body: string;
  changedFiles: string[];
  labels: string[];
  timelineEvents: GateTimelineEvent[];
  evidenceArtifacts: BenchmarkEvidenceArtifact[];
}

/** Compact attached evidence checked by trusted base code without a model. */
export interface BenchmarkEvidenceArtifact {
  schemaVersion: 1;
  headSha: string;
  resultHash: string;
  evalResultHash: string;
  cliVersion: string;
  configuredModel: string;
  configuredEffort: string;
  valid: boolean;
  success: boolean;
  fullWallMs: number;
  costUsd: number;
  modelCalls: number;
  totals: { inputTokens: number; uncachedInputTokens: number; outputTokens: number };
  breakdowns: Record<"component" | "skill" | "worker" | "phase",
    Array<{ name: string; calls: number }>>;
  comparison: "green" | "yellow" | "red";
  eval: {
    pluginSha: string;
    cases: number;
    runtimes: Array<{ runtime: "claude" | "codex"; passed: number; failed: number }>;
  };
}

/** Stable model-free result suitable for a required GitHub check. */
export interface BenchmarkGateResult {
  status: "pass" | "fail";
  code: string;
  message: string;
}

function pass(code: string, message: string): BenchmarkGateResult {
  return { status: "pass", code, message };
}

function fail(code: string, message: string): BenchmarkGateResult {
  return { status: "fail", code, message };
}

/** Return whether a changed path belongs to the benchmark disclosure surface. */
export function isBenchmarkProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((pattern) => pattern.test(path));
}

function stripNonRenderedBlocks(markdown: string): string {
  const rendered: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  let comment = false;
  for (const originalLine of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(originalLine);
    if (!comment && fenceMatch) {
      const marker = fenceMatch[1];
      const char = marker[0] as "`" | "~";
      if (!fence) fence = { char, length: marker.length };
      else if (fence.char === char && marker.length >= fence.length) fence = null;
      rendered.push("");
      continue;
    }
    if (fence) {
      rendered.push("");
      continue;
    }
    let line = originalLine;
    let output = "";
    while (line.length > 0) {
      if (comment) {
        const end = line.indexOf("-->");
        if (end < 0) { line = ""; break; }
        comment = false;
        line = line.slice(end + 3);
        continue;
      }
      const start = line.indexOf("<!--");
      if (start < 0) { output += line; break; }
      output += line.slice(0, start);
      comment = true;
      line = line.slice(start + 4);
    }
    rendered.push(output);
  }
  return rendered.join("\n");
}

/** Extract exactly one rendered level-two Benchmark section. */
export function benchmarkSection(body: string): { content: string } | BenchmarkGateResult {
  const lines = stripNonRenderedBlocks(body).split("\n");
  const matches = lines.flatMap((line, index) => /^##[ \t]+Benchmark[ \t]*$/.test(line) ? [index] : []);
  if (matches.length === 0) return fail("benchmark-section-missing", "Add one rendered `## Benchmark` section.");
  if (matches.length !== 1) return fail("benchmark-section-duplicate", "Keep exactly one rendered `## Benchmark` section.");
  const start = matches[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,2}[ \t]+\S/.test(lines[index])) { end = index; break; }
  }
  const content = lines.slice(start, end).join("\n").trim();
  if (!content || PLACEHOLDER.test(content)) {
    return fail("benchmark-section-empty", "Replace the Benchmark placeholder with results or an approved bypass.");
  }
  return { content };
}

function lineValue(content: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(content);
  return match?.[1]?.trim() || null;
}

function latestLabelEvent(input: BenchmarkGateInput, label: string): {
  actor: string; index: number;
} | null {
  let latest: { actor: string; index: number } | null = null;
  input.timelineEvents.forEach((item, index) => {
    if ((item.event === "labeled" || item.event === "unlabeled") && item.label === label) {
      latest = item.event === "labeled" ? { actor: item.actor, index } : null;
    }
  });
  return latest;
}

function validateApproval(input: BenchmarkGateInput, label: string): BenchmarkGateResult | null {
  if (!input.labels.includes(label)) return fail("benchmark-approval-label-missing", `The benchmark approver must apply \`${label}\` for this head.`);
  const latest = latestLabelEvent(input, label);
  if (latest?.actor !== BENCHMARK_APPROVER_LOGIN) {
    return fail("benchmark-approval-actor-invalid", `The latest \`${label}\` event must be from the benchmark approver.`);
  }
  if (input.timelineEvents.slice(latest.index + 1).some((item) =>
      item.event === "committed" || item.event === "head_ref_force_pushed")) {
    return fail("benchmark-approval-label-stale", `The benchmark approver must reapply \`${label}\` after the latest head change.`);
  }
  return null;
}

function validPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function tableHasData(content: string, heading: string): boolean {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) return false;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("### "));
  return lines.slice(start + 1, end < 0 ? undefined : end)
    .some((line) => /^\|\s*[^|\s][^|]*\|\s*[1-9]\d*\s*\|/.test(line));
}

function validateEvidence(input: BenchmarkGateInput, content: string,
  status: "green" | "yellow" | "red"): BenchmarkGateResult | null {
  const hash = /^Result: .+; hash: `([0-9a-f]{64})`\.$/m.exec(content)?.[1];
  if (!hash) return fail("benchmark-result-hash-missing", "Benchmark results must include the result hash.");
  const artifact = input.evidenceArtifacts.find((item) => item.resultHash === hash);
  if (!artifact) return fail("benchmark-evidence-missing", "Attach the benchmark evidence for this result hash.");
  if (artifact.schemaVersion !== 1 || artifact.headSha !== input.headSha || artifact.eval.pluginSha !== input.headSha) {
    return fail("benchmark-evidence-head-mismatch", "Attached evidence must target the current pull request head.");
  }
  if (!artifact.valid || !artifact.success || artifact.configuredModel !== "claude-sonnet-5-5" ||
      artifact.configuredEffort !== "high" || artifact.comparison !== status ||
      !/^\d+\.\d+\.\d+ \(Claude Code\)$/.test(artifact.cliVersion)) {
    return fail("benchmark-evidence-invalid", "Attached benchmark evidence is invalid or does not match the disclosure.");
  }
  if (![artifact.fullWallMs, artifact.costUsd, artifact.modelCalls, artifact.totals.inputTokens,
    artifact.totals.uncachedInputTokens, artifact.totals.outputTokens].every(validPositive) ||
    artifact.totals.uncachedInputTokens > artifact.totals.inputTokens) {
    return fail("benchmark-evidence-totals-invalid", "Attached benchmark totals must be positive and internally plausible.");
  }
  const wall = /^Wall (\d+) ms .*; cost \$(\d+(?:\.\d+)?); (\d+) model calls\.$/m.exec(content);
  const totals = /^Totals: input (\d+), cached read \d+, uncached input (\d+), cache write \d+, output (\d+), thinking (?:\d+|unknown)\.$/m.exec(content);
  const runtime = /^Claude Code (\d+\.\d+\.\d+);/m.exec(content)?.[1];
  if (!wall || !totals || runtime !== artifact.cliVersion.split(" ")[0] || Number(wall[1]) !== artifact.fullWallMs ||
      Number(wall[2]) !== artifact.costUsd || Number(wall[3]) !== artifact.modelCalls ||
      Number(totals[1]) !== artifact.totals.inputTokens ||
      Number(totals[2]) !== artifact.totals.uncachedInputTokens ||
      Number(totals[3]) !== artifact.totals.outputTokens) {
    return fail("benchmark-evidence-body-mismatch", "The disclosed runtime and totals must match the attached evidence.");
  }
  for (const facet of ["component", "skill", "worker", "phase"] as const) {
    const rows = artifact.breakdowns[facet];
    if (!Array.isArray(rows) || !rows.length || rows.some((row) => !row.name || !validPositive(row.calls)) ||
        rows.reduce((sum, row) => sum + row.calls, 0) !== artifact.modelCalls) {
      return fail(`benchmark-${facet}-breakdown-invalid`, `Attached ${facet} breakdown is empty or inconsistent.`);
    }
    if (!tableHasData(content, `${facet[0].toUpperCase()}${facet.slice(1)} calls`)) {
      return fail(`benchmark-${facet}-breakdown-empty`, `The disclosed ${facet} breakdown must contain data rows.`);
    }
  }
  if (!artifact.breakdowns.component.some((row) => row.name === "vibe") ||
      !artifact.breakdowns.component.some((row) => row.name === "fleet-orchestrator") ||
      !artifact.breakdowns.skill.some((row) => row.name !== "unobserved") ||
      !artifact.breakdowns.worker.some((row) => row.name !== "unobserved") ||
      !artifact.breakdowns.phase.some((row) => row.name !== "startup" && row.name !== "unobserved")) {
    return fail("benchmark-breakdown-unobserved", "Attached evidence must contain observed component, skill, worker and phase data.");
  }
  const evalHash = /^Full shared corpus: (\d+) cases; result hash `([0-9a-f]{64})`; plugin `([0-9a-f]{40})`\.$/m.exec(content);
  if (!evalHash || Number(evalHash[1]) !== artifact.eval.cases || evalHash[2] !== artifact.evalResultHash ||
      evalHash[3] !== input.headSha || artifact.eval.cases <= 0 || artifact.eval.runtimes.length !== 2 ||
      new Set(artifact.eval.runtimes.map((runtime) => runtime.runtime)).size !== 2 ||
      artifact.eval.runtimes.some((runtime) => runtime.failed !== 0 ||
        runtime.passed !== artifact.eval.cases)) {
    return fail("benchmark-evals-invalid", "Attached Claude and Codex eval evidence must be non-empty and fully passing.");
  }
  for (const runtimeResult of artifact.eval.runtimes) {
    const displayed = new RegExp(`^- ${runtimeResult.runtime}: (\\d+)\\/(\\d+) passed;`, "m").exec(content);
    if (!displayed || Number(displayed[1]) !== runtimeResult.passed ||
        Number(displayed[2]) !== artifact.eval.cases) {
      return fail("benchmark-evals-body-mismatch", "Disclosed eval counts must match the attached evidence.");
    }
  }
  return null;
}

function validateResult(input: BenchmarkGateInput, content: string): BenchmarkGateResult {
  const required: Array<[RegExp, string, string]> = [
    [/^Result: .+; hash: `(?:[0-9a-f]{64})`\.$/m, "benchmark-result-hash-missing", "Benchmark results must include the 64-character result hash."],
    [/^Claude Code \d+\.\d+\.\d+;/m, "benchmark-runtime-missing", "Benchmark results must identify the Claude Code version."],
    [/^Configured claude-sonnet-5-5 \/ high;/m, "benchmark-model-pin-missing", "Benchmark results must record claude-sonnet-5-5 at high effort."],
    [/^Wall \d+ ms .*; cost \$\d+(?:\.\d+)?; \d+ model calls\.$/m, "benchmark-wall-missing", "Benchmark results must include wall time, cost and model calls."],
    [/^Totals: input \d+, cached read \d+, uncached input \d+, cache write \d+, output \d+, thinking (?:\d+|unknown)\./m, "benchmark-totals-missing", "Benchmark results must include the complete token totals."],
    [/^### Component calls$/m, "benchmark-component-breakdown-missing", "Benchmark results must include the component breakdown."],
    [/^### Skill calls$/m, "benchmark-skill-breakdown-missing", "Benchmark results must include the skill breakdown."],
    [/^### Worker calls$/m, "benchmark-worker-breakdown-missing", "Benchmark results must include the worker breakdown."],
    [/^### Phase calls$/m, "benchmark-phase-breakdown-missing", "Benchmark results must include the phase breakdown."],
    [/^### Comparison with main$/m, "benchmark-comparison-table-missing", "Benchmark results must include the comparison with main."],
    [EVAL_EVIDENCE,
      "benchmark-evals-missing", "Benchmark results must include complete local Claude and Codex eval evidence."],
  ];
  for (const [pattern, code, message] of required) {
    if (!pattern.test(content)) return fail(code, message);
  }
  const status = /^Comparison: (green|yellow|red)\.$/m.exec(content)?.[1];
  if (!status) return fail("benchmark-comparison-status-missing", "Benchmark results must declare Comparison: green, yellow or red.");
  if (status === "yellow" && !/^### Regression explanations$[\s\S]*^- \S/m.test(content)) {
    return fail("benchmark-yellow-explanation-missing", "A yellow comparison requires at least one regression explanation.");
  }
  if (status === "red") {
    const problem = validateApproval(input, BENCHMARK_RED_ACCEPTANCE_LABEL);
    if (problem) return problem;
  } else if (input.labels.includes(BENCHMARK_RED_ACCEPTANCE_LABEL)) {
    return fail("benchmark-red-acceptance-stale", "Remove the red-regression acceptance label from a non-red result.");
  }
  const evidenceProblem = validateEvidence(input, content, status as "green" | "yellow" | "red");
  return evidenceProblem ?? pass(`benchmark-result-${status}`, `Benchmark disclosure is complete with a ${status} comparison.`);
}

/** Validate one live pull request without running a model or mutating GitHub state. */
export function validateBenchmarkDisclosure(input: BenchmarkGateInput): BenchmarkGateResult {
  if (!Number.isInteger(input.number) || input.number <= 0 || !FULL_SHA.test(input.headSha)) {
    return fail("benchmark-input-invalid", "Pull request identity is incomplete or malformed.");
  }
  if (!input.changedFiles.some(isBenchmarkProtectedPath)) {
    return pass("benchmark-out-of-scope", "No protected vibe benchmark path changed.");
  }
  const section = benchmarkSection(input.body);
  if ("status" in section) return section;
  const hasBypass = input.labels.includes(BENCHMARK_BYPASS_LABEL);
  const hasRedAcceptance = input.labels.includes(BENCHMARK_RED_ACCEPTANCE_LABEL);
  if (hasBypass && hasRedAcceptance) {
    return fail("benchmark-approval-label-conflict", "Bypass and red-regression acceptance labels cannot be present together.");
  }
  if (hasBypass) {
    if (/^Result:/m.test(section.content)) {
      return fail("benchmark-bypass-result-conflict", "A bypass section contains a reason instead of benchmark results.");
    }
    const reason = lineValue(section.content, "Bypassed");
    if (!reason) return fail("benchmark-bypass-reason-missing", "An approved bypass requires `Bypassed: <reason>`. ");
    const problem = validateApproval(input, BENCHMARK_BYPASS_LABEL);
    return problem ?? pass("benchmark-bypassed", `Benchmark bypass approved for head ${input.headSha}.`);
  }
  if (/^Bypassed:/m.test(section.content)) {
    return fail("benchmark-bypass-label-missing", "The benchmark approver must apply `benchmark-not-needed` for a bypass.");
  }
  return validateResult(input, section.content);
}
