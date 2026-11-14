import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, unlinkSync, renameSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeHome, makeCheckout, SYMPHONY_PATH_POLICY } from "../../vibe/scripts/test-fixtures.mjs";
import { agentsTestCommand, jobShapes, repositoryLaneReportProblems, tierOf, workflowJobs, workflowLaneDefinitions, laneSourceBootstrap } from "./ci-job-shape.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-job-shape.mjs");
const WORKFLOW = `name: PR Tests
on: [pull_request, merge_group]
jobs:
  storybook-build:
    needs: [batch-target]
    if: \${{ github.event_name != 'pull_request' && github.event_name != 'merge_group' }}
    steps:
      - uses: actions/checkout@v7
      - run: pnpm --filter storybook validate:catalog
  lint:
    env:
      CI_DIFF_BASE_REF: origin/main
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - run: pnpm lint
concurrency: x
`;
const TIERS = "| Job | Tier | Responsibility |\n| --- | --- | --- |\n| `storybook-build` | `batch-only` | lane |\n| `lint` | `merge-group-only` | lane |\n";

test("a check inside a batch-only depth-1 job reports that shape (#9230)", () => {
  assert.deepEqual(workflowJobs(WORKFLOW).map((job) => job.job), ["storybook-build", "lint"]);
  assert.equal(tierOf(TIERS, "storybook-build"), "batch-only");
  assert.equal(tierOf(TIERS, "build"), "unlisted");
  const { shapes, missing } = jobShapes([{ workflow: "pr-test.yml", text: WORKFLOW }], TIERS, ["validate:catalog", "pnpm lint", "check:nothing"]);
  const [storybook, lint] = shapes;
  assert.equal(storybook.job, "storybook-build");
  assert.equal(storybook.tier, "batch-only");
  assert.equal(storybook.fetchDepth, 1);
  assert.match(storybook.checkout, /no origin\/main/);
  assert.match(storybook.if, /pull_request/);
  assert.equal(lint.fetchDepth, 0);
  assert.deepEqual(lint.env, ["CI_DIFF_BASE_REF"]);
  assert.deepEqual(missing, ["check:nothing"]);
});

test("the CLI prints each job shape and the needles no job runs", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci-job-shape-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".github", "workflows", "pr-test.yml"), WORKFLOW);
  writeFileSync(path.join(root, ".github", "pr-test-event-tiers.md"), TIERS);
  const run = spawnSync(process.execPath, [SCRIPT, "--worktree", root, "--needle", "validate:catalog", "--needle", "gone"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [shape, missing] = run.stdout.trim().split("\n");
  assert.equal(JSON.parse(shape).tier, "batch-only");
  assert.equal(missing, "NO-JOB gone");
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
});


