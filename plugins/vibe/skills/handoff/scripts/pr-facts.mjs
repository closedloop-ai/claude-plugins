// What a vibe pull request body must state, computed from the session diff for
// handoff-inventory.mjs: overlap with open pull requests (shared or imported
// files), assertion and export changes, new API refusals, ticket asks and
// the evidence lanes, plus the body and evidence gates. No CLI of its own.
// The repository-specific parts (its E2E CI owners, Desktop spec folder, lane
// report, API folders and workspace import aliases) are the bound provider's
// `data.recipes.prEvidence`; without it a changed E2E spec cannot be left for
// CI and must pass locally.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { repositoryLaneReportProblems, laneReportLabel } from "./ci-job-shape.mjs";
import { isLocalPlanPath, sessionLocalPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { pointerProblems } from "../../vibe/scripts/publishable-text.mjs";
import { playVerdictProblems } from "../../vibe/scripts/story-play-verdict.mjs";
import { GENERIC_AREAS, isUiFile, sessionAreas } from "../../vibe/scripts/area-paths.mjs";
import { isDesktopE2eLane, NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { isE2ePath, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { requiredContainerIdentity, specExecutionLimitation, tierEvidenceProblems } from "./e2e-tier.mjs";
import { probeE2eCapability } from "./e2e-capability-probe.mjs";
import { prBodyClaimProblems } from "./pr-body-claims.mjs";
import { GRAPH_SELECTOR, prEvidenceShapeProblems, readTestSelection, TEST_SELECTORS, treeEquivalentCarryShapeProblems, laneReportShapeProblems } from "./pr-evidence-schema.mjs";
import { qaImpactRequest, qaImpactRequestAtCommit, qaImpactDirectCommitScope } from "./qa-impact.mjs";
import { proofSourceAt, testIntegrityProblems } from "./test-integrity.mjs";
import { readMainSyncProvenance } from "../../vibe/scripts/dist/main-sync.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { withStableSource, validSourceIdentity, sameSource, sourceIdentity, committedSourceIdentity, committedFile } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { githubRepository } = await vibeCore("lib/vibe/scripts/github-remote.mjs");
const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

const MAX_BUFFER = 64 * 1024 * 1024;
const GH_LIST_FILE_CAP = 100;
const SCOPED_CORPUS_AUTHORITY = Symbol("scoped pull-request corpus authenticated by inventory");
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ASSERTION = /\b(?:expect|assert)\s*[.(]|\.(?:toBe|toEqual|toStrictEqual|toMatch|toThrow|toContain|toHave\w*)\b/;
const SKIP = /\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/;
const EXPORT = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([\w$]+)/;
const BODY_EXPORT = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface)\b/;
const REFUSAL = /\bstatus\s*[:=(]\s*(4\d\d)\b/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
const ASK = /[^.!?\n]*\b(?:say|state|explain|decide|justify)\b[^.!?\n]*\bin\s+the\s+(?:PR|pull request)\b[^.!?\n]*[.!?]?/gi;
const CITATION = /(?<![\w/.-])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,5}):(\d+)\b/g;
const PR_NUMBER = /#(\d{3,6})\b/g;
const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];
const TEMPLATE_HEADING = /^#{1,6}\s+\S.*$/gm;
const SHA = /^[a-f0-9]{40}$/;
export const KNOWN_MAIN_FAILURES = "Known main failures";
const CI_CHECK_PATH = /^(?:\.github\/(?:workflows|actions)\/|scripts\/)|(?:^|\/)(?:package\.json|turbo\.json|biome\.jsonc?)$|(?:^|\/)(?:lint|checks?|gates?)\//;
export const GENERIC_PR_RULES = Object.freeze({ e2eOwners: null, desktopSpecs: null, laneReport: null, refusalPaths: [], workspaceAliases: [] });

export const STACKED_BASE_STATEMENT = "Stacked pull request: its base is not main, so no required CI lane runs on it; local evidence is listed below.";

/** `git diff -U0` output as files with their added and removed lines. */
export function parseDiff(text) {
  const files = [];
  let file;
  let hunk;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: line.replace(/^diff --git a\/.+ b\//, ""), status: "M", hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (file && !hunk && line.startsWith("deleted file mode")) {
      file.status = "D";
    } else if (file && HUNK.test(line)) {
      const [, oldStart, , newStart, newCount] = HUNK.exec(line);
      hunk = { newStart: Number(newStart), newCount: newCount === undefined ? 1 : Number(newCount), removed: [], added: [] };
      file.hunks.push(hunk);
      oldLine = Number(oldStart);
      newLine = hunk.newStart;
    } else if (hunk && line.startsWith("-")) {
      hunk.removed.push({ line: oldLine++, text: line.slice(1) });
    } else if (hunk && line.startsWith("+")) {
      hunk.added.push({ line: newLine++, text: line.slice(1) });
    }
  }
  return files;
}

