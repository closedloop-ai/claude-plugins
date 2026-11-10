import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addedLines, classifyDiagnostics, STORY_TYPECHECK_SCRIPT, storyTypecheckLane, storyTypecheckTargets } from "./story-typecheck.mjs";

const STORY = "apps/storybook/stories/v2-issue-detail.stories.tsx";

function storybookRepo(t, scripts = { test: "vitest run" }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "story-typecheck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "apps/storybook/stories"), { recursive: true });
  mkdirSync(path.join(dir, "packages/ui/src"), { recursive: true });
  writeFileSync(path.join(dir, "apps/storybook/package.json"), JSON.stringify({ name: "storybook", scripts }));
  writeFileSync(path.join(dir, "apps/storybook/tsconfig.json"), "{}\n");
  writeFileSync(path.join(dir, "packages/ui/package.json"), JSON.stringify({ name: "@repo/ui", scripts: { typecheck: "tsc --noEmit" } }));
  writeFileSync(path.join(dir, "packages/ui/tsconfig.json"), "{}\n");
  writeFileSync(path.join(dir, STORY), "import a from '@/app/x';\nexport const A = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return { dir, git, base: git("rev-parse", "HEAD") };
}

test("a changed story in a package with no typecheck script selects the lane; a package with one does not (PR #9732)", (t) => {
  const { dir, base } = storybookRepo(t);
  assert.deepEqual(storyTypecheckTargets(dir, [STORY, "packages/ui/src/button.stories.tsx", "apps/storybook/fixtures/data.ts"]), ["apps/storybook"]);
  assert.deepEqual(storyTypecheckTargets(dir, ["apps/storybook/fixtures/data.ts"]), [], "only a changed story selects it");
  assert.equal(storyTypecheckLane(dir, base), null, "nothing changed yet");
  writeFileSync(path.join(dir, STORY), "import a from '@/app/x';\nexport const A = 1;\nexport const B = olderVersionOf(content);\n");
  assert.equal(storyTypecheckLane(dir, base), `node ${JSON.stringify(STORY_TYPECHECK_SCRIPT)} --worktree . --base ${base}`);
  const withScript = storybookRepo(t, { typecheck: "tsc --noEmit" });
  writeFileSync(path.join(withScript.dir, STORY), "export const B = 2;\n");
  assert.equal(storyTypecheckLane(withScript.dir, withScript.base), null, "the package's own typecheck script is the lane then");
});

test("only errors on lines the diff adds fail; main's existing errors are counted, not failed", (t) => {
  const { dir, base } = storybookRepo(t);
  writeFileSync(path.join(dir, STORY), "import a from '@/app/x';\nexport const A = 1;\nexport const B = olderVersionOf(content);\n");
  writeFileSync(path.join(dir, "apps/storybook/stories/new.stories.tsx"), "export const C: string = null;\n");
  const added = addedLines(dir, base);
  assert.deepEqual([...added.get(STORY)], [3]);
  assert.deepEqual([...added.get("apps/storybook/stories/new.stories.tsx")], [1, 2]);
  const output = [
    "stories/v2-issue-detail.stories.tsx(1,15): error TS2307: Cannot find module '@/app/x'.",
    "stories/v2-issue-detail.stories.tsx(3,33): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.",
    "../../packages/ui/src/old.ts(9,1): error TS2322: Type 'number' is not assignable to type 'string'.",
  ].join("\n");
  const result = classifyDiagnostics(output, "apps/storybook", added);
  assert.deepEqual(result.inChanged, ["apps/storybook/stories/v2-issue-detail.stories.tsx:3:33 TS2345 Argument of type 'string | null' is not assignable to parameter of type 'string'."]);
  assert.equal(result.elsewhere.length, 2);
  assert.equal(classifyDiagnostics("error TS5058: The specified path does not exist", "apps/storybook", added).attributed, false);
});

test("the command runs tsc in the story's package and fails on a new error in a changed story", (t) => {
  const { dir, base } = storybookRepo(t);
  const bin = mkdtempSync(path.join(os.tmpdir(), "story-typecheck-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$*" > "${bin}/called"\ncat "${bin}/output"\nexit "$(cat "${bin}/status")"\n`);
  chmodSync(path.join(bin, "pnpm"), 0o755);
  const run = (output, status) => {
    writeFileSync(path.join(bin, "output"), output);
    writeFileSync(path.join(bin, "status"), String(status));
    return spawnSync(process.execPath, [STORY_TYPECHECK_SCRIPT, "--worktree", dir, "--base", base], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  };
  writeFileSync(path.join(dir, STORY), "import a from '@/app/x';\nexport const A = 1;\nexport const B = olderVersionOf(content);\n");
  const failed = run("stories/v2-issue-detail.stories.tsx(3,33): error TS2345: Argument of type 'string | null' is not assignable.\n", 2);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /STORY-TYPE-ERROR apps\/storybook\/stories\/v2-issue-detail\.stories\.tsx:3:33 TS2345/);
  assert.match(execFileSync("cat", [path.join(bin, "called")], { encoding: "utf8" }), /apps\/storybook\nexec tsc --noEmit --incremental false --pretty false -p tsconfig\.json/);
  const preexisting = run("stories/v2-issue-detail.stories.tsx(1,15): error TS2307: Cannot find module '@/app/x'.\n", 2);
  assert.equal(preexisting.status, 0, preexisting.stdout);
  assert.match(preexisting.stdout, /1 type errors on lines this diff does not add/);
  assert.equal(run("Cannot find tsconfig\n", 1).status, 1, "a tsc failure with no file diagnostic fails closed");
  assert.equal(run("", 0).status, 0);
});
