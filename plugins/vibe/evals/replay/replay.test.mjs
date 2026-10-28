import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport, reportMarkdown } from "./baseline-report.mjs";
import { claudeArgs, contaminationMentions, renderBrief, runClaudeArm, telemetryFromStream } from "./claude-arm.mjs";
import { classifyFiles, TaskClass } from "./classes.mjs";
import { selectCorpus, exclusionReasons, Exclusion } from "./corpus-select.mjs";
import { extractCriteria } from "./criteria.mjs";
import { enrichFromGit } from "./git-enrich.mjs";
import { gradeText, parseGrader } from "./graders.mjs";
import { createLiveDeps } from "./live-deps.mjs";
import { ReplayResult } from "./results.mjs";
import { assertHidden, MIN_RUNS, planRuns, runReplay, ticketBrief } from "./runner.mjs";
import { criteriaScore, minimality, parseNumstat, scoreRun } from "./scorer.mjs";
import { scoreUncertainty } from "./uncertainty.mjs";
import { copyForRun, prepareClone } from "./workspace.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const file = (p, additions = 5, deletions = 1) => ({ path: p, additions, deletions });
const CRITERIA = ["The status pill reads Active for an unknown status", "No other list changes its status wording"];
const ticket = (slug, files, extra = {}) => ({
  slug, title: "Show unknown status as Active", description: "Body", acceptanceCriteria: CRITERIA, mergedAt: "2026-10-01T00:00:00Z",
  pr: { number: 1, mergeBaseSha: "a".repeat(40), mergeSha: "b".repeat(40), files, testFiles: [], ...extra },
});

// M1
test("criteria are the list items under the Acceptance criteria heading only", () => {
  const body = "# T\n\n- not a criterion\n\n## Acceptance criteria\n\n1. First\n- [ ] Second\n* Third\n\n## Boundary\n- not this either\n";
  assert.deepEqual(extractCriteria(body), ["First", "Second", "Third"]);
  assert.deepEqual(extractCriteria("No such section\n- item"), []);
  assert.deepEqual(extractCriteria(undefined), []);
});

test("classes follow the plan's class table", () => {
  assert.equal(classifyFiles([]), null);
  assert.equal(classifyFiles([file("apps/prototypes/a.tsx")]), TaskClass.Mockup);
  assert.equal(classifyFiles([file("docs/a.md")]), TaskClass.DocsConfig);
  assert.equal(classifyFiles([file("packages/app/a.tsx", 2, 1)]), TaskClass.TrivialUi);
  assert.equal(classifyFiles([file("packages/app/a.tsx"), file("packages/app/b.tsx")]), TaskClass.UiFeature);
  assert.equal(classifyFiles([file("apps/api/a.ts")]), TaskClass.Backend);
  assert.equal(classifyFiles([file("packages/app/cost-card.tsx")]), TaskClass.DataMetric);
});

test("a ticket is excluded for each reason it cannot be replayed fairly", () => {
  assert.deepEqual(exclusionReasons({ slug: "ISS-1", pr: null }), [Exclusion.NoLinkedPr]);
  assert.deepEqual(exclusionReasons({ ...ticket("ISS-2", [file("apps/api/a.ts")], { testFiles: ["apps/api/a.test.ts"] }), acceptanceCriteria: ["short"] }), [Exclusion.WeakCriteria]);
  assert.deepEqual(exclusionReasons(ticket("ISS-3", [file("apps/api/a.ts"), file("packages/database/prisma/migrations/1/migration.sql")], { testFiles: ["x.test.ts"] })), [Exclusion.NeedsMigration]);
  assert.deepEqual(exclusionReasons(ticket("ISS-4", [file("apps/api/a.ts")], { testFiles: ["x.test.ts"], needsFlag: true })), [Exclusion.NeedsFlag]);
  assert.deepEqual(exclusionReasons(ticket("ISS-5", [file("apps/api/a.ts")])), [Exclusion.NoOracle]);
  assert.deepEqual(exclusionReasons(ticket("ISS-6", [])), [Exclusion.Unclassifiable]);
  assert.deepEqual(exclusionReasons(ticket("ISS-7", [file("apps/api/a.ts")], { testFiles: ["x.test.ts"] })), []);
});