/** The session diff against `base`, untracked files counted as added. */
export function readDiff(worktree, base) {
  const files = parseDiff(git(worktree, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", base]));
  for (const file of git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    const lines = readFileSync(path.join(worktree, file), "utf8").replace(/\n$/, "").split("\n");
    files.push({ path: file, status: "A", hunks: [{ newStart: 1, newCount: lines.length, removed: [], added: lines.map((text, i) => ({ line: i + 1, text })) }] });
  }
  return files;
}

/** Recompute changed proof candidates from the same recorded main-sync base as the inventory. */
function evidenceCandidateFiles(worktree) {
  const record = readSessionRecord(worktree);
  const base = proofCorpusBase(worktree);
  const localFixPaths = new Set((Array.isArray(record?.localFixes) ? record.localFixes : [])
    .flatMap(fix => Array.isArray(fix?.paths) ? fix.paths : []).filter(file => typeof file === "string"));
  const planPrefix = sessionLocalPlanPrefix(worktree);
  return readDiff(worktree, base).filter(file => !localFixPaths.has(file.path) && !isLocalPlanPath(file.path, planPrefix));
}

/** Open pull requests sharing a changed file, or a file a changed file imports. */
export function computeOverlap({ worktree, changed, prs, ownBranch }) {
  const changedSet = new Set(changed);
  const imported = new Set(changed.flatMap((file) => importsOf(worktree, file)).filter((file) => !changedSet.has(file)));
  return prs
    .filter((pr) => pr.headRefName !== ownBranch && !pr.unavailableReason)
    .map((pr) => ({ number: pr.number, title: pr.title,
      sharedFiles: pr.files.filter((file) => changedSet.has(file)), importedFiles: pr.files.filter((file) => imported.has(file)) }))
    .filter((pr) => pr.sharedFiles.length + pr.importedFiles.length > 0)
    .sort((a, b) => a.number - b.number);
}

function importsOf(worktree, file, aliases = prRules(worktree).workspaceAliases) {
  const absolute = path.join(worktree, file);
  if (!SOURCE.test(file) || !existsSync(absolute)) {
    return [];
  }
  return [...readFileSync(absolute, "utf8").matchAll(IMPORT)].flatMap(([, specifier]) => {
    const [, pkg, ...rest] = specifier.split("/");
    const alias = aliases.find((entry) => specifier.startsWith(entry.prefix));
    const bases = specifier.startsWith(".") ? [path.posix.join(path.posix.dirname(file), specifier)]
      : alias ? alias.bases.map((base) => base.replace("{package}", pkg).replace("{rest}", rest.join("/") || "index"))
      : [];
    const found = bases.flatMap((base) => SUFFIXES.map((suffix) => base + suffix))
      .find((candidate) => SOURCE.test(candidate) && existsSync(path.join(worktree, candidate)));
    return found ? [found] : [];
  });
}

/** Flipped and removed assertions, added skips and deleted test files. */
export function assertionChanges(files) {
  return files.filter((file) => isTestFile(file.path)).flatMap((file) => {
    if (file.status === "D") {
      return [{ kind: "deleted-test-file", path: file.path }];
    }
    return file.hunks.flatMap((hunk) => {
      const added = hunk.added.filter((line) => ASSERTION.test(line.text));
      return [
        ...hunk.removed.filter((line) => ASSERTION.test(line.text)).map((line, i) => (added[i]
          ? { kind: "flipped", path: file.path, line: added[i].line, before: line.text.trim(), after: added[i].text.trim() }
          : { kind: "removed", path: file.path, line: hunk.newStart, before: line.text.trim() })),
        ...hunk.added.filter((line) => SKIP.test(line.text)).map((line) => ({ kind: "skip-added", path: file.path, line: line.line })),
      ];
    });
  });
}

/** Changed or removed exports outside tests, and new 4xx refusals under the repository's API folders `refusalPaths`. */
export function contractChanges(files, refusalPaths = []) {
  const contracts = [];
  const refusals = [];
  for (const file of files.filter((entry) => SOURCE.test(entry.path) && !isTestFile(entry.path))) {
    const added = new Map(file.hunks.flatMap((hunk) => hunk.added).map((line) => [EXPORT.exec(line.text)?.[1], line]));
    for (const hunk of file.hunks) {
      for (const line of hunk.removed) {
        const name = EXPORT.exec(line.text)?.[1];
        const replacement = name && added.get(name);
        if (name && !replacement) {
          contracts.push({ kind: "removed", name, path: file.path, line: hunk.newStart });
        } else if (name && signature(replacement.text) !== signature(line.text)) {
          contracts.push({ kind: "changed", name, path: file.path, line: replacement.line });
        }
      }
      for (const line of refusalPaths.some((prefix) => file.path.startsWith(prefix)) ? hunk.added : []) {
        const status = REFUSAL.exec(line.text)?.[1];
        if (status) {
          refusals.push({ path: file.path, line: line.line, status: Number(status) });
        }
      }
    }
  }
  return { contracts, refusals };
}

/** A function, class or interface is compared up to its body, anything else by its whole line. */
function signature(text) {
  const trimmed = text.trim();
  return BODY_EXPORT.test(trimmed) ? trimmed.split("{")[0].trim() : trimmed;
}

/** The evidence lanes a diff needs in the repository's `areas` (area-paths.mjs); none for a server-only diff. */
export function requiredLanes(changed, touchFlows = [], areas = GENERIC_AREAS) {
  const lanes = [];
  if (changed.some((file) => isUiFile(file, areas))) {
    lanes.push("web-host");
    if (changed.some((file) => areas.desktopHost.some((prefix) => file.startsWith(prefix)))) lanes.push("desktop-host");
    if (touchFlows.length > 0) lanes.push("webkit-iphone", "chromium-pixel");
    if (changed.some((file) => /\.stories\.tsx?$/.test(file))) lanes.push("storybook-plays");
  }
  if (changed.some(isE2ePath)) lanes.push("e2e");
  return lanes;
}

/**
 * A run that failed the same way on the main the session captured: the
 * session did not cause it, so it never stops the pull request, and the body
 * lists it under Known main failures. `mainSha` is the captured
 * main the same command also failed on.
 */
export function isMainPreexisting(run) {
  return run?.status === "main-preexisting" && SHA.test(run.mainSha ?? "");
}

function passedOrMainPreexisting(run) {
  return run?.status === "passed" || isMainPreexisting(run);
}

/**
 * The web E2E lane is left for CI only when every changed spec has complete
 * per-spec evidence that its selected runtime tier cannot execute it.
 */
function e2eLeftForCi(runsFile, changed, commit, rules) {
  const specs = changed.filter((file) => isE2ePath(file) && TEST_SPEC_PATTERN.test(file));
  const selection = readTestSelection(runsFile);
  return specs.length > 0 && selection.problems.length === 0
    && specs.every((spec) => e2eCarriedForCi(runsFile, selection.entries, spec, commit, rules));
}

/** Immutable carry is an explicit alternate authority, never a weaker interpretation of a failed ancestry check. */
function verifiedCarryImpact(runsFile, worktree, commit) {
  const carry = runsFile.treeEquivalentCarry;
  const shape = treeEquivalentCarryShapeProblems(carry);
  if (shape.length) throw new Error(shape.join("; "));
  if (!worktree || commit !== carry.published.commit) throw new Error("tree carry needs the verified published commit/worktree");
  return withStableSource(worktree, current => {
    const sourceCache = new Map();
    const fileHashes = new Map();
    const hashAt = (sha, file) => {
      const key = JSON.stringify([sha, file]);
      if (!fileHashes.has(key)) fileHashes.set(key, createHash("sha256").update(committedFile(worktree, sha, file)).digest("hex"));
      return fileHashes.get(key);
    };
    const sourceAt = sha => {
      if (!sourceCache.has(sha)) sourceCache.set(sha, committedSourceIdentity(worktree, sha));
      return sourceCache.get(sha);
    };
    const verifyPoint = point => {
      if (git(worktree, ["rev-parse", "--verify", `${point.ref}^{commit}`]) !== point.commit
        || git(worktree, ["rev-parse", "--verify", `${point.commit}^{tree}`]) !== point.gitTree
        || !isDeepStrictEqual(sourceAt(point.commit), point.source)) throw new Error("tree carry ref, Git tree or source identity changed");
    };
    const points = [carry.proof, carry.published, ...(carry.proofs ?? [])];
    for (const point of points) verifyPoint(point);
    const byCommit = new Map(points.map(point => [point.commit, point]));
    const scopes = new Map(); // All records from one immutable proof share one classification in this validation pass.
    const scopeFrom = boundary => {
      if (scopes.has(boundary)) return scopes.get(boundary);
      const request = { ...runsFile.qaImpactRequest, lastQa: { boundary } };
      delete request.since;
      let ancestor = false;
      try { git(worktree, ["merge-base", "--is-ancestor", boundary, carry.proof.commit]); ancestor = true; } catch { /* Explicit binding is required below. */ }
      if (!ancestor && !byCommit.has(boundary)) throw new Error("non-ancestor scope needs a pinned proof point");
      const scope = ancestor && carry.proofs === undefined ? qaImpactRequestAtCommit(worktree, request, carry.proof.commit)
        : qaImpactDirectCommitScope(worktree, request, carry.proof.commit);
      scopes.set(boundary, scope);
      return scope;
    };
    if (!isDeepStrictEqual(runsFile.source, carry.published.source) || current.head !== commit || current.treeSha256 !== carry.published.source.treeSha256
      || git(worktree, ["status", "--porcelain", "--untracked-files=all"]) !== ""
      || carry.proof.gitTree !== carry.published.gitTree || carry.proof.source.treeSha256 !== carry.published.source.treeSha256) {
      throw new Error("tree carry needs clean equal Git/source trees at proof and publication");
    }
    if (runsFile.qaImpactRequest?.since !== undefined && runsFile.qaImpactRequest.since !== runsFile.qaImpactRequest?.lastQa?.boundary) throw new Error("carry scope boundary differs from request");
    const impact = scopeFrom(runsFile.qaImpactRequest?.lastQa?.boundary);
    if (carry.laneKey !== impact.laneKey || carry.laneKey !== runsFile.targetedInventory?.impactKey
      || carry.laneKey !== runsFile.qaImpact?.laneKey) throw new Error("tree carry lane key differs from recomputed proof scope");
    const allRuns = [...(runsFile.testRuns ?? []), ...(runsFile.runs ?? [])];
    const metadata = realpathSync(git(worktree, ["rev-parse", "--absolute-git-dir"]));
    for (const record of carry.runs) {
      const result = record.result;
      if (runsFile.targetedInventory?.laneReport?.source?.kind === "github-workflow"
        && !runsFile.targetedInventory.laneReport.matches?.some(lane => lane.name === result.lane && lane.command === result.command)) {
        throw new Error("tree carry result is not an exact declared workflow lane");
      }
      if (record.scopeKey !== carry.laneKey || !allRuns.some(run => isDeepStrictEqual(run, result))) throw new Error("tree carry recorded run or lane key changed");
      if (result.commit !== carry.proof.commit) {
        const intervening = scopeFrom(result.commit);
        if (impact.lanes.includes(result.lane) || intervening.lanes.includes(result.lane)) throw new Error("tree carry scope includes this lane; original result is not reusable");
      }
      const file = path.join(metadata, record.receipt.path);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || realpathSync(file) !== file) throw new Error("tree carry receipt is not a bounded regular private file");
      const bytes = readFileSync(file);
      if (createHash("sha256").update(bytes).digest("hex") !== record.receipt.sha256) throw new Error("tree carry receipt hash changed");
      const receipt = JSON.parse(bytes);
      if (Object.keys(receipt).sort().join("|") !== "coveredFiles|result|source|version" || receipt.version !== 1
        || !isDeepStrictEqual(receipt.source, sourceAt(result.commit)) || !isDeepStrictEqual(receipt.result, result)
        || !isDeepStrictEqual(receipt.coveredFiles, record.coveredFiles)) throw new Error("tree carry receipt is incomplete or its recorded result/source changed");
      const coveredPaths = new Set(record.coveredFiles.map(item => item.path));
      const laneSource = runsFile.targetedInventory?.laneReport?.source;
      if (laneSource?.kind === "github-workflow" && !coveredPaths.has(laneSource.path)) {
        throw new Error("tree carry must cover the immutable workflow definition");
      }
      const selected = runsFile.qaImpactRequest?.laneSelections?.files ?? runsFile.qaImpactRequest?.laneSelections ?? {};
      if (impact.changedFiles.some(file => selected[file]?.includes(result.lane) && !coveredPaths.has(file))) throw new Error("tree carry omits a changed covered file");
      for (const covered of record.coveredFiles) for (const sha of new Set([result.commit, carry.proof.commit, commit])) {
        if (hashAt(sha, covered.path) !== covered.sha256) throw new Error(`${covered.path}: tree carry covered file changed`);
      }
    }
    // Recheck refs after all receipts/object reads, not only before the scan.
    for (const point of points) verifyPoint(point);
    return { impact, allowedRuns: carry.runs.map(record => record.result) };
  });
}

function recomputedImpact(runsFile, worktree, commit) {
  let normal;
  if (!worktree || !runsFile?.qaImpactRequest) normal = { problem: "older lane evidence needs a qaImpactRequest recomputed in the worktree" };
  else try {
    const impact = qaImpactRequest(worktree, runsFile.qaImpactRequest);
    normal = /^[a-f0-9]{16}$/.test(impact.laneKey ?? "") ? { impact } : { problem: "recomputed QA impact has no laneKey" };
  } catch (error) { normal = { problem: `QA impact could not be recomputed: ${error.message}` }; }
  if (runsFile?.treeEquivalentCarry === undefined) return normal;
  try {
    return verifiedCarryImpact(runsFile, worktree, commit);
  } catch (error) { return { problem: `tree-equivalent carry refused: ${error.message}` }; }
}

/** Every required lane finished and passed for its recomputed changed-file scope. */
export function evidenceProblems(runsFile, changed, commit, worktree) {
  if (!Array.isArray(runsFile?.touchFlows) || (runsFile.touchFlows.length === 0 && !runsFile.touchFlowsReason)) {
    return ["list every touched card, narrow or touch flow in touchFlows, or [] with a touchFlowsReason"];
  }
  const allRuns = Array.isArray(runsFile?.runs) ? runsFile.runs : [];
  const older = Boolean(commit) && allRuns.some((run) => run?.commit && run.commit !== commit);
  const recomputed = older || runsFile?.treeEquivalentCarry !== undefined ? recomputedImpact(runsFile, worktree, commit) : null;
  if (recomputed?.problem) return [recomputed.problem];
  const impactKey = recomputed?.impact?.laneKey;
  return requiredLanes(changed, runsFile.touchFlows, sessionAreas(worktree)).filter((lane) => !(lane === "e2e" && e2eLeftForCi(runsFile, changed, commit, prRules(worktree)))).flatMap((lane) => {
    const runs = allRuns.filter((run) => run.lane === lane);
    if (runs.length === 0) return [`${lane}: no run recorded`];
    return runs.flatMap((run) => [
      ...(passedOrMainPreexisting(run) ? [] : [`${lane}: ${run.status ?? "no status"}; a pull request never opens on an unfinished or failed run`]),
      ...(run.command && run.outcome ? [] : [`${lane}: command or visible outcome missing`]),
      ...(impactKey && run.commit !== commit && run.laneKey !== impactKey && !recomputed?.allowedRuns?.some(record => isDeepStrictEqual(record, run)) ? [`${lane}: changed-file scope ${run.laneKey ?? "missing"} does not match recomputed ${impactKey}`] : []),
      ...(run.commit !== commit && recomputed?.allowedRuns && !recomputed.allowedRuns.some(record => isDeepStrictEqual(record, run)) ? [`${lane}: no verified tree carry receipt for the recorded run`] : []),
      ...(lane === "storybook-plays" ? playVerdictProblems(run) : []),
    ]);
  });
}

/** What a drafted body gets wrong against the facts. */
export function bodyProblems(body, facts, files, prBase, template = "", runsFile = null, planPrefix = null) {
  const flat = body.replace(/\s+/g, " ");
  const byPath = new Map(files.map((file) => [file.path, file]));
  const changedLine = (file, line) => file.hunks.some((hunk) => hunk.added.some((entry) => entry.line === line)
    || (hunk.newCount === 0 && (line === hunk.newStart || line === hunk.newStart + 1)));
  const mentioned = new Set([...body.matchAll(PR_NUMBER)].map((match) => Number(match[1])));
  return [
    ...[...body.matchAll(CITATION)].flatMap(([cited, file, line]) => (byPath.has(file) && byPath.get(file).status !== "D" && changedLine(byPath.get(file), Number(line))
      ? [] : [`${cited} is not a changed line of the diff`])),
    ...(facts.overlap === null ? ["open pull requests could not be read, so overlap is unchecked"] : facts.overlap
      .filter((pr) => !mentioned.has(pr.number)).map((pr) => `overlap with open #${pr.number} is not stated`)),
    ...(facts.overlapUnavailable ?? []).filter(({ number, reason }) => !body.includes(`Overlap unavailable: #${number} (${reason})`))
      .map(({ number, reason }) => `Overlap unavailable: #${number} (${reason}) must be stated; no overlap conclusion is possible`),
    ...facts.assertionChanges.map((change) => (change.line ? `${change.path}:${change.line}` : change.path))
      .filter((cite) => !body.includes(cite)).map((cite) => `assertion change ${cite} is not listed`),
    ...facts.contractChanges.filter((change) => !body.includes(change.name)).map((change) => `${change.kind} export ${change.name} is not listed`),
    ...facts.refusals.filter((refusal) => !body.includes(`${refusal.path}:${refusal.line}`))
      .map((refusal) => `new ${refusal.status} refusal ${refusal.path}:${refusal.line} is not listed`),
    ...facts.asks.filter((ask) => !flat.includes(ask)).map((ask) => `ticket ask not quoted and answered: ${ask}`),
    ...(prBase !== "main" && !flat.includes(STACKED_BASE_STATEMENT) ? [`base is ${prBase}; add verbatim: ${STACKED_BASE_STATEMENT}`] : []),
    ...pointerProblems(body, planPrefix).map(({ line, kind }) => `body line ${line}: ${kind}`),
    ...prBodyClaimProblems(body, runsFile),
    ...templateHeadingProblems(body, template),
  ];
}

/** The session's own GitHub repository, from its worktree's origin remote; its open PRs are the ones it can collide with. */
export function sessionRepository(worktree) {
  let origin = null;
  try { origin = git(worktree, ["remote", "get-url", "origin"]); } catch { /* reported below */ }
  const repository = githubRepository(origin);
  if (!repository) throw new Error(`the worktree's origin remote (${origin ?? "none"}) is not a github.com repository, so its open pull requests cannot be listed`);
  return repository;
}

/** Every open PR of the session's repository with its complete file list; GitHub's diff endpoint caps large patches at 300 files. */
export function loadOpenPrs(worktree) {
  const repo = sessionRepository(worktree);
  const prs = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,title,headRefName,files"]));
  return prs.map(({ files, ...pr }) => {
    if (files.length < GH_LIST_FILE_CAP) return { ...pr, files: files.map((file) => file.path) };
    const endpoint = `repos/${repo}/pulls/${pr.number}`;
    const count = Number(gh(["api", endpoint, "--jq", ".changed_files"]));
    const names = gh(["api", "--paginate", `${endpoint}/files?per_page=100`, "--jq", ".[].filename"]).split("\n").filter(Boolean);
    if (!Number.isSafeInteger(count) || count < GH_LIST_FILE_CAP || names.length > count) {
      throw new Error(`PR #${pr.number} returned an invalid changed-file count`);
    }
    if (names.length === count) return { ...pr, files: names };
    if (names.length === 3000 && count > 3000) return { ...pr, files: [],
      unavailableReason: `GitHub file API exposes 3000 of ${count} changed files` };
    throw new Error(`PR #${pr.number} file API returned ${names.length} of ${count} changed files; overlap is unverified`);
  });
}

/** The facts for the inventory's JSON, with the gates when a body or a runs file is given. */
export function pullRequestFacts({ worktree, base, include, prs, ownBranch, ticketText, body, runs, commit, prBase = "main", requiredTests = [], template,
  probeCapability = currentCapabilityProbe }) {
  return withStableSource(worktree, current => {
    const binding = runs?.source === undefined ? { testedCommit: commit, problems: [] }
      : authenticatedSourceCarry(worktree, runs.source, current, commit);
    const testedCommit = binding.testedCommit;
    const bindingProblems = binding.problems;
    const files = readDiff(worktree, base).filter((file) => include.has(file.path));
    const changed = files.map((file) => file.path);
    const { contracts, refusals } = contractChanges(files, prRules(worktree).refusalPaths);
    const areas = sessionAreas(worktree);
    const facts = {
      serverOnly: !changed.some((file) => isUiFile(file, areas)),
      requiredLanes: requiredLanes(changed, [], areas),
      assertionChanges: assertionChanges(files),
      contractChanges: contracts,
      refusals,
      asks: ticketText ? [...new Set([...ticketText.matchAll(ASK)].map(([ask]) => ask.replace(/\s+/g, " ").trim()))] : [],
      overlap: prs ? computeOverlap({ worktree, changed, prs, ownBranch }) : null,
      overlapUnavailable: prs ? prs.filter((pr) => pr.headRefName !== ownBranch && pr.unavailableReason)
        .map(({ number, title, unavailableReason: reason }) => ({ number, title, reason })) : [],
    };
    return {
      ...facts,
      ...(body === undefined ? {} : { prBodyProblems: [
        ...bodyProblems(body, facts, files, prBase, template ?? readTemplate(worktree, base), runs, sessionLocalPlanPrefix(worktree)),
        ...(runs === undefined ? [] : knownMainFailureProblems(body, runs)),
      ] }),
      ...(runs === undefined ? {} : { prEvidenceProblems: [
        ...bindingProblems,
        ...prEvidenceValidationProblems(runs, testedCommit, { worktree, files, scopeBase: base, scopeInclude: include,
          scopeAuthority: SCOPED_CORPUS_AUTHORITY,
          readSource: file => proofSourceAt(worktree, file), probeCapability, currentCommit: commit,
          requiredTests }),
        ...ciCheckProblems(runs, changed, testedCommit),
      ] }),
    };
  });
}

/** Authenticate the same clean ancestor/equal-tree carry for inventory and PR comment. */
function authenticatedSourceCarry(worktree, source, current, publishedCommit) {
  let ancestor = false;
  if (validSourceIdentity(source)) {
    try { git(worktree, ["merge-base", "--is-ancestor", source.head, current.head]); ancestor = true; }
    catch { /* Unproven ancestry remains a failed carry. */ }
  }
  const omitted = git(worktree, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]) !== "";
  const problems = !validSourceIdentity(source) || source.treeSha256 !== current.treeSha256
    || publishedCommit !== current.head || !ancestor || omitted
    ? [omitted
      ? "published commit omitted uncommitted or untracked inputs covered by the tested source identity"
      : "tested source identity does not match current content and its proven commit ancestry"] : [];
  return { testedCommit: problems.length ? publishedCommit : source.head, problems };
}

