import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fetchBenchmarkGateInput } from "./github-pr-gate.ts";
import { BENCHMARK_APPROVER_LOGIN, BENCHMARK_BYPASS_LABEL,
  BENCHMARK_EVIDENCE_MARKER, BENCHMARK_RED_ACCEPTANCE_LABEL,
  validateBenchmarkDisclosure } from "./pr-body-gate.ts";
import type { BenchmarkEvidenceArtifact, BenchmarkGateInput, GateTimelineEvent } from "./pr-body-gate.ts";

const HEAD = "a".repeat(40);
const forcePushPayload = JSON.parse(readFileSync(join(import.meta.dirname,
  "../fixtures/github-head-ref-force-pushed.json"), "utf8")) as Record<string, unknown>;

function resultSection(status: "green" | "yellow" | "red", extra = ""): string {
  return `## Benchmark

Result: success; hash: \`${"b".repeat(64)}\`.
Claude Code 2.1.311; plugin \`${HEAD}\`; vibe; task project-search-infix (1); fixture 1.
Configured claude-sonnet-5-5 / high; observed model claude-sonnet-5-5, observed effort high.
Wall 1000 ms (stack setup 100 ms, teardown 20 ms); cost $0.100000; 4 model calls.
Totals: input 100, cached read 50, uncached input 50, cache write 10, output 20, thinking unknown.

### Component calls

| component | calls |
| --- | --- |
| vibe | 4 |

### Skill calls

| skill | calls |
| --- | --- |
| unobserved | 4 |

### Worker calls

| worker | calls |
| --- | --- |
| vibe-change-worker | 4 |

### Phase calls

| phase | calls |
| --- | --- |
| build | 4 |

Comparison: ${status}.

### Comparison with main

| signal | status |
| --- | --- |
| wallMs | ${status} |

### Model-driven evals

Full shared corpus: 12 cases; result hash \`${"d".repeat(64)}\`; plugin \`${HEAD}\`.
- claude: 12/12 passed; CLI 2.1.311; native hash \`${"e".repeat(64)}\`.
- codex: 12/12 passed; CLI codex-cli; native hash \`${"f".repeat(64)}\`.
${extra}`;
}

function evidence(overrides: Partial<BenchmarkEvidenceArtifact> = {}): BenchmarkEvidenceArtifact {
  return {
    schemaVersion: 1, headSha: HEAD, resultHash: "b".repeat(64), evalResultHash: "d".repeat(64),
    cliVersion: "2.1.311 (Claude Code)", configuredModel: "claude-sonnet-5-5",
    configuredEffort: "high", valid: true, success: true, fullWallMs: 1000,
    costUsd: 0.1, modelCalls: 4,
    totals: { inputTokens: 100, uncachedInputTokens: 50, outputTokens: 20 },
    breakdowns: {
      component: [{ name: "vibe", calls: 3 }, { name: "fleet-orchestrator", calls: 1 }],
      skill: [{ name: "vibe:vibe", calls: 2 }, { name: "vibe:fleet-orchestrator", calls: 1 },
        { name: "unobserved", calls: 1 }],
      worker: [{ name: "vibe-change-worker", calls: 3 }, { name: "unobserved", calls: 1 }],
      phase: [{ name: "build", calls: 3 }, { name: "startup", calls: 1 }],
    },
    comparison: "green",
    eval: { pluginSha: HEAD, cases: 12, runtimes: [
      { runtime: "claude", passed: 12, failed: 0 },
      { runtime: "codex", passed: 12, failed: 0 },
    ] },
    ...overrides,
  };
}

function input(overrides: Partial<BenchmarkGateInput> = {}): BenchmarkGateInput {
  return { number: 123, headSha: HEAD, body: resultSection("green"),
    changedFiles: ["plugins/vibe/skills/vibe/SKILL.md"], labels: [], timelineEvents: [],
    evidenceArtifacts: [evidence()], ...overrides };
}

const evalEvidence = `
### Model-driven evals

Full shared corpus: 12 cases; result hash \`${"d".repeat(64)}\`; plugin \`${"c".repeat(40)}\`.
- claude: 12/12 passed; CLI 2.1.311; native hash \`${"e".repeat(64)}\`.
- codex: 12/12 passed; CLI codex-cli; native hash \`${"f".repeat(64)}\`.
`;

