import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEvalBaseline, evalBaselineFileName } from "./eval-baseline.ts";
import type { EvalBaselineArtifact } from "./eval-baseline.ts";
import type { LocalEvalResult } from "./eval-collector.ts";
import { EVAL_POLICY } from "./eval-policy.ts";
import { publishCompletedNightly, reportNightlyInfrastructureFailure } from "./eval-nightly.ts";
import { comparePublicEvalResults, projectPublicEvalResult,
  localRunForCompare, validatePublicEvalResult } from "./eval-public-result.ts";
import type { PublicEvalResult } from "./eval-public-result.ts";
import { projectForRun, publishNightlyEval, SystemEvalPublishAdapter,
  waitForPassingCi } from "./eval-publish.ts";
import type { EvalPublishAdapter } from "./eval-publish.ts";
import { main as benchMain } from "./cli.ts";
import { queueCompletedNightlyResult, recoverPublicNightlyResults } from "./eval-publication-journal.ts";

const ROOT = join(import.meta.dirname, "../../..");
const PUBLIC = JSON.parse(readFileSync(join(ROOT,
  "evals/results/vibe/1.1.39/2026-11-04.json"), "utf8")) as PublicEvalResult;
const SHA = "a".repeat(40);

function hashed(input: Omit<LocalEvalResult, "resultHash">): LocalEvalResult {
  return { ...input, resultHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}

function localResult(runtimes: LocalEvalResult["runtimes"], selectedCases: string[]): LocalEvalResult {
  return hashed({ schemaVersion: 1, pluginSha: SHA, createdAt: "2026-11-04T23:12:00Z",
    wallMs: 100, deterministicOnly: false, selectedCases, runtimes,
    success: runtimes.every((item) => item.result?.failed === 0 && !item.invalidReason) });
}

function suite(runtime: "claude" | "codex", cases: Array<{ id: string; passed: boolean;
  unavailableReason?: string }>): LocalEvalResult["runtimes"][number] {
  return { runtime, exitCode: cases.some((item) => !item.passed && !item.unavailableReason) ? 1 : 0,
    invalidReason: null, result: { runtime, cliVersion: "1",
    model: runtime === "codex" ? EVAL_POLICY.codexModel : EVAL_POLICY.claudeModel,
    ...(runtime === "codex" ? { judgeModel: EVAL_POLICY.codexJudgeModel } : {}),
    cases: cases.map((item) => ({ ...item, failedGraders: [], skippedGraders: [] })),
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed && !item.unavailableReason).length,
    wallMs: 100, agentCostUsd: null, judgeCostUsd: null, costUsd: null,
    tokens: null, nativeHash: "b".repeat(64) } };
}

function publicResult(): PublicEvalResult {
  return { schemaVersion: 1, pluginVersion: "1.1.39", pluginSha: SHA,
    runAt: "2026-11-04T23:12:00Z",
    models: { ...PUBLIC.models, codex: EVAL_POLICY.codexModel },
    runtimes: [{ runtime: "claude", cases: [{ id: "case-a", status: "pass", retryCount: 0 },
      { id: "case-b", status: "fail", retryCount: 1 }] },
    { runtime: "codex", cases: [{ id: "case-a", status: "pass", retryCount: 0 },
      { id: "case-b", status: "unavailable", retryCount: 0 }] }] };
}