function currentCapabilityProbe({ worktree, commit }) {
  if (git(worktree, ["rev-parse", "HEAD"]) !== commit) throw new Error("HEAD moved before the capability probe");
  return probeE2eCapability({ worktree, commit });
}

/**
 * Confirm the verifier's CI carry still matches this machine's read-only
 * runtime probe. A fabricated "no Docker" report cannot waive E2E merely by
 * selecting no tier; a changed prerequisite requires fresh evidence.
 */
export function capabilityProbeProblems(evidence, worktree, commit, probeCapability = currentCapabilityProbe, currentCommit = commit) {
  const carried = (Array.isArray(evidence?.testRuns) ? evidence.testRuns : [])
    .filter((run) => run?.status === "not-run" && typeof run.path === "string" && isE2ePath(run.path));
  if (carried.length === 0) return [];
  const recorded = evidence?.e2eCapability;
  if (!commit || recorded?.probedCommit !== commit) return ["E2E capability probe is not bound to the final committed HEAD"];
  let current;
  try { current = probeCapability({ worktree, commit: currentCommit }); }
  catch { return ["current E2E capability probe could not be verified; do not carry specs to CI"]; }
  if (!current?.container || !current.desktopHarness || current.probedCommit !== currentCommit) {
    return ["current E2E capability probe is incomplete; do not carry specs to CI"];
  }
  const named = recorded.container;
  if (!named || named.dockerPresent !== current.container.dockerPresent
    || named.dockerReachable !== current.container.dockerReachable
    || named.minimumMemoryGiB !== current.container.minimumMemoryGiB
    || named.minimumDiskGiB !== current.container.minimumDiskGiB
    || named.command !== current.container.command
    || (named.memoryGiB >= named.minimumMemoryGiB) !== (current.container.memoryGiB >= current.container.minimumMemoryGiB)
    || (named.diskGiB >= named.minimumDiskGiB) !== (current.container.diskGiB >= current.container.minimumDiskGiB)
    || named.runnable !== current.container.runnable
    || named.notRunnableReason !== current.container.notRunnableReason) {
    return ["Docker runtime probe differs from the current machine; rerun the read-only capability probe and rewrite CI carry evidence"];
  }
  if (!named.secretsSet || !current.container.secretsSet) {
    return ["E2E identity-key presence probe is incomplete; do not carry specs to CI"];
  }
  for (const key of requiredContainerIdentity()) {
    if (named.secretsSet?.[key] !== current.container.secretsSet[key]) {
      return ["E2E identity-key presence differs from the current machine; rerun the read-only capability probe"];
    }
  }
  const desktopSpecs = prRules(worktree).desktopSpecs;
  if (desktopSpecs && carried.some((run) => run.path.startsWith(desktopSpecs))
    && (recorded.desktopHarness?.available !== current.desktopHarness.available
      || recorded.desktopHarness?.reason !== current.desktopHarness.reason
      || recorded.desktopHarness?.probe !== current.desktopHarness.probe)) {
    return ["Desktop displayless probe differs from the current machine; rerun the read-only capability probe"];
  }
  return [];
}

