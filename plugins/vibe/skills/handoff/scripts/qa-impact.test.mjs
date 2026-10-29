import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QaImpact, lockfileUiPackage, qaImpact } from "./qa-impact.mjs";
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
const SCRIPT = fileURLToPath(new URL("./qa-impact.mjs", import.meta.url));

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
  write("public/logo.svg", "<svg><path d='old'/></svg>\n");
  write("packages/app/documents/en.json", '{"title":"Old"}\n');
  write(".github/workflows/ci.yml", "name: CI\n");
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
  f.write("packages/design-system/button.tsx", "// Why this stays shared.\nexport const Button = () => null;\n");
  f.commit("comment");
  assert.deepEqual(classify(f, f.base, { "packages/design-system/button.tsx": ["apps/app/documents/page.tsx"] }), {
    outcome: QaImpact.None,
    lanes: [],
    screens: [],
    changedFiles: ["packages/design-system/button.tsx"],
    reason: "the changes cannot affect automated QA",
  });
});

test("a URL change in JSX is never mistaken for a comment", (t) => {
  const f = fixture(t);
  f.write("packages/app/documents/link.tsx", "export const Link = () => <span>https://new.example</span>;\n");
  f.commit("url");
  const result = classify(f, f.base, { "packages/app/documents/link.tsx": ["apps/app/documents/page.tsx"] });
  assert.equal(result.outcome, QaImpact.Visual);
  assert.deepEqual(result.screens.map((screen) => screen.id), ["shell-route:documents"]);
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
  f.write("README.md", "later docs\n");
  f.commit("docs");
  assert.equal(classify(f, f.base, {}, LANE_REPORT).laneKey, result.laneKey, "lane scope ignores a later docs-only commit");
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

test("lockfile UI packages match exact names, including the repo's UI libraries", () => {
  for (const [line, expected] of [
    ["next@15.0.0:", "next"], ["recharts: 2.15.0", "recharts"], ["sonner@2.0.0:", "sonner"], ["vaul: 1.1.0", "vaul"],
    ["@radix-ui/react-dialog@1.1.0:", "@radix-ui/react-dialog"], ["@types/react: 19.0.0", null], ["eslint-plugin-react: 7.0.0", null],
  ]) assert.equal(lockfileUiPackage(line), expected, line);
});

test("root CI files are None but product workflow source is Visual QA", (t) => {
  const f = fixture(t);
  f.write(".github/workflows/ci.yml", "name: Changed CI\n");
  f.commit("ci");
  assert.equal(classify(f, f.base).outcome, QaImpact.None);

  f.write("packages/app/workflows/card.tsx", "export const Card = () => <div>Changed</div>;\n");
  f.commit("product workflow");
  const result = classify(f, f.base, { "packages/app/workflows/card.tsx": ["apps/app/documents/page.tsx"] });
  assert.equal(result.outcome, QaImpact.Visual);
});

test("UI assets, imported locale JSON, and HTML classify as visual", (t) => {
  const f = fixture(t);
  f.write("public/logo.svg", "<svg><path d='new'/></svg>\n");
  f.write("packages/app/documents/en.json", '{"title":"New"}\n');
  f.write("packages/app/documents/template.html", "<strong>New</strong>\n");
  f.commit("assets");
  const result = classify(f, f.base, {
    "public/logo.svg": ["apps/app/documents/page.tsx"],
    "packages/app/documents/en.json": ["apps/app/documents/page.tsx"],
    "packages/app/documents/template.html": ["apps/app/documents/page.tsx"],
  });
  assert.equal(result.outcome, QaImpact.Visual);
  assert.ok(result.screens.some((screen) => screen.id === "shell-route:documents"));
});

test("backend wording does not make every screen global, but rendered data shaping is visual", (t) => {
  const f = fixture(t);
  f.write("packages/api/service.ts", "export const value = 'copy label title route flag';\n");
  f.commit("backend wording");
  assert.equal(classify(f, f.base, { "packages/api/service.ts": [] }).outcome, QaImpact.None);
  const rendered = classify(f, f.base, { "packages/api/service.ts": ["packages/app/documents/data.ts"] });
  assert.equal(rendered.outcome, QaImpact.Visual);
  assert.deepEqual(rendered.screens.map((screen) => screen.id), ["shell-route:documents"]);
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
  unrelated.write("notes.md", "ordinary branch docs\n");
  unrelated.commit("docs after merge");
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

test("a hand-resolved UI conflict is branch-owned and names its screen", (t) => {
  const f = fixture(t);
  git(f.worktree, ["checkout", "--quiet", "-b", "feature"], f.home);
  f.write("feature.txt", "feature\n");
  const boundary = f.commit("feature boundary");
  f.write("apps/app/settings/page.tsx", "export default function Settings() { return 'branch'; }\n");
  f.commit("branch settings");
  git(f.worktree, ["checkout", "--quiet", "main"], f.home);
  f.write("apps/app/settings/page.tsx", "export default function Settings() { return 'main'; }\n");
  f.commit("main settings");
  git(f.worktree, ["checkout", "--quiet", "feature"], f.home);
  assert.throws(() => git(f.worktree, ["merge", "--quiet", "--no-edit", "main"], f.home));
  f.write("apps/app/settings/page.tsx", "export default function Settings() { return 'resolved'; }\n");
  f.commit("resolve settings");
  const result = classify(f, boundary, { "apps/app/settings/page.tsx": ["apps/app/settings/page.tsx"] });
  assert.equal(result.outcome, QaImpact.Visual);
  assert.deepEqual(result.screens.map((screen) => screen.id), ["shell-route:settings"]);
});

test("missing graph or FEATURE_MAP classifies UI upward but leaves docs and tests mechanical", (t) => {
  const docs = fixture(t);
  docs.write("README.md", "docs\n");
  docs.commit("docs");
  assert.equal(qaImpact({ worktree: docs.worktree, since: docs.base, evidence: EVIDENCE, graphImporters: null, featureMap: null }).outcome, QaImpact.None);

  const tests = fixture(t);
  tests.write("packages/app/documents/button.test.ts", "export const covered = true;\n");
  tests.commit("test");
  assert.equal(qaImpact({ worktree: tests.worktree, since: tests.base, evidence: EVIDENCE,
    graphImporters: null, featureMap: null, laneReport: LANE_REPORT }).outcome, QaImpact.LanesOnly);

  const ui = fixture(t);
  ui.write("packages/design-system/button.tsx", "export const Button = () => 'changed';\n");
  ui.commit("ui");
  const result = qaImpact({ worktree: ui.worktree, since: ui.base, evidence: EVIDENCE, graphImporters: null, featureMap: null });
  assert.equal(result.outcome, QaImpact.Visual);
  assert.deepEqual(result.screens.map((screen) => screen.id), ["shell-route:documents", "shell-route:tasks"]);
  assert.match(result.warnings.join(" "), /code importers missing/);
  assert.match(result.warnings.join(" "), /FEATURE_MAP is unavailable/);
});

test("the CLI degrades without graph and FEATURE_MAP instead of exiting 2", (t) => {
  const run = (f) => {
    const evidence = path.join(f.worktree, "evidence.json");
    writeFileSync(evidence, JSON.stringify(EVIDENCE));
    return spawnSync(process.execPath, [SCRIPT, "--worktree", f.worktree, "--since", f.base, "--evidence", evidence], { encoding: "utf8" });
  };
  const docs = fixture(t);
  docs.write("README.md", "docs\n");
  docs.commit("docs");
  const none = run(docs);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).outcome, QaImpact.None);

  const ui = fixture(t);
  ui.write("packages/design-system/button.tsx", "export const Button = () => 'changed';\n");
  ui.commit("ui");
  const visual = run(ui);
  assert.equal(visual.status, 0, visual.stderr);
  assert.equal(JSON.parse(visual.stdout).outcome, QaImpact.Visual);
});

test("feature path matching respects sibling boundaries", (t) => {
  const f = fixture(t);
  f.write("packages/app/tasks-extra/card.tsx", "export const Card = () => null;\n");
  f.commit("sibling");
  const map = { entries: [{ id: "wrong", title: "Wrong", code: ["shared-ui: packages/app/tasks/"] }] };
  const result = qaImpact({ worktree: f.worktree, since: f.base, evidence: EVIDENCE,
    graphImporters: { importers: { "packages/app/tasks-extra/card.tsx": [] } }, featureMap: map });
  assert.equal(result.outcome, QaImpact.Visual, "an unmatched UI file classifies upward");
  assert.ok(!result.screens.some((screen) => screen.id === "wrong"), "a sibling prefix is not a matched screen");
});

test("classification reads the committed head, not later working-tree bytes", (t) => {
  const f = fixture(t);
  f.write("packages/design-system/button.tsx", "export const Button = () => 'committed UI change';\n");
  f.commit("ui");
  f.write("packages/design-system/button.tsx", "// uncommitted comment only\nexport const Button = () => null;\n");
  const result = classify(f, f.base, { "packages/design-system/button.tsx": ["apps/app/documents/page.tsx"] });
  assert.equal(result.outcome, QaImpact.Visual);
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