async function withSyntheticBaselines(run: (fixture: { repo: string; olderFile: string;
  newerFile: string; latestFile: string; newer: PublicEvalResult }) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "eval-baseline-history-"));
  try {
    const root = join(repo, "evals/results/vibe");
    const version = join(root, "1.1.39");
    mkdirSync(version, { recursive: true });
    const older = structuredClone(publicResult());
    older.runtimes[0]!.cases[1]!.status = "pass";
    older.runtimes[0]!.cases[1]!.retryCount = 0;
    older.runtimes[1]!.cases[1]!.status = "pass";
    const newer = publicResult();
    newer.runAt = "2026-11-05T23:12:00Z";
    const olderFile = join(version, "2026-11-04.json");
    const newerFile = join(version, "2026-11-05.json");
    const latestFile = join(root, "latest.json");
    writeFileSync(olderFile, JSON.stringify(older));
    writeFileSync(newerFile, JSON.stringify(newer));
    writeFileSync(latestFile, JSON.stringify(newer));
    await run({ repo, olderFile, newerFile, latestFile, newer });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

test("AC-003 AC-010 immutable first baseline contains only allowed fields and correct counts", () => {
  validatePublicEvalResult(PUBLIC);
  const actual = PUBLIC.runtimes.flatMap((runtime) => runtime.cases).reduce((sum, item) => {
    sum[item.status] += 1;
    return sum;
  }, { pass: 0, fail: 0, unavailable: 0 });
  assert.deepEqual(actual, { pass: 222, fail: 24, unavailable: 0 });
  assert.equal(PUBLIC.runAt, "2026-11-04T23:12:00Z");
  assert.equal(PUBLIC.pluginVersion, "1.1.39");
  assert.match(PUBLIC.pluginSha, /^bdc8ee86/);
  const seenKeys: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { seenKeys.push(key); visit(child); }
  };
  visit(PUBLIC);
  for (const forbidden of ["transcript", "prompt", "output", "username", "hostname",
    "email", "slack", "token", "localPath"]) {
    assert.equal(seenKeys.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(JSON.stringify(PUBLIC), /\/Users\/|@|sk_live_/);
});

test("AC-002 latest is a moving validated pointer; a second all-pass night remains valid", () => {
  validatePublicEvalResult(JSON.parse(readFileSync(join(ROOT, "evals/results/vibe/latest.json"),
    "utf8")) as unknown);
  const second = structuredClone(PUBLIC);
  second.runAt = "2026-11-05T23:12:00Z";
  for (const runtime of second.runtimes) for (const item of runtime.cases) item.status = "pass";
  validatePublicEvalResult(second);
  assert.equal(second.runtimes.flatMap((runtime) => runtime.cases)
    .filter((item) => item.status === "fail").length, 0);
  assert.equal(comparePublicEvalResults(second, second), "No changed cases");
});

test("AC-003 leak guard rejects extra fields and private-looking values", () => {
  for (const field of ["transcript", "prompt", "output", "localPath", "email", "token"]) {
    const bad = structuredClone(publicResult()) as PublicEvalResult & Record<string, unknown>;
    bad[field] = "private";
    assert.throws(() => validatePublicEvalResult(bad), /not-allowlisted/);
  }
  const email = structuredClone(publicResult());
  email.runtimes[0]!.cases[0]!.id = "person@example.com";
  assert.throws(() => validatePublicEvalResult(email), /case-invalid/);
  const path = structuredClone(publicResult());
  path.models.claude = "/Users/private/model";
  assert.throws(() => validatePublicEvalResult(path), /model-invalid/);
  const host = structuredClone(publicResult());
  host.models.codex = "build-host.internal";
  assert.throws(() => validatePublicEvalResult(host), /model-invalid/);
  const nested = structuredClone(publicResult()) as PublicEvalResult & Record<string, unknown>;
  (nested.runtimes[0]!.cases[0] as Record<string, unknown>).prompt = "private content";
  assert.throws(() => validatePublicEvalResult(nested), /not-allowlisted/);
  for (const invalid of [["pass"], { toString: () => "pass" }]) {
    const coerced = structuredClone(publicResult());
    (coerced.runtimes[0]!.cases[0] as Record<string, unknown>).status = invalid;
    assert.throws(() => validatePublicEvalResult(coerced), /case-invalid/);
    assert.throws(() => comparePublicEvalResults(publicResult(), coerced), /case-invalid/);
  }
});

test("AC-003 AC-009 projection derives retry counts and preserves unavailable", () => {
  const initial = localResult([suite("claude", [{ id: "case-a", passed: true },
    { id: "case-b", passed: false }]), suite("codex", [{ id: "case-a", passed: true },
    { id: "case-b", passed: false, unavailableReason: "NO_VALID_PRIOR" }])],
  ["case-a", "case-b"]);
  const retry = localResult([suite("claude", [{ id: "case-b", passed: false }])], ["case-b"]);
  const availability = (status: "observed" | "unavailable", passes: number) => ({
    observations: status === "observed" ? 1 : 0, passes,
    passRate: passes, reliable: false, nightlies: 1,
    recentNightlyOutcomes: status === "observed" ? [{ passes, runs: 1 }] : [],
    latestAvailability: status === "observed" ? { status } : { status, reason: "NO_VALID_PRIOR" },
  });
  const baseline = { pluginSha: SHA, pluginVersion: "1.1.39",
    models: { ...PUBLIC.models, codex: EVAL_POLICY.codexModel },
    sourceResultHashes: [initial.resultHash, retry.resultHash], costs: {},
    cases: [{ id: "case-a", outcomes: { claude: availability("observed", 1),
      codex: availability("observed", 1) } },
    { id: "case-b", outcomes: { claude: availability("observed", 0),
      codex: availability("unavailable", 0) } }] } as unknown as EvalBaselineArtifact;
  const projected = projectPublicEvalResult(baseline, [initial, retry], "2026-11-04T23:12:00Z");
  assert.deepEqual(projected.runtimes[0]!.cases, [{ id: "case-a", status: "pass", retryCount: 0 },
    { id: "case-b", status: "fail", retryCount: 1 }]);
  assert.deepEqual(projected.runtimes[1]!.cases[1],
    { id: "case-b", status: "unavailable", retryCount: 0 });
  assert.throws(() => projectPublicEvalResult(baseline, [retry, initial],
    "2026-11-04T23:12:00Z"), /source-results-mismatch/);
});

test("AC-001 real-shape SKIPPED schedules only prior recovery", async () => {
  let calls = 0;
  const result = await publishCompletedNightly("SKIPPED /private/eval-t2-latest.json",
    ["/repo", "/runs", "/results", "claude", "codex", "uv", "gh"],
    "2026-11-04T23:12:00Z", async (command) => {
      calls += 1;
      assert.ok(command.includes("RECOVER"));
      assert.equal(command.includes("/private/eval-t2-latest.json"), false);
      return "VIBE_NIGHTLY_PUBLISH_NONE";
    });
  assert.equal(result, "VIBE_NIGHTLY_PUBLISH_NONE");
  assert.equal(calls, 1);
});

test("AC-002 updated child owns projection after parent fast-forward", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-policy-lineage-"));
  try {
    const path = join(root, "eval-t2-new-lineage.json");
    writeFileSync(path, JSON.stringify({ models: { ...PUBLIC.models, codex: "gpt-7" } }));
    const args = [root, root, root, "claude", "codex", "uv", "gh"];
    let command: string[] = [];
    const output = await publishCompletedNightly(path, args,
      "2026-11-05T23:12:00Z", async (child) => {
        command = child;
        assert.equal(JSON.parse(readFileSync(child[6]!, "utf8")).models.codex, "gpt-7");
        return "VIBE_NIGHTLY_PUBLISH_MERGED ISS-1 https://github.com/example/repo/pull/1";
      });
    assert.match(output, /PUBLISH_MERGED/);
    assert.ok(command.includes("eval-publish"));
    assert.ok(command.includes("2026-11-05T23:12:00Z"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC-003 publisher errors expose only fixed reasons to stderr and Slack", async () => {
  const args = ["/repo", "/runs", "/results", "claude", "codex", "uv", "gh"];
  let reason = "";
  await assert.rejects(publishCompletedNightly("/Users/private/eval-t2-secret.json", args,
    "2026-11-05T23:12:00Z", async () => {
      throw new Error("ENOENT /Users/private/eval-t2-secret.json token=sk_live_private");
    }), (error: Error) => {
    reason = error.message;
    return reason === "eval-publish-input-invalid";
  });
  const lines: string[] = [];
  let slack = "";
  await reportNightlyInfrastructureFailure(reason, { reportInfrastructure: async (notice) => {
    slack = notice.reason;
  } }, (line) => lines.push(line), (line) => lines.push(line));
  assert.equal(slack, "eval-publish-input-invalid");
  assert.doesNotMatch(lines.join(""), /\/Users\/|private\.json|sk_live_/);
});

test("AC-003 actual eval-publish CLI redacts malformed JSON and its private path", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-private-error-"));
  try {
    const path = join(root, "eval-t2-private.json");
    writeFileSync(path, '{"private":"/Users/secret",');
    const cli = join(ROOT, "tools/vibe-bench/src/cli.ts");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", cli, "eval-publish",
      root, root, root, path, "2026-11-05T23:12:00Z", "uv", "gh"],
    { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^eval-publish-input-invalid\n$/);
    assert.doesNotMatch(run.stderr, /\/Users\/|private\.json|eval-private-error/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC-009 compare reports new pass/failure and leaves unavailable distinct", () => {
  const current = structuredClone(publicResult());
  current.runtimes[0]!.cases[0]!.status = "fail";
  current.runtimes[0]!.cases[1]!.status = "pass";
  current.runtimes[1]!.cases[1]!.status = "fail";
  const output = comparePublicEvalResults(publicResult(), current);
  assert.match(output, /new failure claude case-a/);
  assert.match(output, /new pass claude case-b/);
  assert.match(output, /unavailable codex case-b \(unavailable -> fail\)/);
  assert.doesNotMatch(output, /new failure codex case-b/);
});

test("AC-009 single-runtime local result compares only present pairs; new cases are omitted", () => {
  const local = localResult([suite("claude", [{ id: "case-a", passed: false },
    { id: "case-new", passed: false }])], ["case-a", "case-new"]);
  const output = comparePublicEvalResults(publicResult(), localRunForCompare(local, publicResult()));
  assert.match(output, /new failure claude case-a/);
  assert.doesNotMatch(output, /case-new|codex/);
});

test("AC-009 CLI accepts a one-runtime local upgrade result", async () => {
  await withSyntheticBaselines(async ({ repo, newer }) => {
    const item = newer.runtimes[0]!.cases[0]!;
    const local = localResult([suite("claude", [{ id: item.id, passed: false }])], [item.id]);
    const path = join(repo, "local.json");
    writeFileSync(path, JSON.stringify(local));
    const output = await benchMain(["compare", path, "--baseline", "1.1.39"], repo);
    assert.match(output, /new failure claude case-a/);
    assert.doesNotMatch(output, /codex/);
  });
});

test("AC-009 CLI selects newest dated result within the same version", async () => {
  await withSyntheticBaselines(async ({ repo, olderFile, newerFile, latestFile }) => {
    assert.equal(await benchMain(["compare", latestFile], repo), "No changed cases");
    assert.equal(await benchMain(["compare", newerFile, "--baseline", "1.1.39"], repo),
      "No changed cases");
    const changed = await benchMain(["compare", olderFile, "--baseline", "1.1.39"], repo);
    assert.match(changed, /new pass claude case-b/);
    assert.match(changed, /unavailable codex case-b/);
    await assert.rejects(benchMain(["compare", latestFile, "--baseline", "../private"], repo),
      /eval-compare-baseline-invalid/);
    await assert.rejects(benchMain(["compare", latestFile, latestFile, "0", "0", "/tmp",
      "wrong-shape"], repo), /benchmark-shape-invalid/);
  });
});

test("AC-009 CLI accepts a private local-run artifact without printing its private fields", async () => {
  await withSyntheticBaselines(async ({ repo }) => {
    const failed = "case-b";
    const passed = "case-a";
    const local = localResult([suite("claude", [{ id: failed, passed: true },
      { id: passed, passed: false }]), suite("codex", [{ id: failed, passed: true },
      { id: passed, passed: false }])], [failed, passed]);
    const file = join(repo, "local.json");
    writeFileSync(file, JSON.stringify(local));
    const output = await benchMain(["compare", file, "--baseline", "1.1.39"], repo);
    assert.match(output, new RegExp(`new pass claude ${failed}`));
    assert.match(output, new RegExp(`new failure claude ${passed}`));
    assert.doesNotMatch(output, /nativeHash|failedGraders|\/tmp\//);
  });
});

test("AC-004 current-week project is resolved from run date", () => {
  assert.deepEqual(projectForRun([{ id: "old", name: "10/26-10/30" },
    { id: "current", name: "11/2-11/6" }], "2026-11-04T23:12:00Z"),
  { id: "current", name: "11/2-11/6" });
  assert.throws(() => projectForRun([{ id: "old", name: "10/26-10/30" }],
    "2026-11-04T23:12:00Z"), /project-unavailable/);
});

class FakeAdapter implements EvalPublishAdapter {
  time = 0;
  state = "OPEN";
  status = "IN_PROGRESS";
  content = "Initial summary.\n";
  staged = "evals/results/vibe/1.1.39/2026-11-04.json\n" +
    "evals/results/vibe/latest.json";
  checkBuckets: string[] = ["pass"];
  worktree = "";
  merged = false;
  createdPr = false;
  createdTicket = false;
  remoteBranch = false;
  existingPr = false;
  tamperContent = false;
  tamperWhitespace = false;
  symlinkMode = false;
  headOverride = "";
  failPrCreateOnce = false;
  symlinkResults = false;
  calls: string[] = [];
  git(_repo: string, args: string[]): string {
    this.calls.push(`git ${args[0]} ${args[1] ?? ""}`);
    if (args[0] === "worktree" && args[1] === "add") {
      this.worktree = args[3]!;
      mkdirSync(this.worktree);
      if (this.symlinkResults) {
        mkdirSync(join(this.worktree, "evals"));
        symlinkSync(join(this.worktree, "elsewhere"), join(this.worktree, "evals/results"));
      }
    }
    if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") return this.staged;
    if (args[0] === "diff" && args[1] === "--name-only") return this.staged;
    if (args[0] === "diff-tree") return this.staged;
    if (args[0] === "ls-remote") return this.remoteBranch ? `${SHA}\trefs/heads/recovered` : "";
    if (args[0] === "ls-tree") return `${this.symlinkMode ? "120000" : "100644"} blob ` +
      `${"b".repeat(40)}\t${args.at(-1)}`;
    if (args[0] === "rev-parse") return SHA;
    if (args[0] === "push") this.remoteBranch = true;
    if (args[0] === "worktree" && args[1] === "remove") rmSync(args[2]!, { recursive: true });
    return "";
  }
  gitBlob(): string {
    return `${JSON.stringify(this.tamperContent
      ? { ...publicResult(), transcript: "private-data" } : publicResult(), null, 2)}\n` +
      (this.tamperWhitespace ? " " : "");
  }
  gh(_repo: string, args: string[]): string {
    this.calls.push(`gh ${args[0]} ${args[1] ?? ""}`);
    if (args[0] === "repo" && args[1] === "view") {
      return JSON.stringify({ nameWithOwner: "closedloop-ai/claude-plugins" });
    }
    if (args[0] === "pr" && args[1] === "list") return this.existingPr
      ? JSON.stringify([{ url: "https://github.com/closedloop-ai/claude-plugins/pull/999" }]) : "[]";
    if (args[0] === "pr" && args[1] === "create") {
      if (this.failPrCreateOnce) { this.failPrCreateOnce = false; throw new Error("create failed"); }
      this.createdPr = true;
      this.existingPr = true;
      return "https://github.com/closedloop-ai/claude-plugins/pull/999";
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 999,
      url: "https://github.com/closedloop-ai/claude-plugins/pull/999", state: this.state,
      headRefOid: this.headOverride || SHA, baseRefName: "main",
      headRefName: "vibe-eval-1.1.39-2026-11-04-aaaaaaaa",
      headRepository: { nameWithOwner: "closedloop-ai/claude-plugins" },
      files: [{ path: "evals/results/vibe/1.1.39/2026-11-04.json" },
        { path: "evals/results/vibe/latest.json" }] });
    if (args[0] === "pr" && args[1] === "merge") { this.state = "MERGED"; this.merged = true; }
    return "";
  }
  checks(): Array<{ bucket: string }> { return this.checkBuckets.map((bucket) => ({ bucket })); }
  async closedLoop(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(`cl ${operation}`);
    if (operation === "list-projects") return { items: [{ id: "project", name: "11/2-11/6" }] };
    if (operation === "list-documents") return { items: this.createdTicket
      ? [{ id: "ticket", slug: "ISS-999", title: "Vibe eval 1.1.39 2026-11-04 aaaaaaaa" }] : [] };
    if (operation === "create-document") {
      this.createdTicket = true;
      return { id: "ticket", slug: "ISS-999", title: args.title };
    }
    if (operation === "get-document") return { version: { content: this.content } };
    if (operation === "create-document-version") { this.content = args.content as string; return {}; }
    if (operation === "update-document") { this.status = args.status as string; return {}; }
    throw new Error("unexpected tool");
  }
  now(): number { return this.time; }
  async wait(ms: number): Promise<void> { this.time += ms; }
}

async function withPublication(adapter: FakeAdapter, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "eval-publish-test-"));
  try { await run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("AC-005 AC-006 AC-007 green CI gates merge, DONE, and worktree cleanup", async () => {
  const adapter = new FakeAdapter();
  await withPublication(adapter, async (runRoot) => {
    const outcome = await publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter);
    assert.equal(outcome.outcome, "merged");
    assert.equal(adapter.status, "DONE");
    assert.equal(adapter.merged, true);
    assert.equal(adapter.createdPr, true);
    assert.equal(adapter.calls.includes("git worktree remove"), true);
    assert.match(adapter.content, /Merged PR: https:\/\/github.com/);
  });
});

test("AC-006 red and timed-out CI leave PR and ticket open", async () => {
  for (const [bucket, expected] of [["fail", "ci-red"], ["pending", "ci-timeout"]]) {
    const adapter = new FakeAdapter();
    adapter.checkBuckets = [bucket!];
    await withPublication(adapter, async (runRoot) => {
      const outcome = await publishNightlyEval({ repo: runRoot, runRoot,
        result: publicResult() }, adapter);
      assert.equal(outcome.outcome, expected);
      assert.equal(adapter.merged, false);
      assert.equal(adapter.status, "IN_PROGRESS");
      assert.match(adapter.content, new RegExp(bucket === "fail" ? "CI red" : "CI timeout"));
    });
  }
});

test("AC-005 path guard rejects a staged non-result file before push or PR", async () => {
  const adapter = new FakeAdapter();
  adapter.staged += "\nplugins/vibe/private.json";
  await withPublication(adapter, async (runRoot) => {
    await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter), /staged-path-invalid/);
    assert.equal(adapter.createdPr, false);
    assert.equal(adapter.calls.some((call) => call === "git push origin"), false);
  });
});

test("AC-003 symlinked result root is rejected before any write or PR", async () => {
  const adapter = new FakeAdapter();
  adapter.symlinkResults = true;
  await withPublication(adapter, async (runRoot) => {
    await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter), /symlink-invalid/);
    assert.equal(adapter.createdPr, false);
  });
});