/** One source-backed carry and mutation-proof decision for inventory and PR comment. */
export function prEvidenceValidationProblems(evidence, commit, options = {}) {
  const { worktree, probeCapability = currentCapabilityProbe } = options;
  const receiptDir = options.receiptDir ?? (worktree ? git(worktree, ["rev-parse", "--absolute-git-dir"]) : undefined);
  const current = worktree ? sourceIdentity(worktree) : options.currentSource;
  const currentCommit = options.currentCommit ?? current?.head ?? commit;
  let sourceProblems = [];
  if (current && (!validSourceIdentity(evidence?.source) || commit !== evidence.source.head)) {
    sourceProblems = ["evidence source does not match the current worktree HEAD and source identity"];
  } else if (current && !sameSource(evidence.source, current)) {
    sourceProblems = worktree
      ? authenticatedSourceCarry(worktree, evidence.source, current, current.head).problems
        .map(problem => `evidence source does not match the current worktree HEAD and source identity: ${problem}`)
      : ["evidence source does not match the current worktree HEAD and source identity"];
  }
  let files = options.files ?? options.candidateFiles;
  let scopeProblems = [];
  if (worktree) {
    try {
      const authenticated = options.scopeAuthority === SCOPED_CORPUS_AUTHORITY
        && options.scopeBase && options.scopeInclude instanceof Set
        ? readDiff(worktree, options.scopeBase).filter(file => options.scopeInclude.has(file.path))
        : evidenceCandidateFiles(worktree);
      if (Array.isArray(files)) {
        const expected = authenticated.map(file => file.path).sort();
        const supplied = files.map(file => file.path).sort();
        if (!isDeepStrictEqual(supplied, expected)) scopeProblems = ["changed proof corpus does not match the authenticated session scope"];
      } else files = authenticated;
    } catch { files = null; }
  }
  const candidateProblem = Array.isArray(files) ? [] : ["changed proof candidates need an exact worktree or explicit test corpus"];
  if (!Array.isArray(files)) files = [];
  const readSource = options.readSource ?? (worktree ? file => proofSourceAt(worktree, file) : () => null);
  // The changed corpus is read as main reads it; only evidence-named proof paths go through the bounded reader.
  const readCandidates = options.readCandidates ?? (worktree ? file => {
    try { return readFileSync(path.join(worktree, file), "utf8"); } catch { return null; }
  } : readSource);
  const specs = (Array.isArray(evidence?.targetedInventory?.entries) ? evidence.targetedInventory.entries : [])
    .filter(entry => entry?.kind === "e2e").map(entry => entry.path);
  return [
    ...evidenceProblems(evidence, files.map(file => file.path), commit, worktree),
    ...selectionProblems(evidence, files, options.requiredTests ?? [], commit, prRules(worktree ?? null)),
    ...targetedEvidenceProblems(evidence, commit, worktree, receiptDir),
    ...tierEvidenceProblems(evidence?.e2eCapability, specs),
    ...sourceProblems,
    ...scopeProblems,
    ...candidateProblem,
    ...testIntegrityProblems(evidence, files, readSource, commit, receiptDir, readCandidates),
    ...capabilityProbeProblems(evidence, worktree, commit, probeCapability, currentCommit),
  ];
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER }).trim();
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER }).trim();
}

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

