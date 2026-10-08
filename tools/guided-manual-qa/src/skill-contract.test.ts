/**
 * Contract checks for the guided-manual-qa skill text. The skill is loaded by
 * both Claude Code and Codex from plugins/vibe/skills/guided-manual-qa, so
 * these tests pin the rules that must not silently drift out of its markdown.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../plugins/vibe/skills/guided-manual-qa",
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

  it("proves service readiness beyond a launcher or wrapper report", () => {
    const environment = section(skill, "## Prepare a trustworthy local environment");
    expect(environment).toContain(
      "Before choosing a control launcher that binds fixed ports, verify whether it supports isolated ports, sessions, or project names for concurrent workers.",
    );
    expect(environment).toContain(
      "use a documented manual isolated stack and record exact process ownership proof",
    );
    expect(environment).toContain("reporting `started` is not readiness by itself");
    expect(environment).toContain(
      "prove the actual listener and the route-owned ready selector before presenting a checkpoint",
    );
    expect(environment).toContain("run one bounded foreground diagnostic of the same documented command");
    expect(environment).toContain("then stop that diagnostic before trying a fallback");
  });

  it("routes to the human only what E2E and the agent cannot verify", () => {
    expect(skill).toContain(
      "Present a checkpoint to the human only when both are true: passing E2E on the current head does not already verify it, and the agent cannot reliably verify it itself",
    );
    const oracle = section(skill, "## Prove the checkpoint oracle before asking the human");
    expect(oracle).toContain("Do not turn a plausible expectation into a human checkpoint.");
    expect(oracle).toContain("Record `AGENT_VERIFIED` with its `agent-observed` evidence, and do not present the checkpoint");
    expect(oracle).toContain("the checkpoint is not `AGENT_VERIFIED`; route it to the human");
    expect(oracle).toContain("Never silently pass either.");
    expect(skill).toContain("close one as `AGENT_VERIFIED` or `E2E_COVERED`, never as `PASS`");
    const finish = section(skill, "## Finish the session");
    expect(finish).toContain(
      "separate counts for human-confirmed `PASS` and `FAIL`, `AGENT_VERIFIED`, `E2E_COVERED`, and `BLOCKED`",
    );
    expect(finish).toContain("each checkpoint left to the human and why it needed a human");
    expect(section(template, "## Checkpoint results")).toContain(
      'For `AGENT_VERIFIED`, "Confirmed by" is `agent-observed`, never a human name.',
    );
    expect(section(template, "## Final summary")).toContain(
      "Checkpoints left to the human, and why each needed a human:",
    );
  });

  it("lets the agent verify in its own context before any human window opens", () => {
    const environment = section(skill, "## Prepare a trustworthy local environment");
    expect(environment).toContain(
      "For your own verification, use a headless or displayless context with the same preloaded state",
    );
    expect(environment).toContain("it needs no human checkpoint to exist");
    expect(environment).toContain(
      'Launch the visible window the user requested only for a checkpoint routed to the human, at step 3 of "Guide the human checkpoint by checkpoint"',
    );
    expect(section(skill, "## Guide the human checkpoint by checkpoint")).toContain(
      "3. If the checkpoint asks the human to inspect a UI, open the requested interactive window or app yourself",
    );
  });

  it("routes an inconclusive agent observation to the human before BLOCKED", () => {
    expect(section(skill, "## Prove the checkpoint oracle before asking the human")).toContain(
      'If the human cannot observe the discriminating state either, record `BLOCKED` with reason "inconclusive".',
    );
    const bugFix = section(methodology, "## Bug-fix checkpoints");
    expect(bugFix).toContain(
      "An agent observation that does not show the discriminating state on the reported surface routes the checkpoint to the human under that rule.",
    );
    expect(bugFix).toContain("A human observation that does not show it");
    expect(bugFix).toContain("the fix stays unverified");
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
