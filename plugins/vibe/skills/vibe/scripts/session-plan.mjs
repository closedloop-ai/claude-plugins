#!/usr/bin/env node
// Renders a vibe session's local plans as the body of the session's
// implementation plan document on the bound tracker (operator ruling,
// 2026-10-19). The plans are the top-level `.md` files in the session's plan
// folder (`local-plans.mjs paths`), one per request, joined in request ID
// order; revisions and review evidence in its subfolders stay local. Each plan
// passes publishable-text.mjs, the live ticket's safety rules: a refused line
// writes nothing and exits 1 with every problem, so the same writer fixes its
// local plan before anything is published.
//
// Usage: session-plan.mjs --worktree <path> [--out <file>] [--published <file>]
//        session-plan.mjs paths --worktree <path>
//
// Prints one JSON object: `{ ok, empty, plans, out, digest }`, plus `current`
// with `--published` (the latest plan document version's text saved by the ticket
// worker): true when it matches the rendered body apart from whitespace, so a
// whitespace-only edit is not a material change. `empty: true` means the
// session has no plan yet and nothing is written.
//
// The body starts with SELF_APPROVED_MARKER: vibe sets a plan document's status but
// never its approver, so its APPROVED means built and checked, not a human
// approval, and none of its exclusions is a ruling unless it cites a human
// source (handoff's rulings-check.mjs --plan). A writer once skipped two
// tickets on an uncited Out-of-scope line of such a plan.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { localPlanPaths, sessionLocalPlanPrefix } from "./local-plans.mjs";
import { checkPublishableText } from "./publishable-text.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { scriptExitCode } = await vibeCore("lib/vibe/scripts/provider.mjs");

const PLAN_SEPARATOR = "\n\n---\n\n";
export const SELF_APPROVED_MARKER = "> Self-approved: vibe sets this plan's status and no human approved it; an exclusion here counts only where it cites a ticket AC, a PRD or an operator ruling.";

/**
 * Returns the one machine-private directory used by the ticket worker and plan gates.
 * The stable opaque key keeps evidence available across worker turns without exposing
 * a checkout path or placing any worker-authored file in protected Git metadata.
 */
export function sessionPlanEvidencePaths(worktree, home = os.homedir()) {
  const checkoutKey = createHash("sha256").update(realpathSync(path.resolve(worktree))).digest("hex").slice(0, 24);
  const root = path.join(home, ".codex", "vibe", "plan-evidence", checkoutKey);
  return {
    root,
    rendered: path.join(root, "vibe-live-plan.md"),
    published: path.join(root, "vibe-live-plan-published.md"),
    planDocument: path.join(root, "vibe-live-plan-document.json"),
    childEvidence: path.join(root, "vibe-child-evidence.json"),
    liveTicket: path.join(root, "vibe-live-ticket.md"),
    users: path.join(root, "vibe-users"),
    flagSnapshot: path.join(root, "vibe-flag-snapshot.new.json"),
    dispatchInputs: path.join(root, "vibe-dispatch-inputs.json"),
    environmentResult: path.join(root, "vibe-environment-result"),
    environmentResultFile: path.join(root, "vibe-environment-result", "vibe-environment-result.json"),
    prBody: path.join(root, "pr-body.md"),
    prEvidence: path.join(root, "vibe-pr-evidence.json"),
    prEvidenceComment: path.join(root, "pr-evidence-comment.md"),
  };
}

/**
 * The session's plans: top-level regular `.md` files of the local plan folder, in request ID order, each
 * repo-relative when the folder is in the worktree and absolute when it is in the git directory.
 */
export function localPlanFiles(worktree) {
  const prefix = sessionLocalPlanPrefix(worktree);
  const folder = prefix ? path.join(worktree, prefix) : localPlanPaths(worktree).plans;
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => (prefix ? `${prefix}${entry.name}` : path.join(folder, entry.name)))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Whitespace-insensitive identity of a plan body; equal digests mean no material change. */
export function planDigest(body) {
  const normalized = body.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Builds the plan document body from the session's plans. `roots` and `privateWords`
 * are the publishable-text context. Returns `{ plans, body, problems }`; each
 * problem names the plan file and its line.
 */
export function renderSessionPlan(worktree, { roots, privateWords }) {
  const plans = localPlanFiles(worktree);
  const problems = [];
  const bodies = plans.map((file) => {
    const absolute = path.isAbsolute(file) ? file : path.join(worktree, file);
    if (lstatSync(absolute).isSymbolicLink()) {
      problems.push({ file, line: 0, kind: "plan is a symlink" });
      return "";
    }
    const checked = checkPublishableText(readFileSync(absolute, "utf8"), { roots, privateWords });
    problems.push(...checked.problems.map((problem) => ({ file, ...problem })));
    return checked.text.trim();
  });
  return { plans, body: plans.length ? `${SELF_APPROVED_MARKER}\n\n${bodies.join(PLAN_SEPARATOR)}\n` : "", problems };
}

/** The checkout paths that become repo-relative: the session worktree, then the main checkout. */
function checkoutRoots(worktree) {
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = path.dirname(common);
  return [worktree, top, realpathSync(top), main, realpathSync(main)];
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { worktree: { type: "string" }, out: { type: "string" }, published: { type: "string" } },
  });
  if (!values.worktree) throw new Error("--worktree is required.");
  const worktree = path.resolve(values.worktree);
  const evidence = sessionPlanEvidencePaths(worktree);
  if (positionals[0] === "paths") {
    mkdirSync(evidence.root, { recursive: true, mode: 0o700 });
    mkdirSync(evidence.users, { recursive: true, mode: 0o700 });
    chmodSync(evidence.root, 0o700);
    chmodSync(evidence.users, 0o700);
    return { ok: true, ...evidence };
  }
  if (positionals.length) throw new Error(`Unknown command ${positionals[0]}.`);
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
  const out = path.resolve(values.out ?? evidence.rendered);
  mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, body, { mode: 0o600 });
  chmodSync(out, 0o600);
  const digest = planDigest(body);
  const result = { ok: true, empty: false, plans, out, digest };
  if (values.published) {
    result.current = planDigest(readFileSync(path.resolve(values.published), "utf8")) === digest;
  }
  return result;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = scriptExitCode(error, 1);
  }
}