/**
 * Test selection over the whole branch diff (vibe-pr-evidence.json
 * `testSelection` and `testRuns`). Each changed source file needs an import
 * selection that returned tests (a graph test lookup), or the repo's related-test
 * selection when the graph found none or does not index the file, plus an e2e
 * by-reference selection, since import selection never reaches specs that
 * drive the app. Every selected test, every required test of the diff rules and
 * every spec the branch edits needs a passing run on the published commit;
 * skipped CI is not a run. A required test with `flagStates` needs a passing
 * run for each state, recorded with `flag`.
 */
export function selectionProblems(runsFile, files, requiredTests, commit, rules = GENERIC_PR_RULES) {
  const { entries: selection, problems: shapeProblems } = readTestSelection(runsFile);
  const listed = (entry) => Array.isArray(entry?.tests) && entry.tests.every((test) => typeof test === "string");
  const problems = [...shapeProblems];
  const of = (file, selector) => selection.filter((entry) => entry?.file === file && entry.selector === selector && listed(entry));
  const live = files.filter((file) => file.status !== "D");
  for (const file of live.filter((entry) => SOURCE.test(entry.path) && !isTestFile(entry.path)).map((entry) => entry.path)) {
    if (!of(file, GRAPH_SELECTOR).some((entry) => entry.tests.length > 0) && of(file, "related").length === 0) {
      problems.push(`${file}: no import selection; no graph test lookup (${GRAPH_SELECTOR}) returned tests for it, so record the repo's related-test selection`);
    }
    if (of(file, "e2e-reference").length === 0) {
      problems.push(`${file}: no e2e by-reference selection (routes, request fields, test IDs, accessible names, channels and flag keys it touches)`);
    }
  }
  const selected = new Set([
    ...selection.filter((entry) => TEST_SELECTORS.includes(entry?.selector) && listed(entry)).flatMap((entry) => entry.tests),
    ...requiredTests.map((entry) => entry.path),
    ...live.filter((entry) => TEST_SPEC_PATTERN.test(entry.path)).map((entry) => entry.path),
  ]);
  const runs = Array.isArray(runsFile?.testRuns) ? runsFile.testRuns : [];
  const inventoryEntries = Array.isArray(runsFile?.targetedInventory?.entries) ? runsFile.targetedInventory.entries : [];
  const target = (test) => inventoryEntries.find((entry) => entry?.path === test);
  const unavailable = new Set(Array.isArray(runsFile?.e2eCapability?.unavailableSpecs) ? runsFile.e2eCapability.unavailableSpecs : []);
  const acceptedCommit = (test) => target(test)?.resultCommit ?? commit;
  const carried = (test) => !commit || acceptedCommit(test) === commit
    || (target(test)?.carriedTo === commit && typeof target(test)?.carryReason === "string" && target(test).carryReason.length > 0);
  const passed = (test, flag) => carried(test) && runs.some((entry) => entry?.path === test && passedOrMainPreexisting(entry) && (!acceptedCommit(test) || entry.commit === acceptedCommit(test))
    && (flag === undefined || entry.flag === flag) && (!isE2ePath(test) || (!unavailable.has(test)
      && entry.command === target(test)?.command && Array.isArray(entry.cases)
      && target(test)?.cases?.every((name) => entry.cases.includes(name)))));
  for (const test of [...selected].sort()) {
    if (!passed(test) && !e2eCarriedForCi(runsFile, selection, test, commit, rules)) {
      problems.push(`${test}: selected but no passing or carried run for ${commit ?? "the published commit"} in testRuns`);
    }
  }
  for (const entry of requiredTests.filter((item) => Array.isArray(item.flagStates))) {
    for (const flag of entry.flagStates.filter((state) => !passed(entry.path, state))) {
      problems.push(`${entry.path}: no passing run with the flag ${flag} for ${commit ?? "the published commit"} (testRuns entry with flag: "${flag}")`);
    }
  }
  return problems;
}

