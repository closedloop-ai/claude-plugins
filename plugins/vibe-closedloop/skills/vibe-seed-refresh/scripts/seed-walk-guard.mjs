#!/usr/bin/env node
import { capturedJson } from "../../../lib/vibe/scripts/captured-json.mjs";
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { githubRepository } from "../../../lib/vibe/scripts/github-remote.mjs";
import { regularJson } from "../../../lib/vibe/scripts/owned-state.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const MAIN_REF = "refs/heads/main";
const CAPTURED = "refs/remotes/origin/main";
const SHA = /^[a-f0-9]{40}$/;
const WALK = /^packages\/control\/src\/vibe-walk\/(?:route-exceptions|plan|[\w-]+\.test)\.ts$/;
const SEED = /^(?:apps\/api\/scripts\/(?:vibe-seed\/|__tests__\/[\w.-]*vibe-seed[\w.-]*\.test\.ts$)|packages\/database\/prisma\/seeds\/|apps\/desktop\/prisma\/(?:seeds?|seed-coverage)\/)/;
const MAP = ".claude/skills/control/FEATURE_MAP.md";
const APP = "apps/app/app/(authenticated)";
const ROUTE = /^\/\[orgSlug\](?:\/[A-Za-z0-9_-]+)+$/;
const NOT_FOUND = /^\s*import\s*\{\s*notFound\s*\}\s*from\s*["']next\/navigation["'];\s*(?:\/\*[\s\S]*?\*\/\s*)?export default function \w+\(\)(?::\s*never)?\s*\{\s*(?:return\s+)?notFound\(\);\s*\}\s*$/;

const block = (reason) => ({ status: "BLOCKED", reason });
const person = (reason) => ({ status: "NEEDS_PERSON", reason });

function gitText(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
}

function githubPull(worktree, repository, number) {
  return capturedJson(execFileSync("gh", ["api", "--method", "GET", `repos/${repository}/pulls/${number}`], {
    cwd: worktree, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
  }));
}

function optional(read, ...args) {
  try { return read(...args); } catch { return null; }
}

function retiredMapRoute(map, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (map ?? "").startsWith("#") && (map ?? "").includes("<!-- control:generated id=")
    && new RegExp("retired (?:web )?URL[^\\n]{0,120}`web-page:" + escaped + "`", "i").test(map);
}

function reviewedRoute(body, route) {
  return (body ?? "").includes("`" + route + "`");
}

function humanPull(pr, repo) {
  return pr?.merged === true && typeof pr.merged_at === "string" && pr.user?.type === "User" &&
    typeof pr.user.login === "string" && !/\b(?:bot|agent|orchestrator|claude|codex)\b/i.test(pr.user.login) &&
    pr.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && pr.base.ref === "main" && SHA.test(pr.merge_commit_sha ?? "");
}

function approvedSource(evidence, repo, main, page, read, pull, ancestor) {
  if (evidence.source?.kind === "feature-map") {
    return retiredMapRoute(read(main, MAP), evidence.route) ? { url: `https://github.com/${repo}/blob/${main}/${MAP}`, main } : null;
  }
  const number = evidence.source?.number;
  if (evidence.source?.kind !== "merged-pr" || !Number.isSafeInteger(number) || number <= 0) return null;
  const pr = pull(repo, number);
  if (!humanPull(pr, repo) || !ancestor(pr.merge_commit_sha, main)) return null;
  const atMerge = read(pr.merge_commit_sha, page);
  const parent = read(`${pr.merge_commit_sha}^`, page);
  // A matching merge actually retired the route. For a deleted page require a
  // route-specific citation as well as the exact former page and current 404.
  if (!(parent && !NOT_FOUND.test(parent) && (atMerge ? NOT_FOUND.test(atMerge) : reviewedRoute(pr.body, evidence.route)))) return null;
  return { url: `https://github.com/${repo}/pull/${number}`, author: pr.user.login, mergedAt: pr.merged_at, main };
}

function routeRepairOnly(file, before, after, route) {
  if (typeof before !== "string" || typeof after !== "string" || !after.trim()) return false;
  const lines = before.split("\n");
  const exact = JSON.stringify(route);
  const hits = lines.flatMap((line, index) => line.includes(exact) ? [index] : []);
  return hits.some((index) => {
    const line = lines[index];
    const replace = (from, end) => [...lines.slice(0, from), ...lines.slice(end)].join("\n") === after;
    if (/^\s*(?:\{[^\n]*[=:][^\n]*\}|expect\([^\n]+\)\.[\w]+\([^\n]*\)|["'][^\n]+["'])[,;]?$/.test(line) && replace(index, index + 1)) return true;
    if (file.endsWith("route-exceptions.ts") && line.trim() === exact + ": {") {
      const indent = /^\s*/.exec(line)[0];
      const end = lines.findIndex((candidate, i) => i > index && candidate === indent + "},");
      return end > index && end - index <= 12 && lines.slice(index + 1, end).every((candidate) => !candidate.trim() || candidate.startsWith(indent + " "))
        && replace(index, end + 1);
    }
    if (file.endsWith(".test.ts") && /^\s*(?:test|it)\(["']/.test(line)) {
      const indent = /^\s*/.exec(line)[0];
      const end = lines.findIndex((candidate, i) => i > index && candidate === indent + "});");
      return end > index && end - index <= 20 && lines.slice(index + 1, end).every((candidate) => !candidate.trim() || candidate.startsWith(indent + " "))
        && replace(index, end + 1);
    }
    return false;
  });
}

/** Check the proposed seed transaction against current main and bind any route-only contract retirement to verified authority. */
export function checkSeedWalkScope({ files, captured, advertised, repo, evidence, read, candidate, pull, ancestor }) {
  const outside = files.filter((file) => !SEED.test(file) && !WALK.test(file));
  if (outside.length) return block(`seed refresh cannot edit product, FEATURE_MAP or unrelated paths: ${outside.join(", ")}`);
  const contract = files.filter((file) => WALK.test(file));
  if (!contract.length) return { status: "CONTINUE" };
  if (!SHA.test(captured ?? "") || captured !== advertised || evidence && evidence.main !== captured) return block("refresh exact current origin/main and the walk proof before changing the contract");
  if (!evidence?.source || !repo) return person("no verified human product source for this walk contract change");
  if (typeof evidence?.route !== "string" || !ROUTE.test(evidence.route)) return block("name the exact stale web route in the walk proof");
  const route = evidence.route;
  const page = APP + route + "/page.tsx";
  const exact = read(captured, page);
  const legacy = [".ts", ".js", ".jsx"].some((suffix) => read(captured, APP + route + "/page" + suffix));
  const catchAll = read(captured, APP + "/[orgSlug]/[...unmatched]/page.tsx");
  if (!(exact ? NOT_FOUND.test(exact) : !legacy && NOT_FOUND.test(catchAll))) return block(`current main does not prove a 404 for ${route}`);
  let source;
  try { source = approvedSource(evidence, repo, captured, page, read, pull, ancestor); }
  catch { return person("the GitHub product source could not be verified"); }
  if (!source) return person(`no verified human product source retires ${route}`);
  const unrelated = contract.filter((file) => !routeRepairOnly(file, read(captured, file), candidate(file), route));
  if (unrelated.length) return block(`walk contract edits exceed the verified ${route} correction: ${unrelated.join(", ")}`);
  return { status: "CONTINUE", route, source };
}

/** Validate the working tree before the walk or the effective index before the seed orchestrator commits. */
export function verifySeedWalkWorktree(worktree, { staged = false, git = gitText, pull = githubPull } = {}) {
  const g = (args) => git(worktree, args);
  const captured = g(["rev-parse", "--verify", CAPTURED]).trim();
  const files = [...new Set([
    ...g(["diff", ...(staged ? ["--cached"] : []), "--name-only", "-z", captured, "--"]).split("\0"),
    ...(staged ? [] : readGitInventory(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")),
  ].filter(Boolean))];
  if (!files.some((file) => WALK.test(file))) return checkSeedWalkScope({ files });
  const gitDir = g(["rev-parse", "--absolute-git-dir"]).trim();
  const evidence = optional(regularJson, path.join(gitDir, "vibe-seed-walk-proof.json"));
  const remote = g(["remote", "get-url", "origin"]).trim();
  const repo = githubRepository(remote);
  const advertised = g(["ls-remote", "--exit-code", "origin", MAIN_REF]).trim().split("\t")[0];
  return checkSeedWalkScope({ files, captured, advertised, repo, evidence,
    read: (ref, file) => optional(g, ["show", `${ref}:${file}`]),
    candidate: (file) => staged ? optional(g, ["show", `:${file}`]) : optional(readFileSync, path.join(worktree, file), "utf8"),
    pull: (repository, number) => pull(worktree, repository, number),
    ancestor: (older, newer) => optional(g, ["merge-base", "--is-ancestor", older, newer]) !== null,
  });
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { worktree: { type: "string" }, staged: { type: "boolean" } } });
    if (!values.worktree) throw new Error("--worktree is required");
    const result = verifySeedWalkWorktree(values.worktree, { staged: values.staged });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status === "CONTINUE" ? 0 : result.status === "NEEDS_PERSON" ? 3 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify(block(error.message)) + "\n");
    process.exitCode = 1;
  }
}
