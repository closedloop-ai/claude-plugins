#!/usr/bin/env node
// Renders a vibe session's local plans as the body of the session's
// implementation plan document (PLN) on ClosedLoop (operator ruling,
// 2026-10-19). The plans are the top-level `.md` files in the worktree's
// `.closedloop-ai/vibe-plans/` folder, one per request, joined in request ID
// order; revisions and review evidence in its subfolders stay local. Each plan
// passes publishable-text.mjs, the live ticket's safety rules: a refused line
// writes nothing and exits 1 with every problem, so the same writer fixes its
// local plan before anything is published.
//
// Usage: session-plan.mjs --worktree <path> --out <file> [--published <file>]
//
// Prints one JSON object: `{ ok, empty, plans, out, digest }`, plus `current`
// with `--published` (the latest PLN version's text saved by the ticket
// worker): true when it matches the rendered body apart from whitespace, so a
// whitespace-only edit is not a material change. `empty: true` means the
// session has no plan yet and nothing is written.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LOCAL_PLAN_PREFIX } from "./local-plans.mjs";
import { checkPublishableText } from "./publishable-text.mjs";
import { git } from "./session-record.mjs";

const PLAN_SEPARATOR = "\n\n---\n\n";

/** The session's plans: top-level regular `.md` files of the local plan folder, in request ID order. */
export function localPlanFiles(worktree) {
  const folder = path.join(worktree, LOCAL_PLAN_PREFIX);
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => `${LOCAL_PLAN_PREFIX}${entry.name}`)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Whitespace-insensitive identity of a plan body; equal digests mean no material change. */
export function planDigest(body) {
  const normalized = body.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Builds the PLN body from the session's plans. `roots` and `privateWords`
 * are the publishable-text context. Returns `{ plans, body, problems }`; each
 * problem names the plan file and its line.
 */
export function renderSessionPlan(worktree, { roots, privateWords }) {
  const plans = localPlanFiles(worktree);
  const problems = [];
  const bodies = plans.map((file) => {
    const absolute = path.join(worktree, file);
    if (lstatSync(absolute).isSymbolicLink()) {
      problems.push({ file, line: 0, kind: "plan is a symlink" });
      return "";
    }
    const checked = checkPublishableText(readFileSync(absolute, "utf8"), { roots, privateWords });
    problems.push(...checked.problems.map((problem) => ({ file, ...problem })));
    return checked.text.trim();
  });
  return { plans, body: plans.length ? `${bodies.join(PLAN_SEPARATOR)}\n` : "", problems };
}

/** The checkout paths that become repo-relative: the session worktree, then the main checkout. */
function checkoutRoots(worktree) {
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = path.dirname(common);
  return [worktree, top, realpathSync(top), main, realpathSync(main)];
}

function main() {
  const { values } = parseArgs({
    options: { worktree: { type: "string" }, out: { type: "string" }, published: { type: "string" } },
  });
  if (!values.worktree || !values.out) throw new Error("--worktree and --out are required.");
  const worktree = path.resolve(values.worktree);
  const { plans, body, problems } = renderSessionPlan(worktree, {
    roots: checkoutRoots(worktree),
    privateWords: [os.userInfo().username],
  });
  if (problems.length) {
    return { ok: false, empty: false, plans, problems };
  }
  if (!plans.length) {
    return { ok: true, empty: true, plans };
  }
  const out = path.resolve(values.out);
  writeFileSync(out, body, { mode: 0o600 });
  chmodSync(out, 0o600);
  const digest = planDigest(body);
  const result = { ok: true, empty: false, plans, out, digest };
  if (values.published) {
    result.current = planDigest(readFileSync(path.resolve(values.published), "utf8")) === digest;
  }
  return result;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
