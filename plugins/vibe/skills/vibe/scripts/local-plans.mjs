import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";

/** The exact worktree-local planning folder, never part of a session's deliverable. */
export const LOCAL_PLAN_PREFIX = ".closedloop-ai/vibe-plans/";

/** Matches only the session planning folder, not other ClosedLoop artifacts. */
export function isLocalPlanPath(filePath) {
  return filePath === LOCAL_PLAN_PREFIX.slice(0, -1) || filePath.startsWith(LOCAL_PLAN_PREFIX);
}

/** Finds plans already present in HEAD, which must block any further publication. */
export function committedLocalPlans(runGit) {
  return runGit(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", LOCAL_PLAN_PREFIX.slice(0, -1)])
    .split("\0").filter(file => file && isLocalPlanPath(file));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: { worktree: { type: "string" } } });
    if (!values.worktree) throw new Error("--worktree is required.");
    const plans = committedLocalPlans(args => git(values.worktree, args));
    process.stdout.write(`${JSON.stringify({ ok: plans.length === 0, committedLocalPlans: plans })}\n`);
    process.exitCode = plans.length ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
