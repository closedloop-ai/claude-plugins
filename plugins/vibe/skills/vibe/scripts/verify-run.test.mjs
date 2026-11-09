import assert from "node:assert/strict";
import test from "node:test";
import { createVerifyRun, strictlySerial, evidenceOk, parseLaneCheck, Status, summarize, TIME_LIMITS, turboReplay, uncoveredPaths } from "./verify-run.mjs";

const HEAD = "a".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom", status = 1) => ({ status, stdout: "", stderr });

function router(routes, calls = []) {
  return (command, args, options) => {
    const line = [command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    calls.push({ line, options });
    for (const [matcher, result] of routes) {
      if (line.includes(matcher)) return typeof result === "function" ? result(line) : result;
    }
    return fail(`no route for ${line}`, 127);
  };
}

const LANE = "pnpm --filter app test";
const REPORT = `Lanes:\n    ${LANE}\n`;
const PACKAGE = JSON.stringify({ scripts: { "check:source-gates": "x", "typecheck:affected": "y", "test:lanes": "z" } });

function harness({ installed = true, extra = [], files = { "package.json": PACKAGE, "apps/app/a.tsx": "x" }, calls = [], controllerOptions = {} } = {}) {
  const written = {};
  const routes = [
    ...extra,
    ["rev-parse --absolute-git-dir", ok("/gd\n")],
    ["rev-parse HEAD", ok(`${HEAD}\n`)],
    ["status --porcelain", ok("")],
    ["merge-base", ok(`${"b".repeat(40)}\n`)],
    ["diff --name-only", ok("apps/app/a.tsx\nREADME.md\n")],
    ["run-bounded.mjs 300 pnpm exec biome check", ok()],
    ["run-bounded.mjs 600 pnpm check:source-gates", ok()],
    ["run-bounded.mjs 900 pnpm typecheck:affected", ok()],
    ["run-bounded.mjs 300 pnpm test:lanes", ok(REPORT)],
    ["pre-pr-lanes.mjs check", ok(`MISSING-LANE ${LANE}: run it with pre-pr-lanes.mjs run --head <HEAD> --command "${LANE}"\npre-pr lanes: 1 lanes, 1 missing\n`)],
    ["pre-pr-lanes.mjs run", ok("recorded pass")],
  ];
  const controller = createVerifyRun({
    run: router(routes, calls),
    read: (file) => { if (file in files) return files[file]; throw new Error(`no file ${file}`); },
    write: (file, text) => { written[file] = text; },
    exists: (file) => (installed && file.endsWith("node_modules")) || file in files || file.endsWith("apps/app/a.tsx") || file === "/gd/vibe-verify-cache.json" && "/gd/vibe-verify-cache.json" in files,
    now: () => 1_000,
    ...controllerOptions,
  });
  return { controller, written, calls };
}

const find = (evidence, name) => evidence.checks.find((check) => check.name === name || check.name === `lane: ${name}`);

test("every required check passes: statuses are passed, ok is true, and the E2E and browser work is left to the worker", () => {
  const { controller } = harness({ files: { "/wt/package.json": PACKAGE, "apps/app/a.tsx": "x", "/wt/apps/app/a.tsx": "x" } });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "biome").status, Status.Passed);
  assert.equal(find(evidence, "biome").files, 1);
  assert.equal(find(evidence, "source-gates").status, Status.Passed);
  assert.equal(find(evidence, "typecheck").status, Status.Passed);
  assert.equal(find(evidence, LANE).status, Status.Passed);
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.leftToWorker.map((item) => item.name), ["e2e-specs", "story-plays", "touch-flows", "control-sweep"]);
  assert.equal(find(evidence, "selected-tests").status, Status.NotRun);
});

test("a skipped check is never a pass: a repository with no source-gates script reports skipped and ok is false", () => {
  const { controller } = harness({ files: { "/wt/package.json": JSON.stringify({ scripts: { "typecheck:affected": "y" } }), "/wt/apps/app/a.tsx": "x" } });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  const gates = find(evidence, "source-gates");
  assert.equal(gates.status, Status.Skipped);
  assert.match(gates.reason, /no "check:source-gates" script/);
  assert.equal(evidence.ok, false);
});

