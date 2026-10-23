// What a vibe pull request body must state, computed from the session diff for
// handoff-inventory.mjs: overlap with open pull requests (shared or imported
// files), assertion and export changes, new apps/api refusals, ticket asks and
// the evidence lanes, plus the body and evidence gates. No CLI of its own.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pointerProblems } from "../../vibe/scripts/publishable-text.mjs";
import { playVerdictProblems } from "../../vibe/scripts/story-play-verdict.mjs";
import { isE2ePath, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { tierEvidenceProblems } from "./e2e-tier.mjs";

const REPO = "closedloop-ai/symphony-alpha";
const MAX_BUFFER = 64 * 1024 * 1024;
const GH_LIST_FILE_CAP = 100;
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
const UI = ["apps/app/", "apps/web/", "apps/storybook/", "apps/prototypes/", "apps/desktop/src/renderer/", "packages/app/", "packages/design-system/"];
const DESKTOP_HOST = ["apps/desktop/src/renderer/", "packages/app/"];
const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];
const TEMPLATE_HEADING = /^#{1,6}\s+\S.*$/gm;
const SELECTORS = ["code_tests_for", "related", "e2e-reference"];

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

/** Open pull requests sharing a changed file, or a file a changed file imports. */
export function computeOverlap({ worktree, changed, prs, ownBranch }) {
  const changedSet = new Set(changed);
  const imported = new Set(changed.flatMap((file) => importsOf(worktree, file)).filter((file) => !changedSet.has(file)));
  return prs
    .filter((pr) => pr.headRefName !== ownBranch)
    .map((pr) => ({ number: pr.number, title: pr.title,
      sharedFiles: pr.files.filter((file) => changedSet.has(file)), importedFiles: pr.files.filter((file) => imported.has(file)) }))
    .filter((pr) => pr.sharedFiles.length + pr.importedFiles.length > 0)
    .sort((a, b) => a.number - b.number);
}

