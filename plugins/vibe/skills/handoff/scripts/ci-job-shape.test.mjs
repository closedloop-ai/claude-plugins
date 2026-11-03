import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { jobShapes, tierOf, workflowJobs } from "./ci-job-shape.mjs";

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