// Review of PR 383: a docs-only diff has nothing for Biome to check, so a no-op that says why must not block Aligned.
test("a diff with no file Biome checks is no-op with its reason, and that reason satisfies the required check", () => {
  const { controller } = harness({ extra: [["diff --name-only", ok("README.md\n")]], files: { "/wt/package.json": PACKAGE } });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "biome").status, Status.NoOp);
  assert.match(find(evidence, "biome").reason, /no changed file/);
  assert.equal(evidence.ok, true);
});

test("a failing check carries its output tail, a timed-out check is blocked rather than failed", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const failing = harness({ files, extra: [["run-bounded.mjs 600 pnpm check:source-gates", fail("rule x failed\nat apps/app/a.tsx:3")]] });
  const first = failing.controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(first, "source-gates").status, Status.Failed);
  assert.match(find(first, "source-gates").evidenceTail, /apps\/app\/a.tsx:3/);
  const slow = harness({ files, extra: [["run-bounded.mjs 900 pnpm typecheck:affected", fail("", 124)]] });
  const second = slow.controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(second, "typecheck").status, Status.Blocked);
  assert.match(find(second, "typecheck").reason, /stopped after 900s on this machine/);
  assert.equal(second.ok, false);
});

test("a pass at the same head and command is reported cached, not passed, and the second run does not rerun it", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const first = harness({ files });
  const run1 = first.controller.verify({ worktree: "/wt", head: HEAD });
  const cacheText = first.written["/gd/vibe-verify-cache.json"];
  assert.ok(cacheText);
  const calls = [];
  const second = harness({ files: { ...files, "/gd/vibe-verify-cache.json": cacheText }, calls });
  const run2 = second.controller.verify({ worktree: "/wt", head: HEAD });
  assert.equal(run1.checks[0].status, Status.Passed);
  assert.equal(run2.checks[0].status, Status.Cached);
  assert.equal(find(run2, "source-gates").status, Status.Cached);
  assert.equal(find(run2, "source-gates").cachedFrom.head, HEAD);
  assert.ok(!calls.some((call) => call.line.includes("check:source-gates")));
  assert.equal(run2.ok, true);
  assert.equal(run2.summary.cached >= 3, true);
  assert.equal(run2.summary.passed, 0);
});

test("--no-cache reruns everything, so a stale cache can never stand in for a run", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const seed = harness({ files }).controller.verify({ worktree: "/wt", head: HEAD });
  assert.equal(seed.ok, true);
  const calls = [];
  const again = harness({ files: { ...files, "/gd/vibe-verify-cache.json": JSON.stringify({ [`${HEAD}\u0000pnpm check:source-gates`]: { head: HEAD, at: "x" } }) }, calls });
  const evidence = again.controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "source-gates").status, Status.Passed);
  assert.ok(calls.some((call) => call.line.includes("check:source-gates")));
});

test("a worktree not at the named head, or with a modified tracked file, runs nothing and every required check is blocked", () => {
  const files = { "/wt/package.json": PACKAGE };
  const calls = [];
  const moved = harness({ files, calls, extra: [["rev-parse HEAD", ok(`${"c".repeat(40)}\n`)]] });
  const first = moved.controller.verify({ worktree: "/wt", head: HEAD });
  assert.ok(first.checks.every((check) => check.status === Status.Blocked && /HEAD-MISMATCH/.test(check.reason)));
  assert.equal(first.ok, false);
  assert.ok(!calls.some((call) => call.line.includes("run-bounded")));
  const dirty = harness({ files, extra: [["status --porcelain", ok(" M apps/app/a.tsx\n")]] });
  const second = dirty.controller.verify({ worktree: "/wt", head: HEAD });
  assert.match(second.checks[0].reason, /DIRTY-WORKTREE/);
});

test("lanes: a lane this machine cannot run is not-run with its reason, a main failure keeps its own status, a recorded pass is cached", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const lanes = ["pnpm lane-a", "pnpm test:e2e -- web", "pnpm lane-c", "pnpm lane-d"];
  const check = [
    `NOT-RUN-LANE ${lanes[1]} (no staging e2e identities)`,
    `MAIN-PREEXISTING-LANE ${lanes[2]} (fails on captured main ${"d".repeat(40)} too; list it)`,
    `MISSING-LANE ${lanes[3]}: run it, with pre-pr-lanes.mjs run`,
    "pre-pr lanes: 4 lanes, 1 missing",
  ].join("\n");
  const { controller } = harness({
    files,
    extra: [
      ["run-bounded.mjs 300 pnpm test:lanes", ok(lanes.map((lane) => `    ${lane}\n`).join(""))],
      ["pre-pr-lanes.mjs check", ok(check)],
    ],
  });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, lanes[0]).status, Status.Cached);
  assert.equal(find(evidence, lanes[1]).status, Status.NotRun);
  assert.equal(find(evidence, lanes[1]).reason, "no staging e2e identities");
  assert.equal(find(evidence, lanes[2]).status, Status.MainPreexisting);
  assert.equal(find(evidence, lanes[3]).status, Status.Passed);
  assert.equal(evidence.ok, false);
});