/**
 * A changed E2E spec may remain not run locally only with a per-spec record,
 * exact selected HEAD, a proved per-spec execution limitation and named CI.
 * Desktop additionally needs the matching not-run lane from the lane report. Without the provider's
 * E2E CI owners (`rules.e2eOwners`) no spec is left for CI.
 */
function e2eCarriedForCi(evidence, selection, spec, commit, rules) {
  if (!rules?.e2eOwners || !commit || !isE2ePath(spec) || !TEST_SPEC_PATTERN.test(spec)) return false;
  const capability = evidence?.e2eCapability;
  if (!capability || !Array.isArray(capability.unavailableSpecs) || !capability.unavailableSpecs.includes(spec)) return false;
  const limitation = specExecutionLimitation(capability, spec, commit);
  if (!limitation) return false;
  if (!selection.some((entry) => entry.selector === "e2e-reference" && Array.isArray(entry.tests) && entry.tests.includes(spec))) return false;
  const desktop = Boolean(rules.desktopSpecs) && spec.startsWith(rules.desktopSpecs);
  const reason = desktop ? NOT_RUN_NO_DESKTOP_HARNESS : NOT_RUN_NO_IDENTITY;
  const ciOwner = desktop ? rules.e2eOwners.desktop : rules.e2eOwners.web;
  const laneReport = evidence?.targetedInventory?.laneReport;
  if (!Array.isArray(capability.ciCoverage) || !capability.ciCoverage.includes(ciOwner)
    || laneReportShapeProblems(laneReport).length !== 0
    || laneReport?.source?.kind !== "github-workflow" && laneReportLabel(laneReport) !== rules.laneReport) return false;
  const runs = Array.isArray(evidence.testRuns) ? evidence.testRuns : [];
  const own = runs.some((run) => run?.path === spec && run.status === "not-run" && run.commit === commit
    && run.reason === reason && run.ciOwner === ciOwner && run.selectionSource === "e2e-reference"
    && run.laneReportSource === laneReportLabel(evidence?.targetedInventory?.laneReport) && (limitation.tier === null
      ? run.selectedTier === undefined || run.selectedTier === null
      : run.selectedTier === limitation.tier && (limitation.kind === "displayless"
        ? run.displaylessLimitation === limitation.displaylessLimitation && run.missingPrerequisites === undefined
        : Array.isArray(run.missingPrerequisites) && run.missingPrerequisites.length === limitation.missingPrerequisites.length
          && limitation.missingPrerequisites.every((key) => run.missingPrerequisites.includes(key)))));
  if (!own || !desktop) return own;
  const matches = evidence.targetedInventory.laneReport.matches;
  const lane = Array.isArray(matches) ? matches.find((entry) => entry?.name === "desktop-e2e" && isDesktopE2eLane(entry.command ?? "")) : null;
  return Boolean(lane) && runs.some((run) => run?.lane === lane.name && run.command === lane.command
    && run.status === "not-run" && run.commit === commit && run.reason === reason);
}

