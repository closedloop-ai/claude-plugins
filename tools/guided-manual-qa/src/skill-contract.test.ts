/**
 * Contract checks for the guided-manual-qa skill text. The skill is loaded by
 * both Claude Code and Codex from plugins/code/skills/guided-manual-qa, so
 * these tests pin the rules that must not silently drift out of its markdown.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../plugins/code/skills/guided-manual-qa",
);

function read(relativePath: string): string {
  return readFileSync(join(SKILL_ROOT, relativePath), "utf8");
}

/** Section body from a heading line up to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  expect(start, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const match = line.match(/^(#+) /);
    return match !== null && (match[1]?.length ?? 0) <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "dist" ? [] : textFiles(path);
    return /\.(md|ya?ml)$/.test(name) ? [path] : [];
  });
}

const skill = read("SKILL.md");
const methodology = read("references/plan-methodology.md");
const template = read("references/qa-record-template.md");

describe("guided-manual-qa skill contract", () => {
  it("rebinds results after a head change with the stable patch-id rule", () => {
    const rule = section(methodology, "## Rebind results after a head change");
    expect(rule).toContain("git patch-id --stable");
    expect(rule).toContain("git merge-base <base> <head>");
    expect(rule).toContain("Patch-id unchanged:");
    expect(rule).toContain("Patch-id changed:");
    expect(rule).toContain("reset the rest to `PENDING`");
    expect(rule).toContain("it was not exercised there");
    expect(rule).toContain("never edit an earlier row");
    expect(skill).toContain('apply "Rebind results after a head change"');
  });

  it("keeps checkpoint attempts append-only in the record template", () => {
    const results = section(template, "## Checkpoint results");
    expect(results).toContain(
      "| Attempt | Head | Patch-id | Status | Actual | Confirmed by | Time | Evidence | Carry-forward reason |",
    );
    expect(results).toContain("Never edit an earlier row.");
    expect(section(template, "## Session identity")).toContain(
      "Merge base and stable patch-id at each tested head:",
    );
  });

  it("requires an agent dry run before the human sees a checkpoint", () => {
    const oracle = section(skill, "## Prove the checkpoint oracle before asking the human");
    expect(oracle).toContain("6. **Agent dry run:**");
    expect(oracle).toContain("drive the checkpoint yourself on the same stack before presenting it");
    expect(oracle).toContain("read-only second view of the stored value");
    expect(oracle).toContain("only on disposable data");
    expect(section(skill, "## Guide the human checkpoint by checkpoint")).toContain(
      "never hand the human a check you could run",
    );
  });

  it("records an inconclusive observation as BLOCKED, never PASS", () => {
    expect(skill).toContain(
      'An inconclusive observation is `BLOCKED` with reason "inconclusive", never `PASS`.',
    );
    const bugFix = section(methodology, "## Bug-fix checkpoints");
    expect(bugFix).toContain('is `BLOCKED` with reason "inconclusive", never `PASS`');
    expect(bugFix).toContain("reproduce it yourself on the base, twice");
  });

  it("stores cited evidence outside the worktree and checks pointers after cleanup", () => {
    const finish = section(skill, "## Finish the session");
    expect(finish).toContain("in the record's own directory outside the worktree");
    expect(finish).toContain("confirm every evidence pointer in the record still resolves");
    expect(section(template, "## Final summary")).toContain(
      "Evidence locations (in the record's directory, outside the worktree):",
    );
  });

  it("stays standalone and harness-neutral", () => {
    for (const path of textFiles(SKILL_ROOT)) {
      const text = readFileSync(path, "utf8");
      const name = relative(SKILL_ROOT, path);
      expect(text, `${name} names a workflow skill`).not.toMatch(/cl-execute|cl-sweep/);
      expect(text, `${name} names ClosedLoop outside the graph tool name`).not.toMatch(
        /closedloop(?!-graph)/i,
      );
      expect(text, `${name} uses a harness-only variable`).not.toMatch(
        /\$\{?(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT|CODEX_HOME)/,
      );
    }
    expect(section(skill, "## Prepare a trustworthy local environment")).toContain(
      "`scripts/dist/launch-interactive-browser.mjs`",
    );
    expect(read("agents/openai.yaml")).toContain("$guided-manual-qa");
  });
});
