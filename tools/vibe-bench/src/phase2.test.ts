import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { BASELINE_ORDER, shapePrompt } from "./claude-task.ts";
import { buildBaselineReport, finalizeBaseline, orchestrateTen, verifyBaselineHash } from "./baseline.ts";
import type { BaselineRun } from "./baseline.ts";
import { collectClaude } from "./claude-collector.ts";
import { BENCHMARK_TASK } from "./contract.ts";
import { GithubProofPr, PROOF_REMOTE } from "./github-pr.ts";
import type { PrCommands } from "./github-pr.ts";
import { snapshotMainPlugins } from "./plugin-snapshot.ts";
import { sourceMain } from "./phase2-driver.ts";
import { checkVibeVersion, writeBenchmarkSessionRecord } from "./session-preflight.ts";
import type { PreparedFixture } from "./fixture.ts";
import type { BenchmarkShape, ClaudeRunIdentity } from "./result-schema.ts";

const fixtureDir = join(dirname(new URL(import.meta.url).pathname), "..", "fixtures");
const realStream = readFileSync(join(fixtureDir, "phase0-claude-anonymized.jsonl"), "utf8");
const realTranscript = readFileSync(join(fixtureDir, "phase0-transcript-anonymized.jsonl"), "utf8");

test("main plugin hooks require a checked conversation and a run-owned session record", async () => {
  const vibeDir = join(dirname(new URL(import.meta.url).pathname), "../../../plugins/vibe");
  const agentModule = await import(pathToFileURL(join(vibeDir, "hooks/agent-guard.mjs")).href) as {
    agentGuard(input: unknown): unknown;
  };
  const versionModule = await import(pathToFileURL(join(vibeDir, "hooks/plugin-version-guard.mjs")).href) as {
    pluginVersionGuard(input: unknown, home: string): unknown;
  };
  const { agentGuard } = agentModule;
  const { pluginVersionGuard } = versionModule;
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-hook-guards-"));
  try {
    const checkout = join(root, "agent");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-b", "main", checkout], { stdio: "ignore" });
    const sessionId = "benchmark-hook-test";
    const input = { tool_name: "Agent", cwd: checkout,
      session_id: sessionId, tool_input: { subagent_type: "vibe:vibe-change-worker" } };
    assert.ok(agentGuard(input), "direct worker must be denied before a session record");
    const startup = join(root, ".codex/vibe/plugin-version", `${sessionId}.json`);
    mkdirSync(dirname(startup), { recursive: true });
    writeFileSync(startup, `${JSON.stringify({ conversation: sessionId, status: "pending" })}\n`);
    assert.ok(pluginVersionGuard(input, root), "unverified plugin version must deny a writer");
    await writeBenchmarkSessionRecord(vibeDir, checkout,
      "benchmark/project-search-infix", "seeded", "a".repeat(40));
    assert.equal(agentGuard(input), null, "run-owned session record admits the writer");
    writeFileSync(startup, `${JSON.stringify({ conversation: sessionId, status: "unknown" })}\n`);
    assert.equal(pluginVersionGuard(input, root), null, "a completed version check admits the writer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("version-check launcher uses a physical plugin path so its CLI main guard runs", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-version-cli-"));
  try {
    const scriptDir = join(root, "plugin/skills/vibe/scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "plugin-version.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      'import { resolve } from "node:path";',
      'if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {',
      '  const args = process.argv;',
      '  const state = args[args.indexOf("--state") + 1];',
      '  const conversation = args[args.indexOf("--conversation") + 1];',
      '  const result = { status: "current", conversation };',
      '  writeFileSync(state, JSON.stringify(result));',
      '  process.stdout.write(JSON.stringify(result));',
      '}',
    ].join("\n"));
    assert.equal(checkVibeVersion(join(root, "plugin"), root, root,
      "probe-123", process.execPath).status, "current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("balanced ten-run paired waves use one stack and wait before teardown", async () => {
  assert.deepEqual(BASELINE_ORDER, ["vibe", "fleet-one-writer", "vibe", "fleet-one-writer",
    "vibe", "fleet-one-writer", "vibe", "fleet-one-writer", "vibe", "fleet-one-writer"]);
  assert.equal(BASELINE_ORDER.filter((shape) => shape === "vibe").length, 5);
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const complete = await orchestrateTen({
    async setup() { events.push("start"); },
    async run(index, shape) {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`${index}:${shape}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return index;
    },
    async teardown() { events.push("stop"); },
  });
  assert.equal(complete.runs.length, 10);
  assert.equal(events.filter((event) => event === "start").length, 1);
  assert.equal(events.filter((event) => event === "stop").length, 1);
  assert.equal(maxActive, 2);
  assert.match(shapePrompt("vibe"), /^\/vibe:vibe/);
  assert.match(shapePrompt("fleet-one-writer"), /^\/vibe:fleet-orchestrator/);
  events.length = 0;
  await assert.rejects(orchestrateTen({
    async setup() { events.push("start"); },
    async run(index) {
      if (index === 1) throw new Error("fixture failure");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(String(index));
    },
    async teardown() { events.push("stop"); },
  }), /fixture failure/);
  assert.equal(events.at(-1), "stop");
  assert.ok(events.includes("0"), "the peer finishes before stack teardown");
});

test("isolated run child persists a failure before any external operation", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-run-child-"));
  try {
    const source = join(root, "source");
    const runDir = join(root, "run");
    mkdirSync(source);
    mkdirSync(runDir);
    execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
    writeFileSync(join(source, "file"), "fixture\n");
    execFileSync("git", ["-C", source, "add", "file"]);
    execFileSync("git", ["-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local",
      "commit", "-m", "fixture"], { stdio: "ignore" });
    const inputFile = join(runDir, "run-input.json");
    writeFileSync(inputFile, JSON.stringify({ index: 0, shape: "vibe", source,
      sourceSha: "a".repeat(40), snapshot: { sha: "b".repeat(40), vibeDir: root,
        coreDir: root, agentModels: {} }, apiKeyFile: join(root, "missing-key"),
      claudeExecutable: process.execPath, ghExecutable: "gh", cliVersion: "2.1.311 (Claude Code)",
      batchId: "fakebatch", runDir }));
    const child = realpathSync(fileURLToPath(new URL("./single-run.ts", import.meta.url)));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", child, inputFile],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    const failure = JSON.parse(readFileSync(join(runDir, "run-failure.json"), "utf8")) as {
      error: string; prNumber: number | null;
    };
    assert.match(failure.error, /benchmark-run-source-or-cli-drift/);
    assert.equal(failure.prNumber, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("current-main plugin snapshot archives exact Git objects and Opus frontmatter", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-plugin-snapshot-"));
  try {
    const repo = join(root, "repo");
    const out = join(root, "out");
    mkdirSync(join(repo, "plugins/vibe/agents"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/.claude-plugin"));
    mkdirSync(join(repo, "plugins/closedloop-core/.claude-plugin"), { recursive: true });
    mkdirSync(out);
    writeFileSync(join(repo, "plugins/vibe/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "vibe", version: "1.0", dependencies: ["closedloop-core"] }));
    writeFileSync(join(repo, "plugins/closedloop-core/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "closedloop-core", version: "1.0" }));
    writeFileSync(join(repo, "plugins/vibe/agents/vibe-change-worker.md"),
      "---\nname: vibe-change-worker\nmodel: sonnet\n---\n");
    writeFileSync(join(repo, "plugins/vibe/agents/vibe-adversarial-reviewer.md"),
      "---\nname: vibe-adversarial-reviewer\nmodel: opus\n---\n");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local",
      "commit", "-m", "fixture"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", sha]);
    const snapshot = snapshotMainPlugins(repo, sha, out);
    assert.equal(snapshot.sha, sha);
    assert.equal(snapshot.agentModels["vibe-adversarial-reviewer"], "opus");
    assert.throws(() => snapshotMainPlugins(repo, sha, out), /snapshot-exists/);
    writeFileSync(join(repo, "new-main"), "moved\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local",
      "commit", "-m", "new main"], { stdio: "ignore" });
    const moved = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", moved]);
    assert.throws(() => snapshotMainPlugins(repo, sha, join(root, "second")), /main-moved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source preflight rejects a live main advance absent from the checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-live-main-"));
  try {
    const bare = join(root, "closedloop-ai/symphony-alpha.git");
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    mkdirSync(dirname(bare), { recursive: true });
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
    writeFileSync(join(source, "file"), "one\n");
    execFileSync("git", ["-C", source, "add", "file"]);
    execFileSync("git", ["-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local",
      "commit", "-m", "one"], { stdio: "ignore" });
    execFileSync("git", ["-C", source, "remote", "add", "origin", bare]);
    execFileSync("git", ["-C", source, "push", "origin", "main"], { stdio: "ignore" });
    execFileSync("git", ["clone", "--branch", "main", bare, checkout], { stdio: "ignore" });
    assert.match(sourceMain(checkout), /^[a-f0-9]{40}$/);
    writeFileSync(join(source, "file"), "two\n");
    execFileSync("git", ["-C", source, "add", "file"]);
    execFileSync("git", ["-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local",
      "commit", "-m", "two"], { stdio: "ignore" });
    execFileSync("git", ["-C", source, "push", "origin", "main"], { stdio: "ignore" });
    assert.throws(() => sourceMain(checkout), /benchmark-source-live-main-moved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class FakePrCommands implements PrCommands {
  refs = new Set<string>();
  pr: { number: number; draft: boolean; state: string; title: string; body: string; ref: string; baseRef: string } | null = null;
  failCreate = false;
  calls: string[] = [];
  private readonly sha: string;
  constructor(sha: string) { this.sha = sha; }
  run(command: string, args: string[], cwd: string): string {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "git") {
      if (args[0] === "ls-remote" && args[2] === "refs/heads/main") return `${this.sha}\trefs/heads/main`;
      if (args[0] === "ls-remote") return this.refs.has(args.at(-1)!) ? `deadbeef\t${args.at(-1)}` : "";
      if (args[0] === "diff") return BENCHMARK_TASK.file;
      if (args[0] === "push") {
        assert.equal(args[1], PROOF_REMOTE);
        if (args[2].startsWith(":")) this.refs.delete(args[2].slice(12));
        else this.refs.add(args[2].split(":refs/heads/")[1]);
      }
      return "";
    }
    if (args[1] === "create") {
      if (this.failCreate) throw new Error("GitHub create failed");
      assert.ok(args.includes("--draft"));
      const title = args[args.indexOf("--title") + 1];
      const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8").trim();
      assert.match(title, /DO NOT MERGE/);
      assert.match(body, /part of a benchmark of vibe/);
      assert.doesNotMatch(body, /\/Users\/|laptop|localhost/);
      this.pr = { number: 123, draft: true, state: "OPEN", title, body,
        ref: args[args.indexOf("--head") + 1], baseRef: args[args.indexOf("--base") + 1] };
      return "https://github.com/closedloop-ai/symphony-alpha/pull/123";
    }
    if (args[1] === "view") {
      assert.ok(this.pr);
      return JSON.stringify({ number: this.pr.number, isDraft: this.pr.draft, state: this.pr.state,
        title: this.pr.title, body: this.pr.body, headRefName: this.pr.ref, baseRefName: this.pr.baseRef });
    }
    if (args[1] === "edit") {
      assert.ok(this.pr);
      this.pr.body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8").trim();
      return "";
    }
    if (args[1] === "close") { assert.ok(this.pr); this.pr.state = "CLOSED"; return ""; }
    throw new Error(`unexpected command:${command} ${args.join(" ")} ${cwd}`);
  }
}

test("draft PR is recorded before close and both owned proof refs are removed", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-pr-"));
  try {
    const sha = "a".repeat(40);
    const commands = new FakePrCommands(sha);
    const adapter = new GithubProofPr(commands, "gh");
    const fixture = { sourceSha: sha, baseSha: "b".repeat(40), agentCheckout: root } as PreparedFixture;
    const proof = adapter.publish(fixture, root, "run-123456");
    assert.equal(proof.pr.draft, true);
    assert.equal(commands.refs.size, 2);
    assert.throws(() => adapter.close(proof, root), /close-before-record/);
    adapter.record(proof, "f".repeat(64), root, root);
    adapter.close(proof, root);
    assert.equal(proof.closed, true);
    assert.equal(proof.refRemoved, true);
    assert.equal(commands.refs.size, 0);
    assert.equal(commands.pr?.state, "CLOSED");
    assert.ok(commands.calls.findIndex((call) => call.includes("pr edit")) <
      commands.calls.findIndex((call) => call.includes("pr close")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("proof PR remains valid after live main advances beyond the pinned base", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-pr-main-advance-"));
  try {
    const commands = new FakePrCommands("f".repeat(40));
    const adapter = new GithubProofPr(commands, "gh");
    const proof = adapter.publish({ sourceSha: "a".repeat(40), baseSha: "b".repeat(40),
      agentCheckout: root } as PreparedFixture, root, "run-123456");
    adapter.record(proof, "f".repeat(64), root, root);
    adapter.close(proof, root);
    assert.equal(proof.refRemoved, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed PR creation cleans both of its own pushed proof refs", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-pr-failure-"));
  try {
    const sha = "b".repeat(40);
    const commands = new FakePrCommands(sha);
    commands.failCreate = true;
    const adapter = new GithubProofPr(commands, "gh");
    assert.throws(() => adapter.publish({ sourceSha: sha, baseSha: "c".repeat(40), agentCheckout: root } as PreparedFixture,
      root, "run-123456"), /publish-failed/);
    assert.equal(commands.refs.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function sampleRun(index: number, shape: BenchmarkShape, wallMs = 100): BaselineRun {
  const identity: ClaudeRunIdentity = {
    id: `run-${index}`, shape, pluginSha: "a".repeat(40), taskId: BENCHMARK_TASK.id,
    taskVersion: "task-v1", fixtureVersion: "b".repeat(40), cliVersion: "2.1.311 (Claude Code)",
    configuredModel: "claude-sonnet-5-5", configuredEffort: "high",
    startedAt: "2026-10-29T18:00:00.000Z", wallMs, stackSetupMs: 0, stackTeardownMs: 0,
    oraclePassed: true, noOutOfScopeEdits: true, taskComplete: true, prDraftRecordedAndClosed: true,
  };
  const result = collectClaude({ stream: realStream, transcripts: [{ jsonl: realTranscript }], identity,
    agentModels: { "vibe-change-worker": "sonnet", "vibe-adversarial-reviewer": "opus" }, env: {} });
  return { index, shape, fixtureMs: 3, claudeTaskMs: 75, prMs: 15,
    versionCheck: "current",
    prNumber: index + 100, prUrl: `https://github.com/closedloop-ai/symphony-alpha/pull/${index + 100}`,
    proofBaseRef: `proof/${index}-base`, proofRef: `proof/${index}-head`, recordedDigest: "c".repeat(64),
    prClosed: true, proofRefRemoved: true, result };
}

test("baseline allocation, noise, cached-input disclosure and hashes are exact", () => {
  const runs = BASELINE_ORDER.map((shape, index) => sampleRun(index, shape));
  const baseline = finalizeBaseline({ runs, setupMs: 100, teardownMs: 20,
    preflightMs: 10, fullWallMs: 1130, pluginSha: "a".repeat(40),
    sourceSha: "b".repeat(40), cliVersion: "2.1.311 (Claude Code)",
    createdAt: "2026-10-29T18:00:00.000Z" });
  assert.equal(baseline.runs.length, 10);
  assert.ok(baseline.runs.every((run) => run.result.identity.stackSetupMs === 10 &&
    run.result.identity.stackTeardownMs === 2));
  assert.equal(baseline.shapeWall.vibe.medianMs, 100);
  assert.equal(baseline.shapeWall.vibe.madMs, 0);
  assert.deepEqual(baseline.waveSizes, [2, 2, 2, 2, 2]);
  assert.deepEqual(baseline.waveWallMs, [100, 100, 100, 100, 100]);
  assert.equal(baseline.shapeANoiseMet, true);
  assert.equal(baseline.targetMet, true);
  assert.match(buildBaselineReport(baseline), /Cached input is informational/);
  assert.match(buildBaselineReport(baseline), /## Component totals/);
  assert.match(buildBaselineReport(baseline), /Peer-run durations overlap/);
  verifyBaselineHash(baseline);
  const changed = structuredClone(baseline);
  changed.runs[0].result.costUsd++;
  assert.throws(() => verifyBaselineHash(changed), /baseline-hash-mismatch/);
  assert.throws(() => finalizeBaseline({ runs: runs.slice(1), setupMs: 100, teardownMs: 20,
    preflightMs: 10, fullWallMs: 1130, pluginSha: "a".repeat(40),
    sourceSha: "b".repeat(40), cliVersion: "2.1.311 (Claude Code)",
    createdAt: "2026-10-29T18:00:00.000Z" }), /run-count/);
});
