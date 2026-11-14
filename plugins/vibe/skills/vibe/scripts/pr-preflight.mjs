#!/usr/bin/env node
// The pull request title and body checks a code host gate would run, before
// the pull request opens or its title or body changes. A fix pull request once
// failed the metadata gate on a 73-character title: the squash subject is the
// title plus the ` (#<n>)` the host appends, and the limit counts both. Another
// merged on a regenerated baseline called "pixel-identical" to CI from a broken
// compare; it differed by about 3,900 pixels. So a line claiming a result is
// identical, matches or shows no difference carries the measured count.
//
// Usage: pr-preflight.mjs --title "<title>" [--body-file <file>] [--worktree <dir> --base <sha>] [--pr <number>] [--max <72>]
//
// Without --pr the suffix is counted at five digits. Prints {"ok","problems"}
// and exits 1 on any problem.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isVisualBaseline, visualBaselineLedgerProblems } from "../../handoff/scripts/visual-baseline-ledger.mjs";
import { isDesktopE2eLane, isWebE2eLane, readRecords } from "./pre-pr-lanes.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { sessionBinding, ticketReference } = await vibeCore("lib/vibe/scripts/provider.mjs");

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

const CLAIM = /\b(?:(?:pixel|byte)[- ]identical|identical to|no (?:visual |pixel )?(?:diffs?|differences?)\b|match(?:es|ing)? (?:the )?(?:CI|baseline|snapshot|reference|golden|Linux|main)\b)/i;
const MEASURED = /\b\d[\d,.]*\s*(?:%|px\b|pixels?\b|bytes?\b|lines?\b|differ\w*|diffs?\b|of\s+\d)/i;
// A hex token of 7 to 40 characters with at least one digit and one letter, not part of a path, URL or ref name.
const COMMIT_TOKEN = /(?<![\w/#.:-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/:-])/g;
const CHECK_WORD = /\b(typecheck|type-check|lint|test|build)\b/gi;
const PASS_WORD = /\b(?:pass(?:es|ed)?|ran|green|clean|succeed(?:s|ed)?)\b/i;
const BACKTICKED = /`([^`\n]+)`/g;
const FOLLOW_UP_PROMISE = /\b(?:(?:follow[- ]up|separate|new)\s+(?:ticket|issue)\b|(?:ticket|issue)\b[^.!?\n]*?\bfollows\b|(?:ticket|issue)\s+(?:will|is\s+to)\s+be\s+(?:filed|opened|created)\b|will\s+(?:file|open|create)\s+(?:a|an|the)\s+(?:\w+\s+){0,3}(?:ticket|issue)\b)/i;
const E2E_TERM = /\be2e\b|\be-2-e\b|end[- ]to[- ]end/i;
const NEGATED = /\b(?:not|never|no|without|skipp(?:ed|ing)|unrun)\b|n't\b|not[- ]run/i;
const NOT_RUN_STATEMENT = /\bnot[- ]run\b|\b(?:has|have|was|were|did)\s+not\s+(?:been\s+)?run\b|\b(?:hasn't|haven't|wasn't|weren't|didn't)\s+(?:been\s+)?run\b/i;
const DESKTOP_WORD = /\b(?:desktop|electron)\b/i;
const WEB_WORD = /\b(?:web|browser|playwright)\b/i;
export const E2eKind = Object.freeze({ Web: "web", Desktop: "Desktop" });

/** Problems with a pull request title: its length with the ` (#<n>)` suffix the host appends. */
export function titleProblems(title, { pr = null, max = 72 } = {}) {
  const suffix = ` (#${pr ?? "99999"})`.length;
  const total = title.trim().length + suffix;
  return total > max ? [`title is ${total} characters with the ${suffix}-character " (#n)" suffix; the limit is ${max}`] : [];
}

/** Body lines that claim an identical or matching result without the measured count. */
export function claimProblems(body) {
  return body.split("\n").filter((line) => CLAIM.test(line) && !MEASURED.test(line))
    .map((line) => `an "identical/matches" claim names no measured count (for example "0 of 1,048,576 pixels differ"): ${line.trim().slice(0, 160)}`);
}

/** Changed visual baselines between the session base and its committed head. */
export function changedVisualBaselines(worktree, base) {
  return execFileSync("git", ["-C", worktree, "diff", "--name-only", "--diff-filter=ACMRT", base, "HEAD", "--"], { encoding: "utf8" })
    .split("\n").filter(isVisualBaseline);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { title: { type: "string" }, "body-file": { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, pr: { type: "string" }, max: { type: "string" } } });
  if (!values.title?.trim() || (values.base && !values.worktree)) throw new Error("Usage: pr-preflight.mjs --title <title> [--body-file <file>] [--worktree <dir> [--base <sha>]] [--pr <number>] [--max <72>]");
  const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : "";
  const problems = [
    ...titleProblems(values.title, { pr: values.pr ?? null, max: Number(values.max ?? 72) }),
    ...claimProblems(body),
    ...followUpTicketProblems(body),
    ...(values.base ? visualBaselineLedgerProblems(body, changedVisualBaselines(values.worktree, values.base)) : []),
    ...(values.worktree ? [...testedCommitProblems(body, values.worktree, values.base), ...claimedCheckProblems(body, values.worktree),
      ...e2eClaimProblems(body, laneReceipts(values.worktree))] : []),
  ];
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}