function importsOf(worktree, file) {
  const absolute = path.join(worktree, file);
  if (!SOURCE.test(file) || !existsSync(absolute)) {
    return [];
  }
  return [...readFileSync(absolute, "utf8").matchAll(IMPORT)].flatMap(([, specifier]) => {
    const [, pkg, ...rest] = specifier.split("/");
    const bases = specifier.startsWith(".") ? [path.posix.join(path.posix.dirname(file), specifier)]
      : specifier.startsWith("@repo/") ? [`packages/${pkg}/${rest.join("/") || "index"}`, `packages/${pkg}/src/${rest.join("/") || "index"}`]
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

/** Changed or removed exports outside tests, and new 4xx refusals in apps/api. */
export function contractChanges(files) {
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
      for (const line of file.path.startsWith("apps/api/") ? hunk.added : []) {
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

/** The evidence lanes a diff needs; none for a server-only diff. */
export function requiredLanes(changed, touchFlows = []) {
  const lanes = [];
  if (changed.some((file) => UI.some((prefix) => file.startsWith(prefix)))) {
    lanes.push("web-host");
    if (changed.some((file) => DESKTOP_HOST.some((prefix) => file.startsWith(prefix)))) lanes.push("desktop-host");
    if (touchFlows.length > 0) lanes.push("webkit-iphone", "chromium-pixel");
    if (changed.some((file) => /\.stories\.tsx?$/.test(file))) lanes.push("storybook-plays");
  }
  if (changed.some(isE2ePath)) lanes.push("e2e");
  return lanes;
}

/** Every required lane finished and passed on the published commit. */
export function evidenceProblems(runsFile, changed, commit) {
  if (!Array.isArray(runsFile?.touchFlows) || (runsFile.touchFlows.length === 0 && !runsFile.touchFlowsReason)) {
    return ["list every touched card, narrow or touch flow in touchFlows, or [] with a touchFlowsReason"];
  }
  return requiredLanes(changed, runsFile.touchFlows).flatMap((lane) => {
    const runs = (runsFile.runs ?? []).filter((run) => run.lane === lane);
    if (runs.length === 0) return [`${lane}: no run recorded`];
    return runs.flatMap((run) => [
      ...(run.status === "passed" ? [] : [`${lane}: ${run.status ?? "no status"}; a pull request never opens on an unfinished or failed run`]),
      ...(run.command && run.outcome ? [] : [`${lane}: command or visible outcome missing`]),
      ...(commit && run.commit !== commit ? [`${lane}: ran on ${run.commit}, not the published commit ${commit}`] : []),
      ...(lane === "storybook-plays" ? playVerdictProblems(run) : []),
    ]);
  });
}

/** What a drafted body gets wrong against the facts. */
export function bodyProblems(body, facts, files, prBase, template = "") {
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
    ...facts.assertionChanges.map((change) => (change.line ? `${change.path}:${change.line}` : change.path))
      .filter((cite) => !body.includes(cite)).map((cite) => `assertion change ${cite} is not listed`),
    ...facts.contractChanges.filter((change) => !body.includes(change.name)).map((change) => `${change.kind} export ${change.name} is not listed`),
    ...facts.refusals.filter((refusal) => !body.includes(`${refusal.path}:${refusal.line}`))
      .map((refusal) => `new ${refusal.status} refusal ${refusal.path}:${refusal.line} is not listed`),
    ...facts.asks.filter((ask) => !flat.includes(ask)).map((ask) => `ticket ask not quoted and answered: ${ask}`),
    ...(prBase !== "main" && !flat.includes(STACKED_BASE_STATEMENT) ? [`base is ${prBase}; add verbatim: ${STACKED_BASE_STATEMENT}`] : []),
    ...pointerProblems(body).map(({ line, kind }) => `body line ${line}: ${kind}`),
    ...templateHeadingProblems(body, template),
  ];
}

/** Every open pull request on symphony-alpha with its files, in one list call. */
export function loadOpenPrs() {
  const prs = JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "number,title,headRefName,files"]));
  return prs.map(({ files, ...pr }) => ({ ...pr, files: files.length >= GH_LIST_FILE_CAP
    ? gh(["pr", "diff", String(pr.number), "--repo", REPO, "--name-only"]).split("\n").filter(Boolean)
    : files.map((file) => file.path) }));
}

/** The facts for the inventory's JSON, with the gates when a body or a runs file is given. */
export function pullRequestFacts({ worktree, base, include, prs, ownBranch, ticketText, body, runs, commit, prBase = "main", requiredTests = [], template }) {
  const files = readDiff(worktree, base).filter((file) => include.has(file.path));
  const changed = files.map((file) => file.path);
  const { contracts, refusals } = contractChanges(files);
  const facts = {
    serverOnly: !changed.some((file) => UI.some((prefix) => file.startsWith(prefix))),
    requiredLanes: requiredLanes(changed),
    assertionChanges: assertionChanges(files),
    contractChanges: contracts,
    refusals,
    asks: ticketText ? [...new Set([...ticketText.matchAll(ASK)].map(([ask]) => ask.replace(/\s+/g, " ").trim()))] : [],
    overlap: prs ? computeOverlap({ worktree, changed, prs, ownBranch }) : null,
  };
  return {
    ...facts,
    ...(body === undefined ? {} : { prBodyProblems: bodyProblems(body, facts, files, prBase, template ?? readTemplate(worktree, base)) }),
    ...(runs === undefined ? {} : { prEvidenceProblems: [
      ...evidenceProblems(runs, changed, commit),
      ...selectionProblems(runs, files, requiredTests, commit),
      ...targetedEvidenceProblems(runs, commit, worktree),
      ...tierEvidenceProblems(runs.e2eCapability, (runs.targetedInventory?.entries ?? []).filter((entry) => entry?.kind === "e2e").map((entry) => entry.path)),
    ] }),
  };
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
 * selection that returned tests (`code_tests_for`), or the repo's related-test
 * selection when the graph found none or does not index the file, plus an e2e
 * by-reference selection, since import selection never reaches specs that
 * drive the app. Every selected test, every required test of the diff rules and
 * every spec the branch edits needs a passing run on the published commit;
 * skipped CI is not a run. A required test with `flagStates` needs a passing
 * run for each state, recorded with `flag`.
 */
export function selectionProblems(runsFile, files, requiredTests, commit) {
  const selection = Array.isArray(runsFile?.testSelection) ? runsFile.testSelection : [];
  const listed = (entry) => Array.isArray(entry?.tests) && entry.tests.every((test) => typeof test === "string");
  const problems = selection.filter((entry) => !SELECTORS.includes(entry?.selector))
    .map((entry) => `testSelection entry for ${entry?.file ?? "no file"} has selector ${JSON.stringify(entry?.selector)}; use one of ${SELECTORS.join(", ")}`);
  const of = (file, selector) => selection.filter((entry) => entry?.file === file && entry.selector === selector && listed(entry));
  const live = files.filter((file) => file.status !== "D");
  for (const file of live.filter((entry) => SOURCE.test(entry.path) && !isTestFile(entry.path)).map((entry) => entry.path)) {
    if (!of(file, "code_tests_for").some((entry) => entry.tests.length > 0) && of(file, "related").length === 0) {
      problems.push(`${file}: no import selection; code_tests_for returned no tests or does not index it, so record the repo's related-test selection`);
    }
    if (of(file, "e2e-reference").length === 0) {
      problems.push(`${file}: no e2e by-reference selection (routes, request fields, test IDs, accessible names, channels and flag keys it touches)`);
    }
  }
  const selected = new Set([
    ...selection.filter((entry) => SELECTORS.includes(entry?.selector) && listed(entry)).flatMap((entry) => entry.tests),
    ...requiredTests.map((entry) => entry.path),
    ...live.filter((entry) => TEST_SPEC_PATTERN.test(entry.path)).map((entry) => entry.path),
  ]);
  const runs = Array.isArray(runsFile?.testRuns) ? runsFile.testRuns : [];
  const target = (test) => runsFile?.targetedInventory?.entries?.find((entry) => entry?.path === test);
  const acceptedCommit = (test) => target(test)?.resultCommit ?? commit;
  const carried = (test) => !commit || acceptedCommit(test) === commit
    || (target(test)?.carriedTo === commit && typeof target(test)?.carryReason === "string" && target(test).carryReason.length > 0);
  const passed = (test, flag) => carried(test) && runs.some((entry) => entry?.path === test && entry.status === "passed" && (!acceptedCommit(test) || entry.commit === acceptedCommit(test))
    && (flag === undefined || entry.flag === flag));
  for (const test of [...selected].sort()) {
    if (!passed(test)) {
      problems.push(`${test}: selected but no passing or explicitly carried run for ${commit ?? "the published commit"} in testRuns`);
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
 * A PR is gated on a read-only inventory of its final committed diff. Every
 * inventory row names exact cases and a command, and has a passing result at
 * that SHA unless the E2E capability record explicitly leaves it to CI.
 */
export function targetedEvidenceProblems(runsFile, commit, worktree) {
  const inventory = runsFile?.targetedInventory;
  if (!inventory || typeof inventory !== "object") return ["targeted inventory of the final committed diff is missing"];
  const problems = [];
  if (inventory.actor !== "read-only") problems.push("targeted inventory must come from a read-only subagent");
  if (inventory.source !== "final-committed-diff") problems.push("targeted inventory must read the final committed diff, not the plan");
  if (!commit || inventory.commit !== commit) problems.push(`targeted inventory does not name the final committed SHA ${commit ?? "required by the gate"}`);
  if (inventory.laneReport?.command !== "pnpm test:lanes") problems.push("targeted inventory must use pnpm test:lanes as the repository lane source");
  if (!Array.isArray(inventory.laneReport?.matches)) problems.push("targeted inventory must list the post-merge lane matches from pnpm test:lanes");
  for (const lane of inventory.laneReport?.matches ?? []) {
    if (!lane?.name || !lane?.command) problems.push("each matching post-merge lane needs its repository name and exact command");
  }
  if (!Array.isArray(inventory.entries) || (inventory.entries.length === 0 && !inventory.noTestsReason)) {
    problems.push("targeted inventory needs exact entries or a no-tests reason");
  }
  const entries = Array.isArray(inventory.entries) ? inventory.entries : [];
  const unavailable = new Set(runsFile?.e2eCapability?.unavailableSpecs ?? []);
  const runs = Array.isArray(runsFile?.testRuns) ? runsFile.testRuns : [];
  for (const entry of entries) {
    if (!entry?.kind || !entry?.path || !entry?.command || !Array.isArray(entry?.cases) || entry.cases.length === 0) {
      problems.push(`targeted inventory entry for ${entry?.path ?? "unknown path"} needs kind, path, cases and exact command`);
      continue;
    }
    if (entry.kind === "e2e" && unavailable.has(entry.path)) continue;
    const resultCommit = entry.resultCommit ?? commit;
    if (resultCommit !== commit) {
      if (entry.carriedTo !== commit || !entry.carryReason) problems.push(`${entry.path}: an earlier result needs the final SHA and a carry reason`);
      if (!Array.isArray(entry.coveredFiles) || entry.coveredFiles.length === 0) {
        problems.push(`${entry.path}: a carried result needs covered file hashes`);
      }
      for (const covered of entry.coveredFiles ?? []) {
        const current = finalFileHash(inventory, worktree, covered?.path);
        if (!covered?.path || !/^[a-f0-9]{64}$/i.test(covered?.sha256 ?? "")) problems.push(`${entry.path}: carried file hash is invalid`);
        else if (current !== covered.sha256) problems.push(`${covered.path}: covered file hash changed before ${commit}`);
      }
    }
    const passed = runs.some((run) => run?.path === entry.path && run.status === "passed" && run.commit === resultCommit
      && run.command === entry.command && Array.isArray(run.cases) && entry.cases.every((name) => run.cases.includes(name)));
    if (!passed) problems.push(`${entry.path}: no passing targeted run with its exact cases and command on ${resultCommit}`);
  }
  const selected = new Set((runsFile?.testSelection ?? []).flatMap((entry) => Array.isArray(entry?.tests) ? entry.tests : []));
  const inventoried = new Set(entries.map((entry) => entry?.path));
  for (const test of [...selected].filter(Boolean).filter((test) => !inventoried.has(test))) {
    problems.push(`${test}: selected test is absent from the targeted inventory`);
  }
  if (!Array.isArray(runsFile?.rerunCycles)) problems.push("rerunCycles must record isolated reruns, or [] when none failed");
  for (const cycle of runsFile?.rerunCycles ?? []) {
    const failed = new Set(cycle?.failed ?? []);
    const allowed = new Set([...(cycle?.failed ?? []), ...(cycle?.newlyReached ?? [])]);
    const rerun = new Set(cycle?.rerun ?? []);
    if (!cycle?.fromCommit || !cycle?.toCommit || failed.size === 0) problems.push("each rerun cycle needs its source SHA, fixed SHA and failed cases");
    if (rerun.size !== allowed.size || [...rerun].some((item) => !allowed.has(item))) problems.push("a rerun cycle may contain only its failed cases and targets newly reached by the fix");
  }
  return problems;
}

function finalFileHash(inventory, worktree, file) {
  if (!file) return undefined;
  if (worktree) {
    try { return createHash("sha256").update(readFileSync(path.join(worktree, file))).digest("hex"); }
    catch { return undefined; }
  }
  return inventory.fileHashes?.[file];
}

function readTemplate(worktree, base) {
  for (const file of TEMPLATE_PATHS) {
    try {
      return git(worktree, ["show", `${base}:${file}`]);
    } catch {
      // Not at this path; try the next one.
    }
  }
  return "";
}