test("AC-006 no checks never counts as CI green", async () => {
  const adapter = new FakeAdapter();
  adapter.checkBuckets = [];
  assert.equal(await waitForPassingCi(adapter, "/repo", 999), "timeout");
});

test("AC-006 gh red exit still reports its JSON failure bucket", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-ci-test-"));
  try {
    const gh = join(root, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '[{\"bucket\":\"fail\"}]'\nexit 1\n");
    chmodSync(gh, 0o755);
    assert.deepEqual(new SystemEvalPublishAdapter(gh, "/unused").checks(root, 99),
      [{ bucket: "fail" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC-004 AC-005 partial PR creation failure reuses ticket and verified remote branch", async () => {
  const adapter = new FakeAdapter();
  adapter.failPrCreateOnce = true;
  await withPublication(adapter, async (runRoot) => {
    await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter), /pr-create-failed/);
    assert.equal(adapter.remoteBranch, true);
    assert.equal(adapter.createdTicket, true);
    const outcome = await publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter);
    assert.equal(outcome.outcome, "merged");
    assert.equal(adapter.calls.filter((call) => call === "cl create-document").length, 1);
    assert.equal(adapter.calls.filter((call) => call === "git worktree add").length, 1);
  });
});

test("AC-003 AC-005 existing PR with altered private blob never reaches CI or merge", async () => {
  const adapter = new FakeAdapter();
  adapter.existingPr = true;
  adapter.remoteBranch = true;
  adapter.tamperContent = true;
  await withPublication(adapter, async (runRoot) => {
    await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter), /eval-publish-head-content-invalid/);
    assert.equal(adapter.merged, false);
    assert.equal(adapter.calls.some((call) => call === "cl create-document-version"), false);
  });
});