/**
 * Commits the body names that the pushed source does not prove: one that does
 * not resolve, one off HEAD's history, or an ancestor whose content differs
 * from HEAD on a path the pull request changes. Commits on the base or on
 * origin/main are citations of main and are not checked.
 */
export function testedCommitProblems(body, worktree, base) {
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const main = tryGit(worktree, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
  // The pull request's own diff is measured from its current merge base, so files a main merge brought in are not its paths.
  const from = (main ? tryGit(worktree, ["merge-base", head, main]) : null) ?? base ?? null;
  const changed = from ? git(worktree, ["diff", "--name-only", "--no-renames", from, head, "--"]).split("\n").filter(Boolean) : null;
  const problems = [];
  for (const token of new Set(body.match(COMMIT_TOKEN) ?? [])) {
    const commit = tryGit(worktree, ["rev-parse", "--verify", "--quiet", `${token}^{commit}`]);
    if (!commit) {
      problems.push(`the body names commit ${token}, which this checkout cannot resolve; cite the pushed head ${head.slice(0, 10)} and rerun what was claimed there`);
      continue;
    }
    if (commit === head || [from, base, main].some((ref) => ref && isAncestor(worktree, commit, ref))) continue;
    if (!isAncestor(worktree, commit, head)) {
      problems.push(`the body names commit ${token}, which is not the pushed head ${head.slice(0, 10)} or one of its ancestors; cite the head and rerun what was claimed there`);
      continue;
    }
    if (changed?.length === 0) continue;
    const moved = git(worktree, ["diff", "--name-only", "--no-renames", commit, head, "--", ...(changed ?? [])]).split("\n").filter(Boolean);
    if (moved.length) {
      problems.push(`the body names commit ${token}, but ${moved.length} ${moved.length === 1 ? "changed path differs" : "changed paths differ"} at head ${head.slice(0, 10)} (${moved.slice(0, 3).join(", ")}); rerun the claimed checks at the head and cite it`);
    }
  }
  return problems;
}

/** Checks the body says passed for a workspace package that has no script by that name. */
export function claimedCheckProblems(body, worktree) {
  const packages = workspacePackages(worktree);
  const problems = [];
  let fenced = false;
  for (const [index, line] of body.split("\n").entries()) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || !PASS_WORD.test(line)) continue;
    const quoted = [...line.matchAll(BACKTICKED)];
    const insideQuote = (offset) => quoted.some((match) => offset >= match.index && offset < match.index + match[0].length);
    const checks = [...line.matchAll(CHECK_WORD)].filter((match) => !insideQuote(match.index));
    if (!checks.length) continue;
    for (const match of quoted) {
      const scripts = packages.get(match[1].trim());
      if (!scripts) continue;
      const nearest = checks.reduce((best, check) => (Math.abs(check.index - match.index) < Math.abs(best.index - match.index) ? check : best));
      const script = nearest[1].toLowerCase().replace("type-check", "typecheck");
      if (!Object.hasOwn(scripts, script)) {
        problems.push(`body line ${index + 1}: claims ${script} for \`${match[1].trim()}\`, which has no "${script}" script, so nothing ran; name the command that did run, or run one`);
      }
    }
  }
  return problems;
}

/** A sentence promising a follow-up ticket that names no ticket slug. */
export function followUpTicketProblems(body) {
  return body.split(/(?<=[.!?])\s+|\n/).filter((sentence) => FOLLOW_UP_PROMISE.test(sentence) && !ticketReference(sessionBinding()).test(sentence))
    .map((sentence) => `a promised follow-up ticket names no slug; file it and cite its ISS slug: ${sentence.trim().slice(0, 160)}`);
}