test("selection is stratified, newest first, deterministic and reports shortfalls", () => {
  const api = (slug, mergedAt) => ({ ...ticket(slug, [file(`apps/api/${slug}.ts`)], { testFiles: [`${slug}.test.ts`] }), mergedAt });
  const input = [api("ISS-10", "2026-10-01T00:00:00Z"), api("ISS-11", "2026-10-03T00:00:00Z"), api("ISS-12", "2026-10-03T00:00:00Z"), api("ISS-13", undefined),
    ticket("ISS-20", [file("docs/a.md")]), ticket("ISS-30", [file("apps/api/a.ts")])];
  const first = selectCorpus(input, { perClass: 2 });
  assert.deepEqual(first.selected.filter((t) => t.taskClass === TaskClass.Backend).map((t) => t.slug), ["ISS-11", "ISS-12"]);
  assert.equal(first.selected.find((t) => t.slug === "ISS-20").oracle, "graders");
  assert.deepEqual(first.excluded, [{ slug: "ISS-30", reasons: [Exclusion.NoOracle] }]);
  assert.equal(first.shortfall[TaskClass.Backend], undefined);
  assert.equal(first.shortfall[TaskClass.DocsConfig], 1);
  assert.deepEqual(selectCorpus([...input].reverse(), { perClass: 2 }), first);
  assert.throws(() => selectCorpus(input, { perClass: 0 }), /positive integer/);
});

// git-backed pieces: a repository with a parent commit and a squash-merge-shaped child
function makeRepo(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-replay-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  const write = (name, text) => { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), text); };
  git("init", "--quiet", "--initial-branch=main");
  write("src/a.js", "export const a = 1;\n");
  git("add", "-A"); git("commit", "--quiet", "-m", "parent");
  const parent = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "feature");
  write("src/a.js", "export const a = 2;\nexport const b = 3;\n");
  write("src/a.test.js", "ok\n");
  git("add", "-A"); git("commit", "--quiet", "-m", "the change");
  git("checkout", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "-m", "merge", "feature");
  return { dir, git, parent, merge: git("rev-parse", "HEAD") };
}

test("enrichment reads the parent, files and test files of a merged change from git", (t) => {
  const { dir, parent, merge } = makeRepo(t);
  const enriched = enrichFromGit({ repo: dir, mergeSha: merge });
  assert.equal(enriched.mergeBaseSha, parent);
  assert.deepEqual(enriched.files.map((f) => [f.path, f.additions, f.deletions]), [["src/a.js", 2, 1], ["src/a.test.js", 1, 0]]);
  assert.deepEqual(enriched.testFiles, ["src/a.test.js"]);
  assert.throws(() => enrichFromGit({ repo: dir, mergeSha: "f".repeat(40) }));
});

// M2
test("an arm's brief is the ticket text and nothing that identifies the human change", () => {
  const brief = ticketBrief(ticket("ISS-1", [file("apps/api/a.ts")]));
  assert.deepEqual(Object.keys(brief).sort(), ["acceptanceCriteria", "description", "slug", "title"]);
  assert.doesNotThrow(() => assertHidden(brief));
  assert.throws(() => assertHidden({ ...brief, pr: {} }), /pr/);
  assert.throws(() => assertHidden({ ...brief, mergeSha: "x" }), /mergeSha/);
  const text = renderBrief(brief);
  assert.ok(text.includes(CRITERIA[0]) && !text.includes("ISS-1"));
  assert.equal(renderBrief(ticketBrief({ ...ticket("ISS-1", []), brief: "  Human written.  " })), "Human written.");
});

test("runs interleave arms per ticket and need at least the minimum runs and distinct arms", () => {
  const corpus = [ticket("ISS-1", [file("apps/api/a.ts")])];
  const plan = planRuns({ corpus, arms: [{ name: "baseline" }, { name: "candidate" }] });
  assert.equal(plan.length, 2 * MIN_RUNS);
  assert.deepEqual(plan.slice(0, 3).map((s) => [s.arm, s.run]), [["baseline", 1], ["candidate", 1], ["baseline", 2]]);
  assert.throws(() => planRuns({ corpus, arms: [{ name: "a" }], runs: MIN_RUNS - 1 }), /at least/);
  assert.throws(() => planRuns({ corpus, arms: [{ name: "a" }, { name: "a" }] }), /distinctly named/);
});

