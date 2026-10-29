import assert from "node:assert/strict";
import test from "node:test";
import { createVerifyRun, evidenceOk, parseLaneCheck, Status, summarize, TIME_LIMITS } from "./verify-run.mjs";

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

function harness({ extra = [], files = { "package.json": PACKAGE, "apps/app/a.tsx": "x" }, calls = [] } = {}) {
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
    ["pre-pr-lanes.mjs check", ok(`MISSING-LANE ${LANE}: run it, with pre-pr-lanes.mjs run --head <HEAD> --command "${LANE}"\n`)],
    ["pre-pr-lanes.mjs run", ok("recorded pass")],
  ];
  const controller = createVerifyRun({
    run: router(routes, calls),
    read: (file) => { if (file in files) return files[file]; throw new Error(`no file ${file}`); },
    write: (file, text) => { written[file] = text; },
    exists: (file) => file in files || file.endsWith("apps/app/a.tsx") || file === "/gd/vibe-verify-cache.json" && "/gd/vibe-verify-cache.json" in files,
    now: () => 1_000,
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

test("a diff with no file Biome checks is no-op with its reason, and that never satisfies the required check", () => {
  const { controller } = harness({ extra: [["diff --name-only", ok("README.md\n")]], files: { "/wt/package.json": PACKAGE } });
  const evidence = controller.verify({ worktree: "/wt", head: HEAD, useCache: false });
  assert.equal(find(evidence, "biome").status, Status.NoOp);
  assert.equal(evidence.ok, false);
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
  assert.equal(evidenceOk([{ status: Status.NoOp, required: true }]), false);
});

test("the lane check output is read back into missing, not-run, main-preexisting and skipped", () => {
  const parsed = parseLaneCheck([
    "MISSING-LANE pnpm a: run it, with pre-pr-lanes.mjs run --head <HEAD> --command \"pnpm a\"",
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