/**
 * A PR is gated on a read-only inventory of its final committed diff. Every
 * inventory row names exact cases and a command, and has a passing result at
 * that SHA unless the E2E capability record explicitly leaves it to CI.
 */
export function targetedEvidenceProblems(runsFile, commit, worktree, receiptDir) {
  const inventory = runsFile?.targetedInventory;
  if (!inventory || typeof inventory !== "object") return ["targeted inventory of the final committed diff is missing"];
  const { entries: selection } = readTestSelection(runsFile);
  const problems = [...prEvidenceShapeProblems(runsFile,
    receiptDir ?? (worktree ? git(worktree, ["rev-parse", "--absolute-git-dir"]) : undefined),
    worktree ? file => proofSourceAt(worktree, file) : undefined)];
  const runs = Array.isArray(runsFile?.testRuns) ? runsFile.testRuns : [];
  const laneRuns = runs.filter((run) => run?.lane);
  const older = Boolean(commit) && (inventory.commit !== commit || laneRuns.some((run) => run?.commit && run.commit !== commit));
  const recomputed = older || runsFile?.treeEquivalentCarry !== undefined ? recomputedImpact(runsFile, worktree, commit) : null;
  if (recomputed?.problem) problems.push(recomputed.problem);
  const impactKey = recomputed?.impact?.laneKey;
  if (inventory.actor !== "read-only") problems.push("targeted inventory must come from a read-only subagent");
  if (inventory.source !== "final-committed-diff" && !(inventory.source === "working-tree" && validSourceIdentity(runsFile?.source) && inventory.commit === runsFile.source.head)) problems.push("targeted inventory must read the final committed diff, not the plan");
  if (impactKey && inventory.impactKey !== impactKey) {
    problems.push("targeted inventory does not name recomputed qa-impact.mjs changed-file scope");
  }
  problems.push(...repositoryLaneReportProblems(inventory.laneReport, worktree, commit));
  const laneMatches = Array.isArray(inventory.laneReport?.matches) ? inventory.laneReport.matches : [];
  for (const lane of laneMatches) {
    if (!lane?.name || !lane?.command) problems.push("each matching post-merge lane needs its repository name and exact command");
    else if (!(lane.mentionOnly === true && text(lane.notRunReason))
      && !runs.some((run) => run?.lane === lane.name && run.command === lane.command
        && (!impactKey || run.commit === commit || run.laneKey === impactKey || recomputed?.allowedRuns?.some(record => isDeepStrictEqual(record, run)))
        && (!recomputed?.allowedRuns || recomputed.allowedRuns.some(record => isDeepStrictEqual(record, run)))
        && (passedOrMainPreexisting(run) || desktopLeftForCi(run)))) {
      problems.push(`lane ${lane.name}: no passing run of its lane command for changed-file scope ${impactKey ?? "missing"}; a hand-picked subset is not the lane (#9238)`);
    }
  }
  if (!Array.isArray(inventory.entries) || (inventory.entries.length === 0 && !inventory.noTestsReason)) {
    problems.push("targeted inventory needs exact entries or a no-tests reason");
  }
  const entries = Array.isArray(inventory.entries) ? inventory.entries : [];
  if (runsFile?.e2eCapability?.unavailableSpecs !== undefined && !Array.isArray(runsFile.e2eCapability.unavailableSpecs)) {
    problems.push("e2eCapability.unavailableSpecs must be an array");
  }
  const unavailable = new Set(Array.isArray(runsFile?.e2eCapability?.unavailableSpecs) ? runsFile.e2eCapability.unavailableSpecs : []);
  for (const entry of entries) {
    if (!entry?.kind || !entry?.path || !entry?.command || !Array.isArray(entry?.cases) || entry.cases.length === 0) {
      problems.push(`targeted inventory entry for ${entry?.path ?? "unknown path"} needs kind, path, cases and exact command`);
      continue;
    }
    if (entry.kind === "e2e" && unavailable.has(entry.path)) {
      if (!e2eCarriedForCi(runsFile, selection, entry.path, commit, prRules(worktree))) {
        problems.push(`${entry.path}: unavailable E2E needs an exact not-run spec record and authoritative CI owner`);
      }
      continue;
    }
    const resultCommit = entry.resultCommit ?? commit;
    if (resultCommit !== commit) {
      if (entry.carriedTo !== commit || !entry.carryReason) problems.push(`${entry.path}: an earlier result needs the final SHA and a carry reason`);
      if (!Array.isArray(entry.coveredFiles) || entry.coveredFiles.length === 0) {
        problems.push(`${entry.path}: a carried result needs covered file hashes`);
      }
      for (const covered of Array.isArray(entry.coveredFiles) ? entry.coveredFiles : []) {
        const current = finalFileHash(inventory, worktree, covered?.path);
        if (!covered?.path || !/^[a-f0-9]{64}$/i.test(covered?.sha256 ?? "")) problems.push(`${entry.path}: carried file hash is invalid`);
        else if (current !== covered.sha256) problems.push(`${covered.path}: covered file hash changed before ${commit}`);
      }
    }
    const passed = runs.some((run) => run?.path === entry.path && passedOrMainPreexisting(run) && run.commit === resultCommit
      && run.command === entry.command && Array.isArray(run.cases) && entry.cases.every((name) => run.cases.includes(name)));
    if (!passed) problems.push(`${entry.path}: no passing targeted run with its exact cases and command on ${resultCommit}`);
  }
  const selected = new Set(selection.flatMap((entry) => Array.isArray(entry.tests) ? entry.tests : []));
  const inventoried = new Set(entries.map((entry) => entry?.path));
  for (const test of [...selected].filter(Boolean).filter((test) => !inventoried.has(test))) {
    problems.push(`${test}: selected test is absent from the targeted inventory`);
  }
  if (!Array.isArray(runsFile?.rerunCycles)) problems.push("rerunCycles must record isolated reruns, or [] when none failed");
  for (const cycle of Array.isArray(runsFile?.rerunCycles) ? runsFile.rerunCycles : []) {
    if (![cycle?.failed, cycle?.newlyReached, cycle?.rerun].every(Array.isArray)) {
      problems.push("each rerun cycle needs failed, newlyReached and rerun arrays");
      continue;
    }
    const failed = new Set(cycle.failed);
    const allowed = new Set([...cycle.failed, ...cycle.newlyReached]);
    const rerun = new Set(cycle.rerun);
    if (!cycle?.fromCommit || !cycle?.toCommit || failed.size === 0) problems.push("each rerun cycle needs its source SHA, fixed SHA and failed cases");
    if (rerun.size !== allowed.size || [...rerun].some((item) => !allowed.has(item))) problems.push("a rerun cycle may contain only its failed cases and targets newly reached by the fix");
  }
  return problems;
}

