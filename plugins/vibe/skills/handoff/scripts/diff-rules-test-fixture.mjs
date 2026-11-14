import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDiffRules } from "./diff-rules.mjs";
import { git, makeHome, PROVIDER_BINDING } from "../../vibe/scripts/test-fixtures.mjs";

export const isFrozenStory = (text) => / v1\.0\//.test(text);

export function put(root, files) {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(path.join(root, file));
      continue;
    }
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/**
 * Findings as [rule, file] for a base commit of `base` files and an uncommitted (or committed) `head`, with the
 * ClosedLoop provider bound unless `binding` says otherwise (null for a session with none).
 */
export function run(t, { history = [], base = {}, head = {}, changeLog = "", commit = false, binding = PROVIDER_BINDING }) {
  const { root, home, cleanup } = makeHome("vibe-diff-rules-");
  t.after(cleanup);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  for (const step of history) {
    put(checkout, step.files);
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "--allow-empty", "-m", step.message], home);
  }
  put(checkout, { "README.md": "seed\n", ...base });
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const baseSha = git(checkout, ["rev-parse", "HEAD"], home);
  put(checkout, head);
  if (commit) {
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "-m", "session"], home);
  }
  writeFileSync(path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], home), "vibe-changes.md"), typeof changeLog === "function" ? changeLog({ checkout, base: baseSha }) : changeLog);
  const result = runDiffRules({ worktree: checkout, base: baseSha, isFrozenStory, binding });
  return { ...result, checkout, baseSha, found: result.blocking.map((finding) => [finding.rule, finding.file]) };
}