function event(eventName: "labeled" | "unlabeled", label: string,
  actor = BENCHMARK_APPROVER_LOGIN): GateTimelineEvent {
  return { event: eventName, label, actor };
}

test("only protected vibe surfaces require benchmark disclosure", () => {
  assert.equal(validateBenchmarkDisclosure(input({ body: "", changedFiles: ["plugins/code/README.md"] })).code,
    "benchmark-out-of-scope");
  for (const path of ["plugins/vibe/SKILL.md", "tools/vibe-bench/src/cli.ts",
    "tools/vibe-workers/src/cli.ts", ".github/workflows/vibe-benchmark-gate.yml",
    ".github/pull_request_template.md"]) {
    assert.equal(validateBenchmarkDisclosure(input({ body: "", changedFiles: [path] })).code,
      "benchmark-section-missing");
  }
});

test("rendered Benchmark section rejects hidden, duplicate and placeholder forms", () => {
  assert.equal(validateBenchmarkDisclosure(input({ body: "<!--\n## Benchmark\nvalid\n-->" })).code,
    "benchmark-section-missing");
  assert.equal(validateBenchmarkDisclosure(input({ body: "```md\n## Benchmark\nvalid\n```" })).code,
    "benchmark-section-missing");
  assert.equal(validateBenchmarkDisclosure(input({ body: "## Benchmark\nvalid\n## Benchmark\nvalid" })).code,
    "benchmark-section-duplicate");
  assert.equal(validateBenchmarkDisclosure(input({ body: "## Benchmark\r\n\r\nMeasurement pending" })).code,
    "benchmark-section-empty");
});

test("green and explained yellow result disclosures pass", () => {
  assert.equal(validateBenchmarkDisclosure(input()).code, "benchmark-result-green");
  assert.equal(validateBenchmarkDisclosure(input({ body: resultSection("yellow"),
    evidenceArtifacts: [evidence({ comparison: "yellow" })] })).code,
    "benchmark-yellow-explanation-missing");
  const explained = resultSection("yellow", "\n### Regression explanations\n\n- wallMs (yellow): measured setup work.\n");
  assert.equal(validateBenchmarkDisclosure(input({ body: explained,
    evidenceArtifacts: [evidence({ comparison: "yellow" })] })).code, "benchmark-result-yellow");
  assert.equal(validateBenchmarkDisclosure(input({ body: resultSection("green").replace(
    "Configured claude-sonnet-5-5 / high", "Configured claude-opus-5-5 / high") })).code,
    "benchmark-model-pin-missing");
});

test("fabricated disclosure, empty evidence and failing evals fail closed", () => {
  assert.equal(validateBenchmarkDisclosure(input({ evidenceArtifacts: [] })).code,
    "benchmark-evidence-missing");
  assert.equal(validateBenchmarkDisclosure(input({ evidenceArtifacts: [evidence({ modelCalls: 0 })] })).code,
    "benchmark-evidence-totals-invalid");
  const empty = evidence();
  empty.breakdowns.worker = [];
  assert.equal(validateBenchmarkDisclosure(input({ evidenceArtifacts: [empty] })).code,
    "benchmark-worker-breakdown-invalid");
  const shapeDefault = evidence();
  shapeDefault.breakdowns.skill = [
    { name: "vibe:vibe", calls: 3 }, { name: "vibe:fleet-orchestrator", calls: 1 },
  ];
  assert.equal(validateBenchmarkDisclosure(input({ evidenceArtifacts: [shapeDefault] })).code,
    "benchmark-skill-breakdown-default-only");
  const failed = evidence();
  failed.eval.runtimes[0] = { runtime: "claude", passed: 11, failed: 1 };
  assert.equal(validateBenchmarkDisclosure(input({ evidenceArtifacts: [failed] })).code,
    "benchmark-evals-invalid");
  const zeroBody = resultSection("green")
    .replace("Wall 1000 ms", "Wall 0 ms")
    .replace("cost $0.100000; 4 model calls", "cost $0; 0 model calls")
    .replace("Totals: input 100, cached read 50, uncached input 50, cache write 10, output 20",
      "Totals: input 0, cached read 0, uncached input 0, cache write 0, output 0");
  assert.equal(validateBenchmarkDisclosure(input({ body: zeroBody })).code,
    "benchmark-evidence-body-mismatch");
  const failedBody = resultSection("green").replace("- codex: 12/12 passed", "- codex: 0/12 passed");
  assert.equal(validateBenchmarkDisclosure(input({ body: failedBody })).code,
    "benchmark-evals-body-mismatch");
});