test("workflow lane definitions expand all twelve repository jobs and preserve exact run recipes", () => {
  const workflow = readFileSync(new URL("../../../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lanes = workflowLaneDefinitions(workflow);
  assert.equal(lanes.length, 12);
  assert.deepEqual(lanes.filter(lane => lane.job !== "tools-ts").map(lane => lane.name),
    ["plugin-version-bump", "plugin-manifest-versions", "lint", "typecheck", "test", "node-tests", "vibe-eval-t0"]);
  const workers = lanes.find(lane => lane.job === "tools-ts" && lane.matrix.tool === "vibe-workers");
  const recipe = JSON.parse(workers.command);
  const steps = recipe.job.steps.filter(step => step.run);
  assert.equal(recipe.job.defaults.run["working-directory"], "tools/vibe-workers");
  assert.equal(recipe.job["runs-on"], "ubuntu-latest");
  assert.equal(recipe.job.steps[0].uses, "actions/checkout@v4");
  assert.equal(steps[0].run, "npm ci");
  assert.equal(steps.at(-1).env.DIST, "plugins/vibe/skills/vibe/scripts/dist");
  assert.equal(steps.at(-1).env.MIN_BUNDLES, "2");
  assert.equal((steps.at(-1).run.match(/^npm run build$/gm) ?? []).length, 2);
  const python = lanes.find(lane => lane.name === "test");
  assert.deepEqual(JSON.parse(python.command).job.steps.filter(step => step.run).map(step => step.run), ["uv sync --frozen --group dev", "uv run pytest plugins/"]);
});

test("workflow discovery refuses ambiguous YAML, dynamic matrices, missing jobs and incomplete run recipes", () => {
  for (const source of ["jobs: {}", "jobs:\n  x:\n    uses: remote/workflow.yml", "jobs:\n  x:\n    steps: []",
    "jobs:\n  x: {steps: [{run: echo ok}]}\n  x: {steps: [{run: echo other}]}",
    "jobs:\n  x:\n    strategy: {matrix: {tool: [a, b]}}\n    steps: [{run: echo ok}]",
    "jobs:\n  x:\n    strategy: {matrix: {include: [{tool: a}, {tool: a}]}}\n    steps: [{run: echo ok}]",
    "jobs:\n  x:\n    steps: [{run: 'echo ${{ matrix.missing }}'}]",
  ]) assert.throws(() => workflowLaneDefinitions(source));
});


test("workflow identity binds runtime, runner, actions, checkout, conditions and timeout or rejects unsupported shapes", () => {
  const source = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    if: true\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@v4\n        with: {fetch-depth: 0}\n      - uses: actions/setup-node@v4\n        with: {node-version: '22'}\n      - uses: astral-sh/setup-uv@v6\n        with: {python-version: '3.13'}\n      - run: echo pass\n";
  const recipe = workflowLaneDefinitions(source)[0].command;
  for (const [name, changed] of [
    ["Node", source.replace("'22'", "'24'")], ["Python", source.replace("'3.13'", "'3.14'")],
    ["runner", source.replace("ubuntu-latest", "macos-latest")], ["checkout", source.replace("fetch-depth: 0", "fetch-depth: 1")],
    ["setup action", source.replace("setup-node@v4", "setup-node@v5")], ["condition", source.replace("if: true", "if: false")],
    ["timeout", source.replace("timeout-minutes: 10", "timeout-minutes: 11")],
    ["container", source.replace("    steps:", "    container: python:3.13\n    steps:")],
    ["service", source.replace("    steps:", "    services: {cache: {image: 'redis:7'}}\n    steps:")],
  ]) {
    let actual; try { actual = workflowLaneDefinitions(changed)[0].command; } catch { continue; }
    assert.notEqual(actual, recipe, name);
  }
});


test("bootstrap inspects the whole final workflow set, not only the captured workflow file", t => {
  const f = makeHome("lane-final-set-"); t.after(f.cleanup);
  const wt = path.join(f.root, "wt");
  const policy = JSON.parse(SYMPHONY_PATH_POLICY); delete policy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo pass\n";
  makeCheckout({ ...f, checkout: wt, files: { "vibe-handoff-paths.json": JSON.stringify(policy), ".github/workflows/ci.yml": workflow } });
  const base = git(wt, ["rev-parse", "HEAD"], f.home);
  writeFileSync(path.join(wt, "vibe-handoff-paths.json"), JSON.stringify({ ...policy, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } }));
  assert.ok(laneSourceBootstrap(wt, base, base));
  writeFileSync(path.join(wt, ".github/workflows/second.yml"), workflow);
  assert.equal(laneSourceBootstrap(wt, base, base), null);
});


test("unresolved runtime fields and unrecognized execution semantics fail closed", () => {
  const source = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with: {node-version: '22'}\n      - run: echo pass\n";
  assert.equal(workflowLaneDefinitions(source).length, 1);
  for (const changed of [
    source.replace("ubuntu-latest", "'${{ inputs.runner }}'"),
    source.replace("'22'", "'${{ inputs.node }}'"),
    source.replace("setup-node@v4", "setup-node@${{ inputs.ref }}"),
    source.replace("    steps:", "    if: ${{ fromJSON(inputs.enabled) }}\n    steps:"),
    source.replace("    steps:", "    if: 'true}}'\n    steps:"),
    source.replace("    steps:", "    env: {run: '${{ secrets.token }}'}\n    steps:"),
    source.replace("    steps:", "    timeout-minutes: '${{ inputs.timeout }}'\n    steps:"),
    source.replace("    steps:", "    unsupported-execution-field: true\n    steps:"),
  ]) assert.throws(() => workflowLaneDefinitions(changed));
});


test("candidate workflow additions, removals, renames, bytes, symlinks and modes cannot authorize migration", t => {
  const f = makeHome("lane-candidate-mutations-"); t.after(f.cleanup);
  const wt = path.join(f.root, "wt"); const policy = JSON.parse(SYMPHONY_PATH_POLICY); delete policy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo pass\n";
  makeCheckout({ ...f, checkout: wt, files: { "vibe-handoff-paths.json": JSON.stringify(policy), ".github/workflows/ci.yml": workflow } });
  const base = git(wt, ["rev-parse", "HEAD"], f.home); const file = path.join(wt, ".github/workflows/ci.yml");
  writeFileSync(path.join(wt, "vibe-handoff-paths.json"), JSON.stringify({ ...policy, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } }));
  const reset = () => { for (const name of ["ci.yml", "other.yml"]) { try { unlinkSync(path.join(wt, ".github/workflows", name)); } catch {} } writeFileSync(file, workflow); chmodSync(file, 0o644); };
  for (const mutate of [
    () => writeFileSync(path.join(wt, ".github/workflows/other.yml"), workflow),
    () => unlinkSync(file), () => renameSync(file, path.join(wt, ".github/workflows/other.yml")),
    () => writeFileSync(file, workflow.replace("echo pass", "echo changed")), () => chmodSync(file, 0o755),
    () => { unlinkSync(file); symlinkSync("../../README.md", file); },
  ]) {
    assert.ok(laneSourceBootstrap(wt, base, base), "positive control"); mutate();
    assert.equal(laneSourceBootstrap(wt, base, base), null); reset();
  }
});