test("a failing step is a BLOCKED record with its reason and the replay continues", async () => {
  const corpus = [ticket("ISS-1", [file("apps/api/a.ts")])];
  let calls = 0;
  const deps = {
    prepareWorkspace: () => ({ workspace: "/w" }),
    runArm: ({ run }) => { calls += 1; if (run === 2) throw new Error("claude exited"); return { outputText: "ok", telemetry: { wallTimeMs: 5 } }; },
    captureDiff: () => ({ numstat: "1\t0\tx", diffText: "d" }),
  };
  const records = await runReplay({ corpus, arms: [{ name: "baseline" }], deps });
  assert.equal(calls, MIN_RUNS);
  assert.deepEqual(records.map((r) => r.result), [ReplayResult.Pass, ReplayResult.Blocked, ReplayResult.Pass]);
  assert.equal(records[1].reason, "claude exited");
});

test("a prepared clone cannot reach the merge commit, saves the oracle apart, and copies per run", (t) => {
  const { dir, parent, merge } = makeRepo(t);
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-replay-work-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const t1 = { slug: "ISS-1", pr: { mergeSha: merge, mergeBaseSha: parent, testFiles: ["src/a.test.js"] } };
  const prepared = prepareClone({ sourceRepo: dir, ticket: t1, workspace: path.join(work, "clone"), oracleDir: path.join(work, "oracle") });
  assert.equal(readFileSync(path.join(work, "oracle", "files", "src/a.test.js"), "utf8"), "ok\n");
  assert.equal(existsSync(path.join(prepared.workspace, "src/a.test.js")), false, "an added test is absent from the tree");
  assert.equal(execFileSync("git", ["-C", prepared.workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), parent);
  assert.equal(spawnSync("git", ["-C", prepared.workspace, "cat-file", "-e", `${merge}^{commit}`]).status !== 0, true);
  assert.equal(execFileSync("git", ["-C", prepared.workspace, "remote"], { encoding: "utf8" }).trim(), "");
  const run = copyForRun({ prepared: prepared.workspace, dest: path.join(work, "baseline-1") });
  assert.equal(readFileSync(path.join(run, "src/a.js"), "utf8"), "export const a = 1;\n");
  assert.throws(() => copyForRun({ prepared: prepared.workspace, dest: run }), /already exists/);
  assert.throws(() => prepareClone({ sourceRepo: dir, ticket: t1, workspace: path.join(work, "clone"), oracleDir: path.join(work, "o2") }), /already exists/);
  assert.throws(() => prepareClone({ sourceRepo: dir, ticket: { slug: "ISS-2", pr: {} }, workspace: path.join(work, "c3"), oracleDir: path.join(work, "o3") }), /mergeSha/);
});

test("the Claude arm runs the writer alone with no MCP, gh or push, and a candidate plugin only when given", () => {
  const brief = ticketBrief(ticket("ISS-1", []));
  const baseline = claudeArgs({ arm: { name: "baseline" }, brief });
  assert.equal(baseline[baseline.indexOf("--agent") + 1], "vibe:vibe-change-worker");
  assert.ok(baseline.includes("--strict-mcp-config") && !baseline.includes("--plugin-dir"));
  assert.deepEqual(baseline.slice(baseline.indexOf("--disallowedTools") + 1, baseline.indexOf("--disallowedTools") + 3), ["Bash(gh:*)", "Bash(git push:*)"]);
  assert.equal(claudeArgs({ arm: { name: "c", pluginDir: "/p" }, brief }).at(-1), "/p");
});

test("arm telemetry comes from the stream: wall time from the result event, unmeasured fields null", () => {
  const stream = [
    { type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Agent", input: {} }, { type: "tool_use", name: "Bash", input: {} }] } },
    { type: "result", duration_ms: 4000, total_cost_usd: 1.25, is_error: false },
  ].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(telemetryFromStream(stream), {
    workerLaunches: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    wallTimeMs: 4000, costUsd: 1.25, isError: false, environmentMinutes: null, slotWaitMs: null,
  });
  const none = telemetryFromStream("");
  assert.equal(none.workerLaunches, null);
  assert.equal(none.wallTimeMs, null);
  assert.equal(contaminationMentions("see ISS-1 and #1 and bbbbbbbbbb", { slug: "ISS-1", prNumber: 1, mergeSha: "b".repeat(40) }), 3);
});

test("runClaudeArm writes the stream and surfaces a spawn failure", (t) => {
  const out = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-replay-arm-")));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const brief = ticketBrief(ticket("ISS-1", []));
  const seen = [];
  const run = (command, args, options) => { seen.push([command, options.cwd]); return { stdout: `${JSON.stringify({ type: "result", duration_ms: 7 })}\n`, status: 0 }; };
  const result = runClaudeArm({ arm: { name: "baseline" }, brief, workspace: "/w", outDir: path.join(out, "o"), run });
  assert.deepEqual(seen, [["claude", "/w"]]);
  assert.equal(result.telemetry.wallTimeMs, 7);
  assert.ok(readFileSync(path.join(out, "o", "stream.jsonl"), "utf8").includes("duration_ms"));
  assert.throws(() => runClaudeArm({ arm: { name: "b" }, brief, workspace: "/w", outDir: path.join(out, "p"), run: () => ({ error: new Error("ENOENT") }) }), /ENOENT/);
});

test("live deps copy per run, capture the diff and run each oracle file once with its exit code", async (t) => {
  const { dir, git, parent, merge } = makeRepo(t);
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-replay-live-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const t1 = { slug: "ISS-1", pr: { number: 9, mergeSha: merge, mergeBaseSha: parent, testFiles: ["src/a.test.js"], files: [] } };
  const ran = [];
  const deps = createLiveDeps({
    sourceRepo: dir, workRoot: work, testCommand: (f) => ["node", "-e", `process.exit(${f.includes("a.test") ? 3 : 0})`],
    run: (command, args, options) => { ran.push(command); return spawnSync(command, args, options); },
    runClaude: ({ workspace }) => { writeFileSync(path.join(workspace, "src/a.js"), "export const a = 9;\n"); return { outputText: "mentions ISS-1", telemetry: null }; },
  });
  const { workspace } = await deps.prepareWorkspace({ ticket: t1, arm: { name: "baseline" }, run: 1 });
  const output = await deps.runArm({ arm: { name: "baseline" }, brief: {}, workspace, run: 1, ticket: t1 });
  assert.equal(output.contamination, 1);
  const diff = deps.captureDiff({ workspace, baseSha: parent });
  assert.match(diff.numstat, /1\t1\tsrc\/a\.js/);
  const results = deps.runTests({ workspace, testFiles: t1.pr.testFiles, ticket: t1 });
  assert.deepEqual(results, [{ path: "src/a.test.js", exitCode: 3 }]);
  assert.equal(readFileSync(path.join(workspace, "src/a.test.js"), "utf8"), "ok\n", "the human version is installed");
  assert.ok(git("rev-parse", "HEAD"));
  assert.equal((await deps.prepareWorkspace({ ticket: t1, arm: { name: "candidate" }, run: 1 })).workspace.endsWith("candidate-1"), true);
});

// M3
test("numstat parsing, binary files and minimality against the human diff", () => {
  const agent = parseNumstat("5\t2\tsrc/a.ts\n-\t-\timg.png\n3\t0\textra.ts");
  assert.deepEqual(agent[1], { path: "img.png", additions: 0, deletions: 0 });
  const m = minimality(agent, [file("src/a.ts", 4, 1), file("src/missed.ts", 1, 1)]);
  assert.equal(m.agentLines, 10);
  assert.equal(m.humanLines, 7);
  assert.equal(m.lineRatio, 10 / 7);
  assert.equal(m.overlap, 1 / 4);
  assert.deepEqual(m.extraFiles, ["extra.ts", "img.png"]);
  assert.deepEqual(m.missedFiles, ["src/missed.ts"]);
  assert.equal(minimality([], []).lineRatio, null);
});

const record = (extra = {}) => ({ slug: "ISS-1", taskClass: TaskClass.Backend, arm: "baseline", run: 1, result: ReplayResult.Pass, workspace: "/w", numstat: "5\t1\tsrc/a.ts", diffText: "+added line", ...extra });

test("functional is FAIL when any oracle file exits nonzero, PASS when all exit zero, BLOCKED when one did not run", async () => {
  const t1 = ticket("ISS-1", [file("src/a.ts")], { testFiles: ["a.test.ts", "b.test.ts"] });
  const score = (runTests, rec = record()) => scoreRun({ ticket: t1, record: rec, deps: { runTests } });
  const fail = await score(() => [{ path: "a.test.ts", exitCode: 0 }, { path: "b.test.ts", exitCode: 1 }]);
  assert.deepEqual([fail.functional.result, fail.functional.passedFiles, fail.functional.failedFiles], [ReplayResult.Fail, 1, ["b.test.ts"]]);
  assert.equal((await score(() => [{ path: "a.test.ts", exitCode: 0 }, { path: "b.test.ts", exitCode: 0 }])).functional.result, ReplayResult.Pass);
  assert.equal((await score(() => [{ path: "a.test.ts", exitCode: 0 }])).functional.result, ReplayResult.Blocked, "a missing file result is not a pass");
  assert.equal((await score(() => [{ path: "a.test.ts", exitCode: null }, { path: "b.test.ts", exitCode: 0 }])).functional.result, ReplayResult.Blocked);
  assert.equal((await score(undefined)).functional.result, ReplayResult.Blocked);
  const crashed = await score(() => assert.fail("must not run"), { ...record(), result: ReplayResult.Blocked, reason: "claude exited" });
  assert.deepEqual([crashed.functional.result, crashed.functional.reason, crashed.minimality], [ReplayResult.Blocked, "claude exited", null]);
});

test("a change with no tests is NOT_APPLICABLE, and an oracle file the agent edited is reported", async () => {
  const none = await scoreRun({ ticket: ticket("ISS-1", [file("src/a.ts")]), record: record(), deps: {} });
  assert.equal(none.functional.result, ReplayResult.NotApplicable);
  const t1 = ticket("ISS-1", [file("src/a.ts")], { testFiles: ["src/a.ts"] });
  const edited = await scoreRun({ ticket: t1, record: record(), deps: { runTests: () => [{ path: "src/a.ts", exitCode: 0 }] } });
  assert.deepEqual(edited.oracleFilesEditedByAgent, ["src/a.ts"]);
});

test("graders score the diff; llm graders need a judge, and a run without diff text is blocked", async () => {
  const regex = parseGrader("---\ntype: regex\nmatch: contains\nflags: i\npattern: 'ADDED'\n---\nBody", "g1");
  const llm = parseGrader("---\ntype: llm\ncriteria: |\n  Reads Active.\n---\nBody", "g2");
  const t1 = ticket("ISS-1", [file("src/a.ts")]);
  const scored = await scoreRun({ ticket: t1, record: record(), deps: { graders: [regex, llm] } });
  assert.deepEqual(scored.criteria.map((c) => c.result), [ReplayResult.Pass, ReplayResult.Blocked]);
  assert.deepEqual(scored.criteriaScore, { passed: 1, decided: 1, blocked: 1, fraction: 1 });
  const judged = await scoreRun({ ticket: t1, record: record(), deps: { graders: [llm], judge: async ({ criteria }) => criteria === "Reads Active." } });
  assert.equal(judged.criteria[0].result, ReplayResult.Pass);
  const noDiff = await scoreRun({ ticket: t1, record: record({ diffText: null }), deps: { graders: [regex] } });
  assert.equal(noDiff.criteria[0].result, ReplayResult.Blocked);
  assert.equal(criteriaScore([]).fraction, null);
  assert.equal((await gradeText([regex], "none")).at(0).result, ReplayResult.Fail);
});

// M5
test("without flagged assumptions every flag-dependent number is null and rework is still scored", () => {
  const score = scoreUncertainty({ findings: [{ id: "c1", wrongAssumption: true }, { id: "c2", wrongAssumption: false }], rework: { fixCommits: 2, engGrade: "Medium" } });
  assert.deepEqual([score.flagged, score.flaggedMatchedReview, score.unflaggedWrong, score.flagPrecision, score.wrongCaught], [null, null, null, null, null]);
  assert.equal(score.wrongFindings, 1);
  assert.deepEqual(score.rework, { fixCommits: 2, reviewRounds: null, survival14: null, survival30: null, designGrade: null, engGrade: "Medium" });
});

test("flagged assumptions are matched by label, never by wording", () => {
  const score = scoreUncertainty({
    flagged: [{ id: "a1", text: "same words" }, { id: "a2", text: "other" }, { id: "a3", text: "third" }],
    findings: [
      { id: "c1", text: "same words", wrongAssumption: true },
      { id: "c2", wrongAssumption: true, flaggedAs: "a1" },
      { id: "c3", wrongAssumption: true, flaggedAs: "unknown-id" },
      { id: "c4", wrongAssumption: false, flaggedAs: "a2" },
    ],
  });
  assert.deepEqual(score.flaggedMatchedReview, ["a1"]);
  assert.deepEqual(score.unflaggedWrong, ["c1", "c3"]);
  assert.equal(score.flagPrecision, 1 / 3);
  assert.equal(score.wrongCaught, 1 / 3);
  assert.equal(scoreUncertainty({ flagged: [] }).flagPrecision, null, "no flags is no ratio, not zero");
});

test("rework values are validated, not coerced", () => {
  for (const rework of [{ fixCommits: -1 }, { reviewRounds: 1.5 }, { survival14: 101 }, { engGrade: "Great" }]) {
    assert.throws(() => scoreUncertainty({ rework }), /must be/, JSON.stringify(rework));
  }
});

// M6 and CLI
const baseScore = (extra = {}) => ({
  slug: "ISS-1", taskClass: TaskClass.Backend, arm: "baseline", run: 1,
  functional: { result: ReplayResult.Pass }, criteriaScore: { fraction: null }, minimality: { lineRatio: 2, extraFiles: ["x"] }, telemetry: null, uncertainty: null, ...extra,
});

test("the report averages only what runs measured and leaves the rest n/a", () => {
  const scores = [
    baseScore({ run: 1, telemetry: { wallTimeMs: 1000, inputTokens: 10, workerLaunches: null } }),
    baseScore({ run: 2, functional: { result: ReplayResult.Fail }, minimality: { lineRatio: 4, extraFiles: [] }, telemetry: { wallTimeMs: 3000, inputTokens: null } }),
    baseScore({ run: 3, functional: { result: ReplayResult.Blocked } }),
    baseScore({ slug: "ISS-2", arm: "candidate" }),
  ];
  const report = buildReport(scores);
  const baseline = report.rows.find((r) => r.arm === "baseline");
  assert.deepEqual([baseline.runs, baseline.functionalDecided, baseline.functionalBlocked, baseline.functionalPassRate], [3, 2, 1, 0.5]);
  assert.equal(baseline.wallTimeMsMean, 2000);
  assert.equal(baseline.inputTokensMean, 10);
  assert.equal(baseline.workerLaunchesMean, null);
  assert.equal(baseline.unflaggedWrongTotal, null);
  assert.deepEqual(report.underRun, [{ slug: "ISS-2", arm: "candidate", runs: 1 }]);
  const md = reportMarkdown(report);
  assert.match(md, /\| backend \| baseline \| 3 \| 0\.5 \(2 decided, 1 blocked\)/);
  assert.match(md, /Fewer than 3 runs: ISS-2 \(candidate, 1\)/);
  assert.ok(!md.includes("NaN") && !md.includes("undefined"));
});

test("the CLI selects, plans and reports from files", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-replay-cli-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  writeFileSync(path.join(dir, "tickets.json"), JSON.stringify([ticket("ISS-7", [file("apps/api/a.ts")], { testFiles: ["x.test.ts"] })]));
  const selected = JSON.parse(run("select", "--tickets", path.join(dir, "tickets.json")).stdout);
  assert.deepEqual(selected.selected.map((s) => s.slug), ["ISS-7"]);
  writeFileSync(path.join(dir, "corpus.json"), JSON.stringify(selected.selected));
  assert.equal(JSON.parse(run("plan", "--corpus", path.join(dir, "corpus.json"), "--arms", "baseline,candidate").stdout).length, 2 * MIN_RUNS);
  assert.equal(run("plan", "--corpus", path.join(dir, "corpus.json")).status, 2);
  writeFileSync(path.join(dir, "scores.json"), JSON.stringify([baseScore()]));
  assert.match(run("report", "--scores", path.join(dir, "scores.json"), "--markdown").stdout, /^\| Class \| Arm/);
  assert.equal(run("nonsense").status, 2);
});