test("AC-003 AC-005 existing PR rejects non-regular mode and trailing blob bytes", async () => {
  for (const field of ["symlinkMode", "tamperWhitespace"] as const) {
    const adapter = new FakeAdapter();
    adapter.existingPr = true;
    adapter.remoteBranch = true;
    adapter[field] = true;
    await withPublication(adapter, async (runRoot) => {
      await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
        result: publicResult() }, adapter), field === "symlinkMode"
        ? /eval-publish-head-mode-invalid/ : /eval-publish-head-content-invalid/);
      assert.equal(adapter.merged, false);
    });
  }
});

test("AC-006 PR head changing during CI never merges", async () => {
  const adapter = new FakeAdapter();
  adapter.existingPr = true;
  adapter.remoteBranch = true;
  adapter.checks = () => {
    adapter.headOverride = "c".repeat(40);
    return [{ bucket: "pass" }];
  };
  await withPublication(adapter, async (runRoot) => {
    await assert.rejects(publishNightlyEval({ repo: runRoot, runRoot,
      result: publicResult() }, adapter), /eval-publish-head-path-invalid/);
    assert.equal(adapter.merged, false);
  });
});

test("AC-001 AC-006 failed RAN publication recovers on next SKIPPED run without new eval", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-pending-test-"));
  const originalRunAt = "2026-11-04T23:12:00Z";
  const args = [root, root, root, "claude", "codex", "uv", "gh"];
  let attempts = 0;
  try {
    const initial = localResult([suite("claude", [{ id: "case-a", passed: true },
      { id: "case-b", passed: false }]), suite("codex", [{ id: "case-a", passed: true },
      { id: "case-b", passed: false, unavailableReason: "NO_VALID_PRIOR" }])],
    ["case-a", "case-b"]);
    const catalog = ["case-a", "case-b"].map((id) => ({ id,
      skill: "vibe" as const, contentHash: "c".repeat(64) }));
    const baseline = buildEvalBaseline({ results: [initial], catalog, pluginVersion: "1.1.39",
      createdAt: "2026-11-05T00:01:00Z" });
    const resultPath = join(root, evalBaselineFileName(baseline));
    writeFileSync(resultPath, JSON.stringify(baseline));
    writeFileSync(join(root, `eval-${initial.createdAt.replaceAll(/[:.]/g, "")}-${SHA.slice(0, 12)}.json`),
      JSON.stringify(initial));
    await assert.rejects(publishCompletedNightly(resultPath, args,
      originalRunAt, async (child) => {
      queueCompletedNightlyResult(root, child[6]!, child[7]!);
      throw new Error("network-failed");
    }), /eval-publish-input-invalid/);
    const recovered = await publishCompletedNightly("SKIPPED /private/eval-t2-latest.json", args,
      "2026-11-05T23:12:00Z", async (child) => {
      assert.ok(child.includes("RECOVER"));
      const results = await recoverPublicNightlyResults({ repo: root, runRootParent: root,
        outputDir: root }, new FakeAdapter(), async ({ result }) => {
        attempts += 1;
        assert.equal(result.runAt, originalRunAt);
        assert.equal(result.runtimes[1]!.cases[1]!.status, "unavailable");
        return { ticket: "ISS-999", pr: "https://github.com/example/repo/pull/999",
          outcome: "merged" as const };
      });
      return results.join("\n");
    });
    assert.match(recovered, /PUBLISH_MERGED/);
    assert.equal(attempts, 1);
    assert.equal((await recoverPublicNightlyResults({ repo: root, runRootParent: root,
      outputDir: root }, new FakeAdapter(), async () => {
      throw new Error("should not replay");
    })).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
