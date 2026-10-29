/** GitHub label that permits Daniel to waive a benchmark run for one head SHA. */
export const BENCHMARK_BYPASS_LABEL = "benchmark-not-needed";
/** GitHub label that records Daniel's acceptance of one red result at one head SHA. */
export const BENCHMARK_RED_ACCEPTANCE_LABEL = "benchmark-regression-accepted";
/** Daniel Ochoa's GitHub login, verified through the authenticated GitHub API on 2026-10-29. */
export const BENCHMARK_APPROVER_LOGIN = "shafty023";

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

function validateApproval(input: BenchmarkGateInput, content: string, label: string,
  headField: string): BenchmarkGateResult | null {
  if (!input.labels.includes(label)) return fail("benchmark-approval-label-missing", `Daniel must apply \`${label}\` for this head.`);
  const latest = latestLabelEvent(input, label);
  if (latest?.actor !== BENCHMARK_APPROVER_LOGIN) {
    return fail("benchmark-approval-actor-invalid", `The latest \`${label}\` event must be from Daniel.`);
  }
  if (input.timelineEvents.slice(latest.index + 1).some((item) =>
      item.event === "committed" || item.event === "head_ref_force_pushed")) {
    return fail("benchmark-approval-label-stale", `Daniel must reapply \`${label}\` after the latest head change.`);
  }
  const head = lineValue(content, headField);
  if (!head || !FULL_SHA.test(head) || head !== input.headSha) {
    return fail("benchmark-approval-head-stale", `${headField} must equal the current full head SHA.`);
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
    const problem = validateApproval(input, content, BENCHMARK_RED_ACCEPTANCE_LABEL, "Regression acceptance head");
    if (problem) return problem;
  } else if (input.labels.includes(BENCHMARK_RED_ACCEPTANCE_LABEL)) {
    return fail("benchmark-red-acceptance-stale", "Remove the red-regression acceptance label from a non-red result.");
  }
  return pass(`benchmark-result-${status}`, `Benchmark disclosure is complete with a ${status} comparison.`);
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
    if (!EVAL_EVIDENCE.test(section.content)) {
      return fail("benchmark-evals-missing", "A benchmark bypass still requires complete local Claude and Codex eval evidence.");
    }
    const problem = validateApproval(input, section.content, BENCHMARK_BYPASS_LABEL, "Bypass head");
    return problem ?? pass("benchmark-bypassed", `Benchmark bypass approved by Daniel for head ${input.headSha}.`);
  }
  if (/^Bypassed:/m.test(section.content)) {
    return fail("benchmark-bypass-label-missing", "Daniel must apply `benchmark-not-needed` for a bypass.");
  }
  return validateResult(input, section.content);
}
