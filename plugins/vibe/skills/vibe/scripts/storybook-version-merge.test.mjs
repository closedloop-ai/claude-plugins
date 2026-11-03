import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bump, mergeHistory } from "./storybook-version-merge.mjs";
import { git, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "storybook-version-merge.mjs");
const VERSION_FILE = "apps/storybook/package.json";
const HISTORY = "apps/storybook/stories/start-here-version-history.stories.tsx";
const RULES = { release: { versionFile: VERSION_FILE, versionField: "version", historyFiles: ["apps/storybook/stories/start-here-version-history*"] } };
const entry = (version, summary) => `  {\n    version: "${version}",\n    summary: "${summary}",\n  },\n`;
const history = (...entries) => `const RELEASES = [\n${entries.join("")}];\n`;
const pkg = (version) => `{\n  "name": "storybook",\n  "version": "${version}",\n  "private": true\n}\n`;

test("bumps main's version by the session's own level", () => {
  assert.equal(bump("21.0.0", "minor"), "21.1.0");
  assert.equal(bump("21.0.0", "major"), "22.0.0");
  assert.equal(bump("21.0.3", "patch"), "21.0.4");
  assert.throws(() => bump("21.0.0", null), /not a bump/);
  const base = history(entry("20.0.0", "base"));
  const merged = mergeHistory(base, history(entry("20.1.0", "session"), entry("20.0.0", "base")), history(entry("21.0.0", "main"), entry("20.0.0", "base")), "20.1.0", "21.1.0");
  assert.equal(merged, history(entry("21.1.0", "session"), entry("21.0.0", "main"), entry("20.0.0", "base")));
  assert.equal(mergeHistory(base, history(entry("20.1.0", "session")), history(entry("21.0.0", "main"), entry("20.0.0", "base")), "20.1.0", "21.1.0"), null,
    "a session that also removed an entry is the writer's to resolve");
});

test("a main sync that conflicts only on the Storybook release files settles itself (ISS-13321)", (t) => {
  const home = makeHome("vibe-storybook-version-merge-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  const run = (args) => git(checkout, args, home.home);
  const put = (file, text) => { mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true }); writeFileSync(path.join(checkout, file), text); };
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  put(".vibe/storybook-rules.json", JSON.stringify(RULES));
  put(VERSION_FILE, pkg("20.0.0"));
  put(HISTORY, history(entry("20.0.0", "base")));
  run(["add", "-A"]); run(["commit", "--quiet", "-m", "base"]);
  run(["checkout", "--quiet", "-b", "vibe/session"]);
  put(VERSION_FILE, pkg("20.1.0"));
  put(HISTORY, history(entry("20.1.0", "session"), entry("20.0.0", "base")));
  run(["commit", "--quiet", "-am", "session release"]);
  run(["checkout", "--quiet", "main"]);
  put(VERSION_FILE, pkg("21.0.0"));
  put(HISTORY, history(entry("21.0.0", "main"), entry("20.0.0", "base")));
  run(["commit", "--quiet", "-am", "main release"]);
  run(["checkout", "--quiet", "vibe/session"]);
  try { run(["merge", "--no-commit", "--no-ff", "main"]); } catch { /* the conflict this resolves */ }
  const result = runNode(SCRIPT, ["--worktree", checkout], home.home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual([result.json.version, result.json.main, result.json.level], ["21.1.0", "21.0.0", "minor"]);
  assert.equal(JSON.parse(readFileSync(path.join(checkout, VERSION_FILE), "utf8")).version, "21.1.0");
  assert.equal(readFileSync(path.join(checkout, HISTORY), "utf8"), history(entry("21.1.0", "session"), entry("21.0.0", "main"), entry("20.0.0", "base")));
  assert.equal(run(["diff", "--name-only", "--diff-filter=U"]), "", "both files are resolved and staged");
});

test("a conflict anywhere else is left to the writer", (t) => {
  const home = makeHome("vibe-storybook-version-merge-other-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  const run = (args) => git(checkout, args, home.home);
  const put = (file, text) => { mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true }); writeFileSync(path.join(checkout, file), text); };
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  put(".vibe/storybook-rules.json", JSON.stringify(RULES));
  put("apps/app/page.tsx", "base\n");
  run(["add", "-A"]); run(["commit", "--quiet", "-m", "base"]);
  run(["checkout", "--quiet", "-b", "vibe/session"]);
  put("apps/app/page.tsx", "session\n"); run(["commit", "--quiet", "-am", "session"]);
  run(["checkout", "--quiet", "main"]);
  put("apps/app/page.tsx", "main\n"); run(["commit", "--quiet", "-am", "main"]);
  run(["checkout", "--quiet", "vibe/session"]);
  try { run(["merge", "--no-commit", "--no-ff", "main"]); } catch { /* the conflict under test */ }
  const result = runNode(SCRIPT, ["--worktree", checkout], home.home);
  assert.equal(result.status, 2);
  assert.match(result.json.reason, /conflicts outside the Storybook release files: apps\/app\/page\.tsx/);
});