/**
 * A change to a check, a CI script or a workflow is reproduced in the shape of
 * the CI job that runs it. #9230 added a gate inside a batch-only job that
 * checks out at depth 1 with no base ref; it passed in a full local clone and
 * turned every post-merge batch red. `ciCheckRepros` lists, per job,
 * `{ job, tier, checkout, command, status, commit }` from `ci-job-shape.mjs`
 * and a run in that shape, or is [] with `noCiCheckReason`.
 */
export function ciCheckProblems(runsFile, changed, commit) {
  if (!changed.some((file) => CI_CHECK_PATH.test(file))) return [];
  const repros = runsFile?.ciCheckRepros;
  if (!Array.isArray(repros)) return ["the diff changes a check or CI script: record ciCheckRepros from ci-job-shape.mjs (each job's tier, checkout and a passing run in that shape), or [] with noCiCheckReason"];
  if (repros.length === 0) return text(runsFile.noCiCheckReason) ? [] : ["ciCheckRepros is empty without a noCiCheckReason"];
  return repros.flatMap((repro) => {
    if (!text(repro?.job) || !text(repro?.tier) || !text(repro?.checkout) || !text(repro?.command)) return [`ciCheckRepros entry ${repro?.job ?? "unknown"} needs job, tier, checkout and command`];
    return repro.status === "passed" && repro.commit === commit ? [] : [`${repro.job}: no passing run in its CI checkout shape on ${commit}`];
  });
}

/**
 * The Desktop Electron lane cannot run on a machine without the displayless
 * Linux harness, and vibe never launches Electron natively; there
 * `pre-pr-lanes.mjs check` records it `not-run` and the post-merge
 * `desktop-e2e/validated` run covers it.
 */
function desktopLeftForCi(run) {
  return run?.status === "not-run" && isDesktopE2eLane(run.command ?? "") && text(run.reason);
}

/**
 * Every main-preexisting run is named in the body under Known main failures,
 * so the reviewer sees what the pull request did not cause.
 */
export function knownMainFailureProblems(body, runsFile) {
  const known = [...(runsFile?.runs ?? []), ...(runsFile?.testRuns ?? [])].filter(isMainPreexisting);
  if (known.length === 0) return [];
  const at = body.indexOf(KNOWN_MAIN_FAILURES);
  const listed = at < 0 ? "" : body.slice(at);
  return known.map((run) => run.path ?? run.command ?? run.lane).filter((name) => !listed.includes(name))
    .map((name) => `${name} fails on main too; list it under "${KNOWN_MAIN_FAILURES}" with the main commit`);
}

function finalFileHash(inventory, worktree, file) {
  if (!file) return undefined;
  if (worktree) {
    try { return createHash("sha256").update(readFileSync(path.join(worktree, file))).digest("hex"); }
    catch { return undefined; }
  }
  return inventory.fileHashes?.[file];
}

/** Read the first existing base template; absence is optional, but Git failures still propagate. */
function readTemplate(worktree, base) {
  const present = new Set(git(worktree, ["ls-tree", "-r", "--name-only", base, "--", ...TEMPLATE_PATHS]).split("\n").filter(Boolean));
  const file = TEMPLATE_PATHS.find((candidate) => present.has(candidate));
  return file ? git(worktree, ["show", `${base}:${file}`]) : "";
}

function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The one session diff base for proof candidates, shared by inventory and the PR comment: the recorded
 * main-sync main, else the merge-base with the comparison branch. Inventory passes its verified remote
 * comparison; other callers use the configured `vibe.baseRef` or the clone's recorded remote default.
 */
export function proofCorpusBase(worktree, comparisonOperand = () => localComparisonOperand(worktree)) {
  const record = readSessionRecord(worktree);
  const synced = record?.status === "active" && record?.operator ? readMainSyncProvenance(worktree) : undefined;
  return synced?.mainSha ?? git(worktree, ["merge-base", "HEAD", comparisonOperand()]);
}

function localComparisonOperand(worktree) {
  try {
    const configured = git(worktree, ["config", "--get", "vibe.baseRef"]);
    if (configured) return `origin/${configured}`;
  } catch { /* No configured base. */ }
  try { return git(worktree, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); } catch { return "origin/main"; }
}

/** The PR evidence rules (`data.recipes.prEvidence`) of the provider `binding` binds, or GENERIC_PR_RULES. */
export function prRulesFor(binding) {
  const data = providerDataOr(binding, "recipes", "prEvidence", null);
  return data ? Object.freeze({ ...GENERIC_PR_RULES, ...data }) : GENERIC_PR_RULES;
}

/** prRulesFor the session at `worktree`. */
export function prRules(worktree) {
  return prRulesFor(sessionBinding(worktree));
}
