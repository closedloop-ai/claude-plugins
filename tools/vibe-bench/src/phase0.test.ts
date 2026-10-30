import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, advanceBenchmarkPr, benchmarkPr, requirePinnedClaude, wallVerdict } from "./contract.ts";
import { agentModels } from "./agent-models.ts";
import { prepareFixture, verifyPreparedFixture } from "./fixture.ts";
import { cleanupClaudeLaunch, prepareClaudeLaunch, evaluateClaudeStream } from "./launch.ts";
import { SeededStackLifecycle } from "./lifecycle.ts";
import { ControlWebStackAdapter } from "./control-web-stack.ts";
import { preparePhase0 } from "./phase0.ts";
import { projectSearchOracle } from "../oracle/project-search-oracle.ts";

let inheritedClaudeEffort: string | undefined;
test.beforeEach(() => {
  inheritedClaudeEffort = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT;
});
test.afterEach(() => {
  if (inheritedClaudeEffort === undefined) delete process.env.CLAUDE_EFFORT;
  else process.env.CLAUDE_EFFORT = inheritedClaudeEffort;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function sourceFixture(): { root: string; source: string; sandbox: string } {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-test-"));
  const source = join(root, "source");
  const sandbox = join(root, "sandbox");
  mkdirSync(join(source, "packages/app/projects/lib"), { recursive: true });
  mkdirSync(sandbox);
  execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
  writeFileSync(join(source, BENCHMARK_TASK.file), `export function matchesProjectSearch(\n  row: ProjectSummaryRow,\n  search: string\n): boolean {\n  const term = search.trim().toLocaleLowerCase();\n  ${BENCHMARK_TASK.healthy}\n}\n`);
  git(source, "add", ".");
  git(source, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local", "commit", "-m", "seed");
  return { root, source, sandbox };
}

test("local fixture fails the hidden oracle and a repair passes it", () => {
  const paths = sourceFixture();
  try {
    const fixture = prepareFixture(paths.source, paths.sandbox);
    assert.equal(fixture.sourceSha, git(paths.source, "rev-parse", "HEAD"));
    assert.equal(projectSearchOracle(fixture.agentCheckout).pass, false);
    const file = join(fixture.agentCheckout, BENCHMARK_TASK.file);
    writeFileSync(file, readFileSync(file, "utf8").replace(BENCHMARK_TASK.broken, BENCHMARK_TASK.healthy));
    assert.equal(projectSearchOracle(fixture.agentCheckout).pass, true);
    assert.equal(readFileSync(join(paths.source, BENCHMARK_TASK.file), "utf8").includes(BENCHMARK_TASK.healthy), true);
    assert.throws(() => prepareFixture(paths.source, paths.sandbox), /benchmark-fixture-exists/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("detached source HEAD seeds the exact fixture even when local main is stale", () => {
  const paths = sourceFixture();
  try {
    const oldMain = git(paths.source, "rev-parse", "main");
    git(paths.source, "switch", "--detach");
    writeFileSync(join(paths.source, "new-main-marker"), "current origin/main\n");
    git(paths.source, "add", "new-main-marker");
    git(paths.source, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local", "commit", "-m", "current main");
    const currentMain = git(paths.source, "rev-parse", "HEAD");
    assert.notEqual(currentMain, oldMain);
    const fixture = prepareFixture(paths.source, paths.sandbox);
    assert.equal(fixture.sourceSha, currentMain);
    assert.equal(readFileSync(join(fixture.agentCheckout, "new-main-marker"), "utf8"), "current origin/main\n");
    assert.equal(projectSearchOracle(fixture.agentCheckout).pass, false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("pinned launch reaches local MCP boundary and rejects remote changes", () => {
  const paths = sourceFixture();
  try {
    const fixture = prepareFixture(paths.source, paths.sandbox);
    const launch = prepareClaudeLaunch(fixture, paths.source);
    assert.equal(launch.command, "claude");
    assert.equal(launch.args.includes("--safe-mode"), false);
    assert.equal(launch.args[launch.args.indexOf("--setting-sources") + 1], "");
    assert.equal(launch.args[launch.args.indexOf("--settings") + 1], launch.settingsFile);
    assert.deepEqual(JSON.parse(readFileSync(launch.settingsFile, "utf8")).env, {
      CLAUDE_CODE_SUBAGENT_MODEL: BENCHMARK_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: BENCHMARK_MODEL,
      CLAUDE_CODE_EFFORT_LEVEL: BENCHMARK_EFFORT,
    });
    assert.equal(launch.args[launch.args.indexOf("--model") + 1], BENCHMARK_MODEL);
    assert.equal(launch.args[launch.args.indexOf("--effort") + 1], BENCHMARK_EFFORT);
    assert.equal(launch.args[launch.args.indexOf("--plugin-dir") + 1], paths.source);
    assert.ok(launch.args.includes("--strict-mcp-config"));
    assert.equal(launch.args[launch.args.indexOf("--permission-prompts") + 1], "none");
    assert.equal(JSON.parse(readFileSync(launch.mcpConfigFile, "utf8")).mcpServers.closedloop.url, "http://127.0.0.1:3010/mcp");
    assert.equal(statSync(launch.mcpConfigFile).mode & 0o777, 0o600);
    assert.equal(launch.cwd, fixture.agentCheckout);
    cleanupClaudeLaunch(launch);
    assert.equal(existsSync(launch.mcpConfigFile), false);
    assert.equal(existsSync(launch.settingsFile), false);
    git(fixture.agentCheckout, "remote", "set-url", "--push", "origin", "https://github.com/closedloop-ai/symphony-alpha.git");
    assert.throws(() => verifyPreparedFixture(fixture, "http://127.0.0.1:3010/mcp"), /benchmark-remote-not-local-path/);
    git(fixture.agentCheckout, "remote", "set-url", "--push", "origin", fixture.bareRemote);
    assert.throws(() => verifyPreparedFixture(fixture, "https://closedloop.example/mcp"), /benchmark-mcp-not-loopback/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Phase 0 entry prepares a private oracle and a fake Claude reaches the pinned boundary", () => {
  const paths = sourceFixture();
  try {
    const manifestFile = preparePhase0(paths.source, paths.sandbox, paths.source);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.oracleBefore.pass, false);
    assert.equal(existsSync(join(manifest.fixture.agentCheckout, "tools/vibe-bench/oracle")), false);
    assert.equal(manifest.launch.selection.model, BENCHMARK_MODEL);
    const fakeClaude = join(paths.root, "fake-claude");
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","model":"${BENCHMARK_MODEL}"}' '{"type":"result","is_error":false}'\n`, { mode: 0o755 });
    const output = execFileSync(fakeClaude, manifest.launch.args, {
      cwd: manifest.launch.cwd,
      encoding: "utf8",
    });
    assert.equal(evaluateClaudeStream(output.trim().split("\n"), manifest.launch.selection.effort).valid, true);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("model and effort mismatch invalidate a completed Claude result", () => {
  assert.throws(() => requirePinnedClaude({ model: "sonnet", effort: "high" }), /benchmark-model-mismatch/);
  assert.throws(() => requirePinnedClaude({ model: BENCHMARK_MODEL, effort: "medium" }), /benchmark-effort-mismatch/);
  assert.throws(() => requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT }, { ANTHROPIC_MODEL: "other" }), /benchmark-model-env-override/);
  assert.throws(() => requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT },
    { CLAUDE_CODE_SUBAGENT_MODEL: "other" }), /benchmark-model-env-override/);
  assert.throws(() => requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT },
    { ANTHROPIC_DEFAULT_SONNET_MODEL: "other" }), /benchmark-model-env-override/);
  assert.throws(() => requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT }, { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" }), /benchmark-effort-env-override/);
  const stream = [
    JSON.stringify({ type: "system", model: BENCHMARK_MODEL }),
    JSON.stringify({ type: "assistant", message: { model: BENCHMARK_MODEL } }),
    JSON.stringify({ type: "result", is_error: false }),
  ];
  assert.equal(evaluateClaudeStream(stream, "high").valid, true);
  assert.equal(evaluateClaudeStream(stream, "medium").reason, "benchmark-effort-mismatch");
  assert.equal(evaluateClaudeStream([stream[0], JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-6" } }), stream[2]], "high").reason, "benchmark-model-mismatch");
  assert.equal(evaluateClaudeStream([stream[0]], "high").reason, "benchmark-run-incomplete");
});

test("agent model inventory preserves the adversarial reviewer's Opus choice", () => {
  const pluginDir = mkdtempSync(join(tmpdir(), "vibe-bench-models-"));
  try {
    mkdirSync(join(pluginDir, "agents"));
    writeFileSync(join(pluginDir, "agents/vibe-change-worker.md"), "---\nname: vibe-change-worker\nmodel: sonnet\n---\n");
    writeFileSync(join(pluginDir, "agents/vibe-adversarial-reviewer.md"), "---\nname: vibe-adversarial-reviewer\nmodel: opus\n---\n");
    const models = agentModels(pluginDir);
    assert.equal(models["vibe-change-worker"], "sonnet");
    assert.equal(models["vibe-adversarial-reviewer"], "opus");
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("draft PR closes only after a result is recorded and target stays fixed", () => {
  const draft = benchmarkPr(BENCHMARK_TASK.id);
  assert.equal(draft.draft, true);
  assert.match(draft.title, /DO NOT MERGE/);
  assert.match(draft.body, /benchmark/);
  assert.throws(() => advanceBenchmarkPr(draft, "close"), /benchmark-close-before-record/);
  const recorded = advanceBenchmarkPr(draft, "record", "a".repeat(64));
  assert.throws(() => advanceBenchmarkPr(recorded, "record", "b".repeat(64)), /benchmark-result-already-recorded/);
  assert.equal(advanceBenchmarkPr(recorded, "close").state, "closed");
  assert.deepEqual(wallVerdict(599_999), { wallMs: 599_999, targetMs: 600_000, targetMet: true });
  assert.equal(wallVerdict(600_001).targetMs, 600_000);
});

test("parallel leases reuse one seeded stack and cleanup waits for the last run", async () => {
  const events: string[] = [];
  const lifecycle = new SeededStackLifecycle({
    async start() { events.push("start"); },
    async healthy() { events.push("healthy"); return true; },
    async stop() { events.push("stop"); },
  });
  await Promise.all([
    lifecycle.acquire({ id: "run-a", isolationKey: "seed-1:independent-checkouts" }),
    lifecycle.acquire({ id: "run-b", isolationKey: "seed-1:independent-checkouts" }),
  ]);
  assert.deepEqual(events, ["start", "healthy"]);
  await assert.rejects(lifecycle.acquire({ id: "run-c", isolationKey: "seed-2" }), /benchmark-stack-isolation-mismatch/);
  await lifecycle.release("run-a");
  assert.deepEqual(events, ["start", "healthy"]);
  await lifecycle.release("run-b");
  assert.deepEqual(events, ["start", "healthy", "stop"]);
});

test("failed stack teardown retains ownership for a bounded caller retry", async () => {
  let stops = 0;
  const lifecycle = new SeededStackLifecycle({
    async start() {},
    async healthy() { return true; },
    async stop() {
      stops += 1;
      if (stops === 1) throw new Error("fixture-stop-failed");
    },
  });
  await lifecycle.acquire({ id: "run", isolationKey: "seed" });
  await assert.rejects(lifecycle.close(), /fixture-stop-failed/);
  await lifecycle.close();
  assert.equal(stops, 2);
});

test("web-only control adapter owns no stack before acquisition", async () => {
  const paths = sourceFixture();
  try {
    const adapter = new ControlWebStackAdapter(paths.source, paths.sandbox);
    assert.equal(await adapter.healthy(), false);
    assert.throws(() => adapter.details(), /benchmark-stack-not-ready/);
    await adapter.stop();
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
