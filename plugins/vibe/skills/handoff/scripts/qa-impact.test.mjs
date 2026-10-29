import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { QaImpact, qaImpact } from "./qa-impact.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const FEATURE_MAP = {
  version: 1,
  entries: [
    { id: "shell-route:documents", title: "Documents", webPages: ["apps/app/documents/page.tsx"], code: ["shared-ui: packages/app/documents/"], webGates: ["documents:on"] },
    { id: "shell-route:tasks", title: "Tasks", webPages: ["apps/app/tasks/page.tsx"], code: ["shared-ui: packages/app/tasks/"], webGates: ["tasks:on"] },
    { id: "shell-route:settings", title: "Settings", webPages: ["apps/app/settings/page.tsx"], code: ["shared-ui: packages/app/settings/"] },
  ],
};
const EVIDENCE = {
  screens: [
    { id: "shell-route:documents", states: ["loaded", "empty"], flagArms: ["documents:on", "documents:off"], hosts: ["web", "desktop"] },
    { id: "shell-route:tasks", states: ["loaded"], flagArms: ["tasks:on"] },
  ],
};
const LANE_REPORT = "IN THE TURBO GRAPH:\n    pnpm --filter @repo/app test\n";

function fixture(t) {
  const { root, home, cleanup } = makeHome("vibe-qa-impact-");
  t.after(cleanup);
  const worktree = path.join(root, "repo");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), text);
  };
  const commit = (message) => {
    git(worktree, ["add", "-A"], home);
    git(worktree, ["commit", "--quiet", "-m", message], home);
    return git(worktree, ["rev-parse", "HEAD"], home);
  };
  write("packages/design-system/button.tsx", "export const Button = () => null;\n");
  write("packages/api/service.ts", "export const value = 1;\n");
  write("plugins/vibe/.claude-plugin/plugin.json", '{"name":"vibe","version":"1.1.17"}\n');
  write("pnpm-lock.yaml", "react: 18.3.1\n");
  write("apps/app/documents/page.tsx", "import { Button } from '../../../packages/design-system/button';\nexport default Button;\n");
  write("apps/app/tasks/page.tsx", "import { Button } from '../../../packages/design-system/button';\nexport default Button;\n");
  write("apps/app/settings/page.tsx", "export default function Settings() { return null; }\n");
  const base = commit("base");
  return { worktree, home, write, commit, base };
}

function classify(f, since, importers = {}, laneReport = undefined, evidence = EVIDENCE) {
  return qaImpact({ worktree: f.worktree, since, evidence, graphImporters: { importers }, featureMap: FEATURE_MAP, laneReport });
}

test("comment-only work after QA needs no lanes, screenshots, or critic pass", (t) => {
  const f = fixture(t);
  f.write("packages/design-system/button.tsx", "// Why this stays shared.\nexport const Button = () => null; // Kept intentionally.\n");
  f.commit("comment");
  assert.deepEqual(classify(f, f.base, { "packages/design-system/button.tsx": ["apps/app/documents/page.tsx"] }), {
    outcome: QaImpact.None,
    lanes: [],
    screens: [],
    changedFiles: ["packages/design-system/button.tsx"],
    reason: "the changes cannot affect automated QA",
  });
});

test("version and release-history-only work needs no QA", (t) => {
  const f = fixture(t);
  f.write("plugins/vibe/.claude-plugin/plugin.json", '{"name":"vibe","version":"1.1.18"}\n');
  f.write("CHANGELOG.md", "# 1.1.18\n\nRelease history.\n");
  f.commit("release");
  const result = classify(f, f.base);
  assert.equal(result.outcome, QaImpact.None);
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.screens, []);
});

test("test-only work runs only the lanes selected for those files", (t) => {
  const f = fixture(t);
  f.write("packages/app/documents/button.test.ts", "export const covered = true;\n");
  f.commit("test");
  const result = classify(f, f.base, {}, LANE_REPORT);
  assert.equal(result.outcome, QaImpact.LanesOnly);
  assert.deepEqual(result.lanes, ["pnpm --filter @repo/app test"]);
  assert.deepEqual(result.screens, []);
  assert.throws(() => classify(f, f.base), /needs the repository lane report/);
});