test("a lane run names the lane report it was selected from, as pre-pr-lanes.mjs run now requires, and the old comma form still parses", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const calls = [];
  harness({ files, calls }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  const laneRun = calls.find((call) => call.line.includes("pre-pr-lanes.mjs run")).line;
  assert.match(laneRun, /--report \/gd\/vibe-verify-lane-report\.txt/);
  assert.deepEqual(parseLaneCheck("MISSING-LANE pnpm a: run it, with pre-pr-lanes.mjs run").missing, ["pnpm a"]);
});

test("a failing lane run is failed and the lane report that does not run or read is blocked", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const failing = harness({ files, extra: [["pre-pr-lanes.mjs run", fail("lane red")]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(failing, LANE).status, Status.Failed);
  const noReport = harness({ files, extra: [["run-bounded.mjs 300 pnpm test:lanes", fail("no script")]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(noReport, "lanes").status, Status.Blocked);
  const unreadable = harness({ files, extra: [["run-bounded.mjs 300 pnpm test:lanes", ok("nothing useful")]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(unreadable, "lanes").status, Status.Blocked);
  const nothing = harness({ files, extra: [["run-bounded.mjs 300 pnpm test:lanes", ok("No paths changed")]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(nothing, "lanes").status, Status.NoOp);
});

test("selected tests: the worker's command runs bounded once per command, an entry with no command is not-run, and neither gates ok", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x", "/wt/tests.json": JSON.stringify([
    { file: "apps/app/a.tsx", selector: "code_tests_for", tests: ["apps/app/a.test.tsx"], command: "pnpm --filter app exec vitest run a.test.tsx" },
    { file: "apps/app/b.tsx", selector: "code_tests_for", tests: ["apps/app/a.test.tsx"], command: "pnpm --filter app exec vitest run a.test.tsx" },
    { file: "apps/app/c.tsx", selector: "related", tests: null },
  ]) };
  const calls = [];
  const { controller } = harness({ files, calls, extra: [["run-bounded.mjs 900 pnpm --filter app exec vitest", fail("1 failed")]] });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false, testsFile: "/wt/tests.json" });
  const tests = evidence.checks.filter((check) => check.name.startsWith("tests:"));
  assert.equal(tests.length, 2);
  assert.equal(tests[0].status, Status.Failed);
  assert.deepEqual(tests[0].files, ["apps/app/a.tsx", "apps/app/b.tsx"]);
  assert.equal(calls.filter((call) => call.line.includes("vitest")).length, 1);
  assert.equal(tests[1].status, Status.NotRun);
  assert.equal(evidence.ok, true);
});

test("summary counts every status separately and ok needs a required check", () => {
  const checks = [{ status: Status.Passed, required: true }, { status: Status.Cached, required: true }, { status: Status.Skipped, required: false }, { status: Status.NoOp, required: false }];
  const counts = summarize(checks);
  assert.equal(counts.passed, 1);
  assert.equal(counts.cached, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(counts["no-op"], 1);
  assert.equal(evidenceOk(checks), true);
  assert.equal(evidenceOk([]), false);
  assert.equal(evidenceOk([{ status: Status.NoOp, required: true }]), false, "a no-op with no reason proves nothing");
  assert.equal(evidenceOk([{ status: Status.NoOp, required: true, reason: "no changed file is one Biome checks" }, { status: Status.Passed, required: true }]), true);
  assert.equal(evidenceOk([{ status: Status.Blocked, required: true, reason: "x" }]), false);
});

test("the lane check output is read back into missing, not-run, main-preexisting and skipped", () => {
  const parsed = parseLaneCheck([
    "MISSING-LANE pnpm a: run it with pre-pr-lanes.mjs run --head <HEAD> --command \"pnpm a\"",
    "NOT-RUN-LANE pnpm b (reason b)",
    "MAIN-PREEXISTING-LANE pnpm c (fails on captured main x too)",
    "SKIPPED-LANE pnpm d (ruling)",
    "pre-pr lanes: 4 lanes",
  ].join("\n"));
  assert.deepEqual(parsed, {
    missing: ["pnpm a"], notRun: [{ lane: "pnpm b", reason: "reason b" }], mainPreexisting: ["pnpm c"], skipped: [{ lane: "pnpm d", reason: "ruling" }],
  });
  assert.equal(TIME_LIMITS.lane, 1800);
});

test("a lane check that crashes, times out or prints nothing blocks every lane; it never reads as all lanes recorded", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  for (const checkResult of [{ status: 124, stdout: "", stderr: "" }, { status: 1, stdout: "", stderr: "SOURCE-MOVED" }, ok("")]) {
    const evidence = harness({ files, extra: [["pre-pr-lanes.mjs check", checkResult]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
    const lane = find(evidence, LANE);
    assert.equal(lane.status, Status.Blocked);
    assert.match(lane.reason, /no summary/);
    assert.equal(evidence.ok, false);
  }
});

test("a turbo run that replayed every task from its cache is cached with its provenance, never passed", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const replay = harness({ files, extra: [["run-bounded.mjs 900 pnpm typecheck:affected", ok("Tasks: 46 successful, 46 total\nCached:    46 cached, 46 total\n>>> FULL TURBO\n")]] });
  const evidence = replay.controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  const typecheck = find(evidence, "typecheck");
  assert.equal(typecheck.status, Status.Cached);
  assert.equal(typecheck.cachedFrom.kind, "turbo-cache");
  assert.equal(typecheck.cachedFrom.detail, "46 cached, 46 total");
  assert.match(typecheck.reason, /did not run/);
  assert.equal(evidence.summary.cached >= 1, true);
  assert.equal(evidence.ok, true);
  const partial = harness({ files, extra: [["run-bounded.mjs 900 pnpm typecheck:affected", ok("Cached:    40 cached, 46 total\n")]] });
  assert.equal(find(partial.controller.verify({ worktree: "/wt", head: HEAD, useCache: false }), "typecheck").status, Status.Passed);
  assert.equal(turboReplay("nothing"), null);
  assert.equal(turboReplay("Cached: 0 cached, 0 total"), null);
});

test("a replayed run is not stored as a pass for the next run to trust", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const replay = harness({ files, extra: [["run-bounded.mjs 900 pnpm typecheck:affected", ok("Cached:    3 cached, 3 total\n")]] });
  replay.controller.verify({ worktree: "/wt", head: HEAD });
  const cache = JSON.parse(replay.written["/gd/vibe-verify-cache.json"]);
  assert.ok(!Object.keys(cache).some((key) => key.includes("typecheck:affected")));
});

const NO_LANE_REPORT = `${REPORT}\nCOVERED BY NO LANE \u2014 1 path(s):\n    e2e/org-issues-list.spec.ts\n  Docs and config often belong here legitimately.\n`;

test("the lane report's covered-by-no-lane paths are surfaced in the evidence and do not change ok", () => {
  assert.deepEqual(uncoveredPaths(NO_LANE_REPORT), ["e2e/org-issues-list.spec.ts"]);
  assert.deepEqual(uncoveredPaths(REPORT), []);
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const withPaths = harness({ files, extra: [["run-bounded.mjs 300 pnpm test:lanes", ok(NO_LANE_REPORT)]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.deepEqual(withPaths.coveredByNoLane, ["e2e/org-issues-list.spec.ts"]);
  assert.equal(withPaths.ok, true);
  const without = harness({ files }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.deepEqual(without.coveredByNoLane, []);
  const notRead = harness({ files }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false, runLanes: false });
  assert.equal(notRead.coveredByNoLane, null);
});

test("regression: with no node_modules, or a runner that did not run, a required check is blocked with the reason, never passed or cached", () => {
  const files = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };
  const bare = harness({ files, installed: false }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  for (const name of ["biome", "source-gates", "typecheck"]) {
    assert.equal(find(bare, name).status, Status.Blocked, name);
    assert.match(find(bare, name).reason, /no node_modules/);
  }
  assert.equal(bare.ok, false);
  const signatures = [
    fail("commit gates DID NOT RUN\n", 1),
    fail("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command \"biome\" not found", 254),
    fail("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'", 1),
  ];
  for (const result of signatures) {
    const evidence = harness({ files, extra: [["run-bounded.mjs 600 pnpm check:source-gates", result], ["run-bounded.mjs 900 pnpm typecheck:affected", result]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
    for (const name of ["source-gates", "typecheck"]) {
      assert.equal(find(evidence, name).status, Status.Blocked, name);
      assert.match(find(evidence, name).reason, /did not run/);
    }
    assert.equal(evidence.ok, false);
  }
  const failed = harness({ files, extra: [["run-bounded.mjs 600 pnpm check:source-gates", fail("rule x failed at apps/app/a.tsx:3")]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(failed, "source-gates").status, Status.Failed);
});

test("a retried or waited heavy run keeps its provenance in the evidence, and a retry's pass is a real pass of the retry (ISS-13585)", () => {
  const line = `run-bounded-result: ${JSON.stringify({ attempts: [{ attempt: 1, workers: 8, exitCode: 137, signature: "sigkill-exit-137" }, { attempt: 2, workers: 4, exitCode: 0, signature: null }], retried: true, firstFailureSignature: "sigkill-exit-137", loadAtStart: { load1: 200, cores: 10, perCore: 20, belowMinimum: true }, waitedMs: 12_000, admission: "waited" })}\n`;
  const { controller } = harness({ files: { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" }, extra: [["run-bounded.mjs 600 pnpm check:source-gates", { status: 0, stdout: "", stderr: line }]] });
  const gates = find(controller.verify({ worktree: "/wt", head: HEAD, useCache: false }), "source-gates");
  assert.equal(gates.status, Status.Passed);
  assert.equal(gates.load.retried, true);
  assert.equal(gates.load.firstFailureSignature, "sigkill-exit-137");
  assert.equal(gates.load.attempts.length, 2);
  assert.equal(gates.load.loadAtStart.perCore, 20);
});

test("a run that was neither retried nor waited carries no load block, and a failure stays a failure with its provenance (ISS-13585)", () => {
  const quiet = `run-bounded-result: ${JSON.stringify({ attempts: [{ attempt: 1, workers: 8, exitCode: 0 }], retried: false, admission: "immediate" })}\n`;
  const failed = `boom\nrun-bounded-result: ${JSON.stringify({ attempts: [{ attempt: 1, exitCode: 137 }, { attempt: 2, exitCode: 137 }], retried: true, firstFailureSignature: "sigkill-exit-137", admission: "waited" })}\n`;
  const { controller } = harness({ files: { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" }, extra: [["run-bounded.mjs 600 pnpm check:source-gates", { status: 0, stdout: "", stderr: quiet }], ["run-bounded.mjs 900 pnpm typecheck:affected", { status: 137, stdout: "", stderr: failed }]] });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "source-gates").load, undefined);
  const typecheck = find(evidence, "typecheck");
  assert.equal(typecheck.status, Status.Failed);
  assert.equal(typecheck.load.retried, true);
  assert.equal(evidence.ok, false);
});

// ISS-13587: independent lanes run in a bounded pool; the evidence contract is unchanged.
const POOL_LANES = ["pnpm test:lint", "pnpm --filter app test", "pnpm test:ci", "pnpm test:e2e"];
const POOL_REPORT = `Lanes:\n${POOL_LANES.map((lane) => `    ${lane}`).join("\n")}\n`;
const POOL_CHECK = POOL_LANES.map((lane) => `MISSING-LANE ${lane}: run it with pre-pr-lanes.mjs run --head <HEAD> --command "${lane}"\n`).join("") + "pre-pr lanes: 4 lanes, 4 missing\n";
const POOL_FILES = { "/wt/package.json": PACKAGE, "/wt/apps/app/a.tsx": "x" };

function pooledHarness({ results = {}, delays = {}, env = {} } = {}) {
  const asyncCalls = [];
  let active = 0;
  let maxActive = 0;
  const runAsync = async (command, args) => {
    const line = [command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    asyncCalls.push(line);
    active += 1; maxActive = Math.max(maxActive, active);
    const lane = POOL_LANES.find((candidate) => line.includes(`--command ${candidate} `) || line.endsWith(`--command ${candidate}`) || line.includes(`--command ${candidate} --report`));
    await new Promise((resolve) => setTimeout(resolve, delays[lane] ?? 1));
    active -= 1;
    return results[lane] ?? ok("recorded pass");
  };
  const harnessed = harness({ files: POOL_FILES, extra: [["run-bounded.mjs 300 pnpm test:lanes", ok(POOL_REPORT)], ["pre-pr-lanes.mjs check", ok(POOL_CHECK)]],
    controllerOptions: { runAsync, env, budget: { snapshot: () => ({ available: 8 }) } } });
  return { ...harnessed, asyncCalls, maxActive: () => maxActive };
}

test("pooled lanes: the records come back in lane-report order whatever finished first, with the e2e lane under the lock", async () => {
  const { controller, asyncCalls, maxActive } = pooledHarness({ delays: { "pnpm test:lint": 40, "pnpm test:ci": 1, "pnpm --filter app test": 10, "pnpm test:e2e": 5 } });
  const evidence = await controller.verifyPooled({ worktree: "/wt", head: HEAD, useCache: false });
  assert.deepEqual(evidence.checks.filter((check) => check.name.startsWith("lane:")).map((check) => check.name), POOL_LANES.map((lane) => `lane: ${lane}`));
  assert.ok(evidence.checks.filter((check) => check.name.startsWith("lane:")).every((check) => check.status === Status.Passed));
  assert.ok(maxActive() <= 2);
  assert.equal(evidence.scheduling.mode, "pooled");
  assert.equal(evidence.scheduling.pooled, 2);
  assert.equal(evidence.scheduling.serial, 2);
  assert.equal(find(evidence, "pnpm test:lint").scheduled, "pool");
  assert.equal(find(evidence, "pnpm --filter app test").scheduled, "serial");
  const locked = asyncCalls.filter((line) => line.includes("e2e-lock.mjs run --head"));
  assert.equal(locked.length, 1, "only the e2e lane goes through the lock");
  assert.match(locked[0], /--command pnpm test:e2e/);
});

test("pooled and serial give the same checks and the same ok when the same lanes fail, and a failed lane makes ok false", async () => {
  const failing = { "pnpm test:ci": fail("1 failed", 1) };
  const pooled = await pooledHarness({ results: failing }).controller.verifyPooled({ worktree: "/wt", head: HEAD, useCache: false });
  const calls = [];
  const serial = harness({ files: POOL_FILES, calls, extra: [["run-bounded.mjs 300 pnpm test:lanes", ok(POOL_REPORT)], ["pre-pr-lanes.mjs check", ok(POOL_CHECK)], ["--command pnpm test:ci", fail("1 failed", 1)]] }).controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  const shape = (evidence) => evidence.checks.map((check) => [check.name, check.status, check.required]);
  assert.deepEqual(shape(pooled), shape(serial));
  assert.equal(find(pooled, "pnpm test:ci").status, Status.Failed);
  assert.equal(pooled.ok, false);
  assert.equal(serial.ok, false);
  assert.deepEqual(pooled.summary, serial.summary);
  assert.equal(serial.scheduling, undefined);
});

test("a timed out or unstartable pooled lane is blocked, never passed; skipped and not-run lanes are never counted as passed", async () => {
  const { controller } = pooledHarness({ results: { "pnpm test:lint": fail("", 124), "pnpm --filter app test": { status: 127, stdout: "", stderr: "spawn pnpm ENOENT" } } });
  const evidence = await controller.verifyPooled({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "pnpm test:lint").status, Status.Blocked);
  assert.equal(find(evidence, "pnpm --filter app test").status, Status.Blocked);
  assert.equal(evidence.ok, false);
  assert.equal(find(evidence, "selected-tests").status, Status.NotRun);
});

test("a budget that is not switched on selects the strictly serial path", () => {
  assert.equal(strictlySerial({ VIBE_HEAVY_BUDGET: "off" }), true);
  assert.equal(strictlySerial({}), true, "the budget is opt-in, so the pool is too");
  assert.equal(strictlySerial({ VIBE_HEAVY_BUDGET: "on" }), false);
});

test("an unreadable lane report is blocked on the pooled path just as on the serial one", async () => {
  const harnessed = harness({ files: POOL_FILES, extra: [["run-bounded.mjs 300 pnpm test:lanes", fail("no report", 1)]], controllerOptions: { env: {}, budget: { snapshot: () => ({ available: 8 }) } } });
  const evidence = await harnessed.controller.verifyPooled({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "lanes").status, Status.Blocked);
  assert.equal(evidence.ok, false);
});
