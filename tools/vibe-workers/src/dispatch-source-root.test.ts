import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "./test-fixtures.js";
import { dispatchFreshnessProblem, reviewsSource } from "./claude-worker.js";

it("Claude dispatch treats the session checkout's own plugin source as a script root, never another checkout's", ({ onTestFinished }) => {
  const value = fixture();
  onTestFinished(value.cleanup);
  const pluginSource = (checkout: string) => {
    const root = join(checkout, "plugins", "vibe");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "0.0.1" }));
    mkdirSync(join(root, "skills", "vibe", "scripts"), { recursive: true });
    return root;
  };
  const own = pluginSource(value.worktree);
  const other = join(value.base, "other-checkout");
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: other });
  const elsewhere = pluginSource(other);
  const check = (text: string) => dispatchFreshnessProblem(value.agentRoot, value.agentRoot, value.worktree, text);
  const future = "plugins/vibe/skills/vibe/scripts/branch-new.mjs";
  expect(check(`Add ${future} and its test.`)).toBeNull();
  expect(dispatchFreshnessProblem(value.agentRoot, value.agentRoot, value.worktree, `Review ${future}`, true))
    .toMatch(/not a contained regular file in the review worktree/);
  expect(check(`Add ${join(own, "skills", "vibe", "scripts", "branch-new.mjs")}.`)).toBeNull();
  expect(check(`Run ${join(elsewhere, "skills", "vibe", "scripts", "branch-new.mjs")}.`))
    .toMatch(/skills\/vibe\/scripts\/branch-new\.mjs: plugin script does not exist in installed vibe/);
});

it("ADV-2 only a reviewer launch requires the scripts its brief names to exist in the review worktree", () => {
  for (const role of ["vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker"]) {
    expect(reviewsSource(role), role).toBe(true);
  }
  for (const role of ["vibe-change-worker", "vibe-ticket-worker", "vibe-setup-worker", "vibe-prototype-worker", "vibe-environment-worker"]) {
    expect(reviewsSource(role), role).toBe(false);
  }
});