test("bypass requires the approver's latest label event and reason, without paid evidence", () => {
  const body = `## Benchmark\n\nBypassed: Documentation-only wording fix.\nBypass head: ${HEAD}\n`;
  assert.equal(validateBenchmarkDisclosure(input({ body })).code, "benchmark-bypass-label-missing");
  assert.equal(validateBenchmarkDisclosure(input({ body, labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_BYPASS_LABEL, "other-maintainer")] })).code,
  "benchmark-approval-actor-invalid");
  assert.equal(validateBenchmarkDisclosure(input({ body, labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_BYPASS_LABEL), event("unlabeled", BENCHMARK_BYPASS_LABEL)] })).code,
  "benchmark-approval-actor-invalid");
  assert.equal(validateBenchmarkDisclosure(input({ body, labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_BYPASS_LABEL),
      { event: "committed", sha: HEAD }] })).code, "benchmark-approval-label-stale");
  assert.equal(validateBenchmarkDisclosure(input({ body, labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [{ event: "committed", sha: HEAD },
      event("labeled", BENCHMARK_BYPASS_LABEL)] })).code, "benchmark-bypassed");
  assert.equal(validateBenchmarkDisclosure(input({ body, labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_BYPASS_LABEL)] })).code, "benchmark-bypassed");
  assert.equal(validateBenchmarkDisclosure(input({ body: body.replace(HEAD, "c".repeat(40)),
    labels: [BENCHMARK_BYPASS_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_BYPASS_LABEL)] })).code,
  "benchmark-bypass-head-mismatch");
});

test("red comparison requires current-head approver acceptance and conflicts fail", () => {
  assert.equal(validateBenchmarkDisclosure(input({ body: resultSection("red"),
    evidenceArtifacts: [evidence({ comparison: "red" })] })).code,
    "benchmark-approval-label-missing");
  const accepted = `${resultSection("red")}\nRegression acceptance head: ${HEAD}\n`;
  assert.equal(validateBenchmarkDisclosure(input({ body: `${resultSection("red")}\nRegression acceptance head: ${"c".repeat(40)}\n`,
    labels: [BENCHMARK_RED_ACCEPTANCE_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_RED_ACCEPTANCE_LABEL)],
    evidenceArtifacts: [evidence({ comparison: "red" })] })).code,
  "benchmark-red-acceptance-head-mismatch");
  assert.equal(validateBenchmarkDisclosure(input({ body: accepted,
    labels: [BENCHMARK_RED_ACCEPTANCE_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_RED_ACCEPTANCE_LABEL)],
    evidenceArtifacts: [evidence({ comparison: "red" })] })).code,
  "benchmark-result-red");
  assert.equal(validateBenchmarkDisclosure(input({ labels: [BENCHMARK_RED_ACCEPTANCE_LABEL],
    timelineEvents: [event("labeled", BENCHMARK_RED_ACCEPTANCE_LABEL)] })).code,
  "benchmark-red-acceptance-stale");
  assert.equal(validateBenchmarkDisclosure(input({ body: "## Benchmark\nBypassed: reason\nBypass head: " + HEAD + evalEvidence,
    labels: [BENCHMARK_BYPASS_LABEL, BENCHMARK_RED_ACCEPTANCE_LABEL] })).code,
  "benchmark-approval-label-conflict");
});