test("a shared UI component invalidates only the screens its importers reach", (t) => {
  const f = fixture(t);
  f.write("packages/design-system/button.tsx", "export const Button = () => 'changed';\n");
  f.commit("ui");
  const result = classify(f, f.base, {
    "packages/design-system/button.tsx": ["apps/app/documents/page.tsx", "apps/app/tasks/page.tsx"],
  });
  assert.equal(result.outcome, QaImpact.Visual);
  assert.deepEqual(result.screens.map((screen) => screen.id), ["shell-route:documents", "shell-route:tasks"]);
  assert.deepEqual(result.screens[0].states, ["loaded", "empty"]);
  assert.deepEqual(result.screens[0].flagArms, ["documents:on", "documents:off"]);
  assert.ok(result.screens.every((screen) => !("commit" in screen) && !("sha" in screen)));
});

test("a lockfile change that moves a UI library invalidates the recorded screens", (t) => {
  const f = fixture(t);
  f.write("pnpm-lock.yaml", "react: 19.0.0\n");
  f.commit("ui library");
  const result = classify(f, f.base);
  assert.equal(result.outcome, QaImpact.Visual);
  assert.deepEqual(result.screens.map((screen) => screen.id), ["shell-route:documents", "shell-route:tasks"]);
});

test("a clean main merge ignores unrelated screens and invalidates a rendered dependency", (t) => {
  const unrelated = fixture(t);
  git(unrelated.worktree, ["checkout", "--quiet", "-b", "feature"], unrelated.home);
  unrelated.write("feature.txt", "feature\n");
  const qaBoundary = unrelated.commit("feature boundary");
  git(unrelated.worktree, ["checkout", "--quiet", "main"], unrelated.home);
  unrelated.write("apps/app/settings/page.tsx", "export default function Settings() { return 'main'; }\n");
  unrelated.commit("main settings");
  git(unrelated.worktree, ["checkout", "--quiet", "feature"], unrelated.home);
  git(unrelated.worktree, ["merge", "--quiet", "--no-edit", "main"], unrelated.home);
  const none = classify(unrelated, qaBoundary, { "apps/app/settings/page.tsx": ["apps/app/settings/page.tsx"] });
  assert.equal(none.outcome, QaImpact.None);

  const related = fixture(t);
  git(related.worktree, ["checkout", "--quiet", "-b", "feature"], related.home);
  related.write("feature.txt", "feature\n");
  const relatedBoundary = related.commit("feature boundary");
  git(related.worktree, ["checkout", "--quiet", "main"], related.home);
  related.write("packages/design-system/button.tsx", "export const Button = () => 'main changed';\n");
  related.commit("main button");
  git(related.worktree, ["checkout", "--quiet", "feature"], related.home);
  git(related.worktree, ["merge", "--quiet", "--no-edit", "main"], related.home);
  const visual = classify(related, relatedBoundary, {
    "packages/design-system/button.tsx": ["apps/app/documents/page.tsx", "apps/app/tasks/page.tsx", "apps/app/settings/page.tsx"],
  });
  assert.equal(visual.outcome, QaImpact.Visual);
  assert.deepEqual(visual.screens.map((screen) => screen.id), ["shell-route:documents", "shell-route:tasks"]);
});

test("backend source with no rendered importer needs no local QA", (t) => {
  const f = fixture(t);
  f.write("packages/api/service.ts", "export const value = 2;\n");
  f.commit("backend");
  const result = classify(f, f.base, { "packages/api/service.ts": [] });
  assert.equal(result.outcome, QaImpact.None);
});

test("screen evidence refuses commit identity fields", () => {
  assert.throws(() => qaImpact({ worktree: ".", since: "HEAD", evidence: { screens: [{ id: "screen", states: ["loaded"], flagArms: [], commit: "abc" }] }, graphImporters: {}, featureMap: FEATURE_MAP }), /screen and state based/);
});