/** The E2E kinds with a passing and with a not-run receipt at the worktree's current source. */
export function laneReceipts(worktree) {
  const source = sourceIdentity(worktree);
  const atSource = readRecords(worktree).filter((record) => record?.source?.treeSha256 === source.treeSha256 && record.source.head === source.head);
  const kinds = (result) => new Set(atSource.filter((record) => record.result === result).map((record) => e2eKind(record.command)).filter(Boolean));
  return { passed: kinds("pass"), notRun: kinds("not-run") };
}

/** Body E2E statements that the lane receipts do not support. */
export function e2eClaimProblems(body, { passed, notRun }) {
  const problems = [];
  const prose = body.split("\n").filter((line, index, all) => all.slice(0, index + 1).filter((item) => /^\s*```/.test(item)).length % 2 === 0 && !/^\s*```/.test(line));
  for (const clause of prose.flatMap((line) => line.split(/[;:.!?]\s+|,\s+(?=(?:and|but|while)\b)/))) {
    if (!E2E_TERM.test(clause) || !PASS_WORD.test(clause) || NEGATED.test(clause)) continue;
    const named = clauseKinds(clause);
    for (const kind of named.length ? named : [E2eKind.Web, E2eKind.Desktop].filter((item) => passed.has(item) || notRun.has(item))) {
      if (notRun.has(kind)) problems.push(`describes ${kind} E2E as passed, but its lane is recorded not run at this source: ${clause.trim().slice(0, 160)}`);
      else if (!passed.has(kind)) problems.push(`describes ${kind} E2E as passed with no passing lane receipt at this source (pre-pr-lanes.mjs run or record): ${clause.trim().slice(0, 160)}`);
    }
    if (!named.length && !passed.size && !notRun.size) problems.push(`describes E2E as passed with no passing lane receipt at this source (pre-pr-lanes.mjs run or record): ${clause.trim().slice(0, 160)}`);
  }
  const sentences = prose.flatMap((line) => line.split(/(?<=[.!?])\s+/));
  for (const kind of notRun) {
    const stated = sentences.some((sentence) => E2E_TERM.test(sentence) && NOT_RUN_STATEMENT.test(sentence)
      && (clauseKinds(sentence).includes(kind) || (notRun.size === 1 && clauseKinds(sentence).length === 0)));
    if (!stated) problems.push(`${kind} E2E is recorded not run at this source; say plainly in the body that it has not run`);
  }
  return problems;
}

function e2eKind(command) {
  if (typeof command !== "string") return null;
  if (isDesktopE2eLane(command)) return E2eKind.Desktop;
  return isWebE2eLane(command) ? E2eKind.Web : null;
}

function clauseKinds(text) {
  return [...(WEB_WORD.test(text) ? [E2eKind.Web] : []), ...(DESKTOP_WORD.test(text) ? [E2eKind.Desktop] : [])];
}

/** Workspace package names mapped to their package.json scripts. */
export function workspacePackages(worktree) {
  const packages = new Map();
  const read = (directory) => {
    const file = path.join(worktree, directory, "package.json");
    if (!existsSync(file)) return;
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (typeof manifest.name === "string") packages.set(manifest.name, manifest.scripts ?? {});
    } catch { /* An unreadable manifest names no package. */ }
  };
  read(".");
  for (const pattern of workspacePatterns(worktree)) {
    if (!pattern.endsWith("/*")) { read(pattern); continue; }
    const parent = pattern.slice(0, -2);
    for (const entry of tryGit(worktree, ["ls-files", "--", `${parent}/*/package.json`])?.split("\n").filter(Boolean) ?? []) {
      if (path.posix.dirname(path.posix.dirname(entry)) === parent) read(path.posix.dirname(entry));
    }
  }
  return packages;
}

function workspacePatterns(worktree) {
  const file = path.join(worktree, "pnpm-workspace.yaml");
  if (existsSync(file)) {
    const patterns = [];
    let inPackages = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) break;
      const entry = /^\s+-\s+["']?([^"'#\s]+)["']?/.exec(line);
      if (inPackages && entry && !entry[1].startsWith("!")) patterns.push(entry[1].replace(/\/$/, ""));
    }
    return patterns;
  }
  try {
    const workspaces = JSON.parse(readFileSync(path.join(worktree, "package.json"), "utf8")).workspaces;
    return Array.isArray(workspaces) ? workspaces : [];
  } catch { return []; }
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(worktree, args) {
  const result = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function isAncestor(worktree, ancestor, descendant) {
  return spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}
