import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "../../..");
const AGENT = join(ROOT, ".claude/agents/vibe-pr-reviewer.md");
const CASES = join(ROOT, "evals/vibe-pr-reviewer/cases.jsonl");
const RUBRIC = join(ROOT, "evals/vibe-pr-reviewer/rubric.md");

test("vibe PR reviewer is repo-local, read-only and contains all ten current checks", () => {
  const source = readFileSync(AGENT, "utf8");
  assert.match(source, /^---\nname: vibe-pr-reviewer\n/);
  const frontmatter = source.split("---", 3)[1];
  assert.match(frontmatter, /\nmodel: sonnet\n/);
  assert.match(frontmatter, /\ntools: Read, Grep, Glob\n/);
  assert.doesNotMatch(frontmatter, /\bBash\b/);
  assert.doesNotMatch(frontmatter, /\b(?:Write|Edit)\b/);
  for (const heading of ["Vision fit", "Hardcoding and allowed coupling", "Duplication and ownership",
    "Instruction weight", "Tests and evals", "Heavy and real runs", "Repository rules",
    "Sandbox and network", "Correctness regression classes", "Benchmark and eval results"]) {
    assert.match(source, new RegExp(`^## \\d+\\. ${heading}$`, "m"));
  }
  for (const currentRule of ["symphony-alpha path or name is not", "release smoke is optional",
    "claude-sonnet-5-5` at effort `high", "Model-driven vibe evals remain local",
    "Only the authorized benchmark approver can apply `benchmark-not-needed`", "never runs in CI"]) {
    assert.match(source, new RegExp(currentRule.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  for (const field of ["severity", "file:line", "concrete triggering input or state",
    "reproduced evidence", "smallest fix", "regression test or eval"]) assert.match(source, new RegExp(field));
  assert.match(source, /Never edit files, apply labels, post comments, approve, request\nchanges or trigger another review/);
  assert.match(source, /materialized PR metadata[\s\S]*merge-base diff[\s\S]*changed-file list/);
  assert.equal(existsSync(join(ROOT, ".github/workflows/vibe-pr-review.yml")), false);
});

test("frozen PR 362 eval pins three findings and rejects superseded guidance", () => {
  const rows = readFileSync(CASES, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    id: string; input: { pr: number; current_decisions: string[] };
    expected_findings: Array<{ id: string; trigger: string; smallest_fix: string }>;
    must_not_find: string[];
  });
  const fixture = rows.find((row) => row.id === "vibe-pr-362-frozen");
  assert.ok(fixture);
  assert.equal(fixture.input.pr, 362);
  assert.deepEqual(fixture.expected_findings.map((item) => item.id),
    ["duplicated-classifier", "dormant-switch", "version-collision"]);
  assert.ok(fixture.expected_findings.every((item) => item.trigger && item.smallest_fix));
  assert.deepEqual(fixture.must_not_find,
    ["symphony-alpha coupling is hardcoding", "release smoke is required"]);
  const rubric = readFileSync(RUBRIC, "utf8");
  for (const phrase of ["duplicated classifier", "dormant switch", "version collision",
    "Do not report symphony-alpha coupling", "Do not call the release smoke required",
    "Do not require a Codex start-to-PR benchmark arm"]) assert.match(rubric, new RegExp(phrase, "i"));
});

test("reusable benchmark surfaces contain no person names", () => {
  const files = [AGENT, join(ROOT, ".claude/skills/vibe-bench/SKILL.md"),
    join(ROOT, ".github/pull_request_template.md"), join(ROOT, "tools/vibe-bench/README.md"),
    ...["comparison.ts", "report.ts", "developer-report.ts", "pr-body-gate.ts"]
      .map((name) => join(ROOT, "tools/vibe-bench/src", name))];
  const forbidden = new RegExp(["Dan", "iel|O", "choa"].join(""), "i");
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), forbidden, file);
});