test("GitHub adapter paginates files and timeline and preserves renamed protected paths", async () => {
  const root = "https://api.github.com/repos/closedloop-ai/claude-plugins";
  const seen: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    seen.push(url);
    if (url === `${root}/pulls/123`) return Response.json({ body: "", head: { sha: HEAD }, user: { login: "author" },
      labels: [{ name: BENCHMARK_BYPASS_LABEL }] });
    if (url === `${root}/pulls/123/files?per_page=100`) return Response.json(
      [{ filename: "docs/new.md", previous_filename: "plugins/vibe/old.md" }], { headers: {
        Link: `<${root}/pulls/123/files?per_page=100&page=2>; rel="next"`,
      } });
    if (url === `${root}/pulls/123/files?per_page=100&page=2`) return Response.json(
      [{ filename: "docs/second.md" }]);
    if (url === `${root}/issues/123/timeline?per_page=100`) return Response.json([
      { event: "labeled", label: { name: "unrelated" }, actor: { login: "somebody" } },
      { event: "committed", sha: "d".repeat(40) },
      { event: "labeled", label: { name: BENCHMARK_BYPASS_LABEL }, actor: { login: BENCHMARK_APPROVER_LOGIN } },
      forcePushPayload,
    ]);
    if (url === `${root}/issues/123/comments?per_page=100`) return Response.json([
      { user: { login: "author" }, body: `${BENCHMARK_EVIDENCE_MARKER}\n\n\`\`\`json\n${JSON.stringify(evidence())}\n\`\`\`` },
    ]);
    return Response.json({ message: "not found" }, { status: 404 });
  };
  const value = await fetchBenchmarkGateInput("closedloop-ai/claude-plugins", 123, "token", fetcher);
  assert.deepEqual(value.changedFiles, ["docs/new.md", "docs/second.md", "plugins/vibe/old.md"]);
  assert.deepEqual(value.timelineEvents, [{ event: "committed", sha: "d".repeat(40) },
    event("labeled", BENCHMARK_BYPASS_LABEL), { event: "head_ref_force_pushed", sha: HEAD }]);
  assert.equal(value.evidenceArtifacts[0].resultHash, "b".repeat(64));
  assert.equal(seen.length, 5);
  await assert.rejects(() => fetchBenchmarkGateInput("closedloop-ai/claude-plugins", 123, "token",
    async (url) => url.endsWith("/pulls/123") ? Response.json({ body: null, head: { sha: HEAD },
      user: { login: "author" }, labels: [] })
      : Response.json({}, { status: 200 })), /page-invalid/);
});

test("GitHub adapter accepts evidence only from the author or a collaborator with write access", async () => {
  const root = "https://api.github.com/repos/closedloop-ai/claude-plugins";
  const marker = (body: string) => `${BENCHMARK_EVIDENCE_MARKER}\n\n${body}`;
  const valid = marker(`\`\`\`json\n${JSON.stringify(evidence())}\n\`\`\``);
  const fetcher = async (url: string): Promise<Response> => {
    if (url === `${root}/pulls/123`) return Response.json({ body: "", head: { sha: HEAD },
      user: { login: "author" }, labels: [] });
    if (url.endsWith("/files?per_page=100") || url.endsWith("/timeline?per_page=100")) return Response.json([]);
    if (url.endsWith("/comments?per_page=100")) return Response.json([
      { user: { login: "outsider" }, body: marker("malformed outside evidence") },
      { user: { login: "reader" }, body: valid },
      { user: { login: "writer" }, body: valid },
      { user: { login: "author" }, body: valid },
    ]);
    if (url.endsWith("/collaborators/outsider/permission")) return Response.json({ message: "not found" }, { status: 404 });
    if (url.endsWith("/collaborators/reader/permission")) return Response.json({ permission: "read" });
    if (url.endsWith("/collaborators/writer/permission")) return Response.json({ permission: "write" });
    return Response.json({ message: "not found" }, { status: 404 });
  };
  const value = await fetchBenchmarkGateInput("closedloop-ai/claude-plugins", 123, "token", fetcher);
  assert.equal(value.evidenceArtifacts.length, 2);
  await assert.rejects(() => fetchBenchmarkGateInput("closedloop-ai/claude-plugins", 123, "token",
    async (url) => url.endsWith("/collaborators/writer/permission")
      ? Response.json({ message: "forbidden" }, { status: 403 }) : fetcher(url)), /github-http:403/);
});

test("workflow executes only trusted base code with read permissions and no model command", () => {
  const workflow = readFileSync(join(import.meta.dirname, "../../../.github/workflows/vibe-benchmark-gate.yml"), "utf8");
  assert.match(workflow, /^\s*pull_request_target:/m);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /contents: read[\s\S]*issues: read[\s\S]*pull-requests: read/);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*\bwrite\b/);
  assert.doesNotMatch(workflow, /pull_request\.head|\bclaude\b|\bcodex\b/i);
});
