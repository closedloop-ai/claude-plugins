// The repository's pull request template, read from the session base, and the check that a body keeps its headings.
import { execFileSync } from "node:child_process";
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;
const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];
const TEMPLATE_HEADING = /^#{1,6}\s+\S.*$/gm;

/**
 * Every heading of the repo's pull request template is a line of the body.
 * A body edited by hand dropped a required heading twice and failed the
 * repo's required body check.
 */
export function templateHeadingProblems(body, template) {
  const lines = new Set(body.split("\n").map((line) => line.trim()));
  return (template.match(TEMPLATE_HEADING) ?? []).map((heading) => heading.trim())
    .filter((heading) => !lines.has(heading)).map((heading) => `template heading "${heading}" is missing`);
}

/** Read the first existing base template; absence is optional, but Git failures still propagate. */
export function readTemplate(worktree, base) {
  const present = new Set(readGitInventory(worktree, ["ls-tree", "-r", "--name-only", base, "--", ...TEMPLATE_PATHS]).trim().split("\n").filter(Boolean));
  const file = TEMPLATE_PATHS.find((candidate) => present.has(candidate));
  return file ? execFileSync("git", ["-C", worktree, "show", `${base}:${file}`], { encoding: "utf8", maxBuffer: MAX_BUFFER }).trim() : "";
}
