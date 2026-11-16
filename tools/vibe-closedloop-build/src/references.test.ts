import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClosedLoopVibe, DEFAULT_PATHS } from "./build.js";

// A Markdown file reference: a backticked name or a link target ending in `.md` (`x.md`, `references/x.md`, `../x.md`).
const REFERENCE = /`([A-Za-z0-9_./-]+\.md)`|\]\(([A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\)/g;

/**
 * Files of the repository a session works in, never of the plugin: built text names them by these exact names, as
 * main's text does.
 */
const TARGET_REPOSITORY = new Set([
  "AGENTS.md", "CLAUDE.md", "FEATURE_MAP.md", "TAXONOMY.md",
  "apps/api/AGENTS.md", "apps/desktop/AGENTS.md", "apps/storybook/AGENTS.md", "apps/storybook/TAXONOMY.md",
  "packages/app/AGENTS.md", "packages/database/AGENTS.md", "packages/design-system/AGENTS.md",
  "docs/runbooks/merge-queue-operations.md", ".github/pr-test-event-tiers.md", ".github/pull_request_template.md",
  ".claude/agents/design-system-steward.md", ".claude/design/discipline-core.md", ".claude/design/soul.md",
  ".claude/skills/control/FEATURE_MAP.md", ".claude/skills/storybook/SKILL.md",
]);

/**
 * `file: reference` pairs that name a plugin file by a name the rule does not resolve, as main's text does, mapped to
 * the file they mean, which must exist. Agents name the vibe skill's references by bare name (claude-worker.mjs resolves
 * a definition's references against agents/, so these rely on the reader knowing the vibe skill).
 */
const ELSEWHERE: Record<string, string> = Object.fromEntries([
  ...Object.entries({
    "vibe-adversarial-reviewer": ["quality-loop"],
    "vibe-backend-worker": ["closedloop-graph", "design-pass", "guardrails", "ticket-template"],
    "vibe-change-worker": ["annotations", "closedloop-graph", "design-pass", "environment", "guardrails-ui", "guardrails", "quality-loop", "ticket-template"],
    "vibe-environment-worker": ["environment", "guardrails", "ticket-template"],
    "vibe-guardrails-reviewer": ["closedloop-graph", "design-pass", "guardrails-ui", "guardrails", "quality-loop"],
    "vibe-handoff-summarizer": ["closedloop-graph"],
    "vibe-primitive-worker": ["closedloop-graph", "guardrails-ui", "guardrails", "ticket-template"],
    "vibe-prototype-worker": ["closedloop-graph", "environment", "guardrails", "quality-loop", "ticket-template"],
    "vibe-requirements-worker": ["quality-loop", "spec-card"],
    "vibe-setup-worker": ["environment", "preflight"],
    "vibe-ticket-worker": ["quality-loop", "ticket-template"],
    "vibe-verify-worker": ["environment", "guardrails", "quality-loop"],
  }).flatMap(([agent, names]) => names.map((name) => [`agents/${agent}.md: ${name}.md`, `skills/vibe/references/${name}.md`])),
  // "in this plugin's skills folder"
  ["agents/vibe-guardrails-reviewer.md: vibe/references/design-pass.md", "skills/vibe/references/design-pass.md"],
  ["agents/vibe-guardrails-reviewer.md: vibe/references/guardrails.md", "skills/vibe/references/guardrails.md"],
  ["skills/vibe/references/guardrails-ui.md: vibe-storybook-decomposer.md", "agents/vibe-storybook-decomposer.md"],
  ["skills/vibe/SKILL.md: vibe-ticket-worker.md", "agents/vibe-ticket-worker.md"],
  // cl-execute reads cl-policy's local policy files.
  ["skills/cl-execute/SKILL.md: references/local-policy.md", "skills/cl-policy/references/local-policy.md"],
  ["skills/cl-execute/SKILL.md: references/local-policy.example.md", "skills/cl-policy/references/local-policy.example.md"],
  ["skills/cl-policy/references/local-policy.example.md: cl-policy/references/local-policy.md", "skills/cl-policy/references/local-policy.md"],
]);

/** `file: reference` pairs that name no file of the plugin, by why. */
const OUTSIDE: Record<string, string[]> = {
  "a file of another skill the text names as loaded (the repository's storybook skill, the control skill, the guided QA and plan skills)": [
    "agents/vibe-primitive-worker.md: references/gotchas.md",
    "agents/vibe-primitive-worker.md: workflows/author-stories.md",
    "agents/vibe-primitive-worker.md: workflows/design-controls.md",
    "agents/vibe-storybook-decomposer.md: design-controls.md",
    "agents/vibe-storybook-decomposer.md: references/docs-and-ai-context.md",
    "agents/vibe-storybook-decomposer.md: references/gotchas.md",
    "agents/vibe-storybook-decomposer.md: references/governance.md",
    "agents/vibe-storybook-decomposer.md: workflows/author-stories.md",
    "agents/vibe-storybook-decomposer.md: workflows/curate-sidebar.md",
    "agents/vibe-storybook-decomposer.md: workflows/design-controls.md",
    "agents/vibe-storybook-decomposer.md: workflows/plan-structure.md",
    "agents/vibe-verify-worker.md: references/cli.md",
    "skills/vibe/references/guardrails-ui.md: workflows/author-stories.md",
    "skills/vibe/references/guardrails-ui.md: workflows/design-controls.md",
    "skills/cl-execute/references/feature-manual-qa.md: references/plan-methodology.md",
    "skills/cl-execute/references/feature-manual-qa.md: references/qa-record-template.md",
    "skills/cl-execute/references/feature-manual-qa.md: resources/plan_template.md",
    "skills/cl-execute/references/planning-and-gates.md: resources/plan_template.md",
    "skills/cl-execute/SKILL.md: resources/plan_template.md",
    "skills/vibe/references/quality-loop.md: resources/plan_template.md",
  ],
  "a file a session, sweep or fleet program writes at run time": [
    "agents/vibe-environment-worker.md: pr-body.md",
    "skills/cl-execute/references/implementation-review-pr.md: pr-body.md",
    "skills/cl-sweep/references/durable-ticket-state.md: queue.md",
    "skills/fleet-orchestrator/SKILL.md: rulings.md",
    "skills/fleet-orchestrator/references/state.md: board.md",
    "skills/fleet-orchestrator/references/state.md: lessons.md",
    "skills/fleet-orchestrator/references/state.md: resume-log.md",
    "skills/fleet-orchestrator/references/state.md: rulings.md",
    "skills/fleet-orchestrator/references/state.md: standing-rulings.md",
  ],
  "the eval docs, which stay in the repository's plugins/vibe: the build leaves evals/ out": ["README.md: evals/codex/README.md"],
};

/**
 * Each Markdown file reference of the plugin at `root` that names no file of it, as `file: reference`. A reference
 * resolves from the file's own folder, then from its skill folder (the nearest folder above it holding a SKILL.md):
 * the two conventions main's plugins/vibe uses (none of main's references resolves only from the plugin root).
 */
function unresolved(root: string): string[] {
  const out: string[] = [];
  for (const file of markdownFiles(root)) {
    const bases = [dirname(file), ...skillFolder(root, file)];
    for (const match of readFileSync(file, "utf8").matchAll(REFERENCE)) {
      const reference = (match[1] ?? match[2]) as string;
      const found = bases.some((base) => {
        const target = join(base, reference);
        return target.startsWith(`${root}${sep}`) && existsSync(target) && statSync(target).isFile();
      });
      if (!found) out.push(`${relative(root, file)}: ${reference}`);
    }
  }
  return out;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

function skillFolder(root: string, file: string): string[] {
  for (let dir = dirname(file); dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
    if (existsSync(join(dir, "SKILL.md"))) return dir === dirname(file) ? [] : [dir];
  }
  return [];
}

describe("Markdown file references in the ClosedLoop vibe", () => {
  let scratch = "";
  let root = "";
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "vibe-closedloop-references-"));
    root = join(scratch, "vibe");
    buildClosedLoopVibe({ ...DEFAULT_PATHS, output: root });
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("each name a file of the built plugin, from the file's folder or its skill folder, except the listed ones", () => {
    const outside = new Set(Object.values(OUTSIDE).flat());
    const left = unresolved(root);
    const unexplained = left.filter((entry) => {
      const reference = entry.slice(entry.indexOf(": ") + 2);
      return !TARGET_REPOSITORY.has(reference) && !(entry in ELSEWHERE) && !outside.has(entry);
    });
    expect(unexplained).toEqual([]);
    for (const [entry, file] of Object.entries(ELSEWHERE)) expect(existsSync(join(root, file)), `${entry} means ${file}`).toBe(true);

    const seen = new Set(left);
    const references = new Set(left.map((entry) => entry.slice(entry.indexOf(": ") + 2)));
    const stale = [...Object.keys(ELSEWHERE), ...outside].filter((entry) => !seen.has(entry))
      .concat([...TARGET_REPOSITORY].filter((name) => !references.has(name)));
    expect(stale, "listed exceptions the built text no longer needs; remove them").toEqual([]);
  });

  it("place every whole provider reference where main kept it, and leave provider/ only the contract", () => {
    for (const file of ["skills/vibe/references/ticket-template.md", "skills/vibe/references/closedloop-graph.md",
      "skills/fleet-orchestrator/references/ticket-units.md"]) expect(existsSync(join(root, file)), file).toBe(true);
    expect(readdirSync(join(root, "provider"))).toEqual(["provider.json"]);
  });
});