test("AGENTS.md names the test command: the first command span on a line about tests", () => {
  assert.equal(agentsTestCommand("Build with `pnpm build`.\nRun the suite with `pnpm test` before pushing."), "pnpm test");
  assert.equal(agentsTestCommand("- `uv run pytest plugins` runs the tests"), "uv run pytest plugins");
  assert.equal(agentsTestCommand("Test the change with `npm run test:unit`."), "npm run test:unit");
  assert.equal(agentsTestCommand("Tests: see the CI workflow."), null);
  assert.equal(agentsTestCommand(undefined), null);
});

test("with no declaration a lane command is the AGENTS.md test command, and a committed workflow is a lane source", (t) => {
  const { root, home, cleanup } = makeHome("lane-default-");
  t.after(cleanup);
  const checkout = path.join(root, "repo");
  makeCheckout({ root, home, checkout, files: { "AGENTS.md": "Run `npm test` before you push.\n",
    ".github/workflows/ci.yml": "name: CI\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n" } });
  const commit = git(checkout, ["rev-parse", "HEAD"], home);
  const report = (source) => ({ source, matches: [] });
  assert.deepEqual(repositoryLaneReportProblems(report({ kind: "command", command: "npm test" }), checkout, commit), []);
  assert.match(repositoryLaneReportProblems(report({ kind: "command", command: "npm run lint" }), checkout, commit)[0],
    /test command AGENTS\.md names/);
  const content = readFileSync(path.join(checkout, ".github/workflows/ci.yml"));
  const sha256 = createHash("sha256").update(content).digest("hex");
  const workflow = { kind: "github-workflow", path: ".github/workflows/ci.yml", commit, sha256 };
  const lanes = workflowLaneDefinitions(content.toString("utf8"));
  assert.deepEqual(repositoryLaneReportProblems({ source: workflow, matches: lanes.map(({ name, command }) => ({ name, command })) }, checkout, commit), []);
  const labeler = "name: Labeler\non: [pull_request]\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo label\n";
  writeFileSync(path.join(checkout, ".github/workflows/labeler.yml"), labeler);
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "second workflow"], home);
  const second = git(checkout, ["rev-parse", "HEAD"], home);
  const labelerSource = { kind: "github-workflow", path: ".github/workflows/labeler.yml", commit: second, sha256: createHash("sha256").update(labeler).digest("hex") };
  const labelerLanes = workflowLaneDefinitions(labeler).map(({ name, command }) => ({ name, command }));
  assert.match(repositoryLaneReportProblems({ source: labelerSource, matches: labelerLanes }, checkout, second)[0], /must be the repository's only workflow/,
    "with two workflows and no declaration, the report cannot choose the one it ran");
  assert.match(repositoryLaneReportProblems({ source: { ...workflow, commit: second }, matches: lanes.map(({ name, command }) => ({ name, command })) }, checkout, second)[0],
    /must be the repository's only workflow/);
});
