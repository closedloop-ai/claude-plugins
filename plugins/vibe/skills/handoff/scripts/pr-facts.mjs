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
import { isDesktopE2eLane, NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { isE2ePath, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { REQUIRED_CONTAINER_IDENTITY, specExecutionLimitation, tierEvidenceProblems } from "./e2e-tier.mjs";
import { probeE2eCapability } from "./e2e-capability-probe.mjs";
import { prEvidenceShapeProblems, readTestSelection, TEST_SELECTORS } from "./pr-evidence-schema.mjs";

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
const SHA = /^[a-f0-9]{40}$/;
export const KNOWN_MAIN_FAILURES = "Known main failures";
const CI_CHECK_PATH = /^(?:\.github\/(?:workflows|actions)\/|scripts\/)|(?:^|\/)(?:package\.json|turbo\.json|biome\.jsonc?)$|(?:^|\/)(?:lint|checks?|gates?)\//;
// The producer jobs checked on symphony-alpha main. A spec left for CI must
// name the actual owner, not an invented local PASS or a generic "CI".
const E2E_CI_OWNER = Object.freeze({
  web: "e2e-test.yml:e2e",
  desktop: "desktop-e2e-validation.yml:desktop-e2e/validated",
});

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
    .filter((pr) => pr.headRefName !== ownBranch && !pr.unavailableReason)
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

/**
 * A run that failed the same way on the main the session captured: the
 * session did not cause it, so it never stops the pull request, and the body
 * lists it under Known main failures (ISS-13321). `mainSha` is the captured
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
function e2eLeftForCi(runsFile, changed, commit) {
  const specs = changed.filter((file) => isE2ePath(file) && TEST_SPEC_PATTERN.test(file));
  const selection = readTestSelection(runsFile);
  return specs.length > 0 && selection.problems.length === 0
    && specs.every((spec) => e2eCarriedForCi(runsFile, selection.entries, spec, commit));
}

/** Every required lane finished and passed on the published commit. */
export function evidenceProblems(runsFile, changed, commit) {
  if (!Array.isArray(runsFile?.touchFlows) || (runsFile.touchFlows.length === 0 && !runsFile.touchFlowsReason)) {
    return ["list every touched card, narrow or touch flow in touchFlows, or [] with a touchFlowsReason"];
  }
  return requiredLanes(changed, runsFile.touchFlows).filter((lane) => !(lane === "e2e" && e2eLeftForCi(runsFile, changed, commit))).flatMap((lane) => {
    const runs = (runsFile.runs ?? []).filter((run) => run.lane === lane);
    const impactKey = runsFile?.qaImpact?.laneKey;
    if (runs.length === 0) return [`${lane}: no run recorded`];
    return runs.flatMap((run) => [
      ...(passedOrMainPreexisting(run) ? [] : [`${lane}: ${run.status ?? "no status"}; a pull request never opens on an unfinished or failed run`]),
      ...(run.command && run.outcome ? [] : [`${lane}: command or visible outcome missing`]),
      ...(impactKey && run.laneKey !== impactKey ? [`${lane}: changed-file scope ${run.laneKey ?? "missing"} does not match ${impactKey}`] : []),
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
    ...(facts.overlapUnavailable ?? []).filter(({ number, reason }) => !body.includes(`Overlap unavailable: #${number} (${reason})`))
      .map(({ number, reason }) => `Overlap unavailable: #${number} (${reason}) must be stated; no overlap conclusion is possible`),
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

/** Every open PR's complete file list; GitHub's diff endpoint caps large patches at 300 files. */
export function loadOpenPrs() {
  const prs = JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "number,title,headRefName,files"]));
  return prs.map(({ files, ...pr }) => {
    if (files.length < GH_LIST_FILE_CAP) return { ...pr, files: files.map((file) => file.path) };
    const endpoint = `repos/${REPO}/pulls/${pr.number}`;
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
  probeCapability = ({ worktree: root, commit: sha }) => {
    if (git(root, ["rev-parse", "HEAD"]) !== sha) throw new Error("HEAD moved before the capability probe");
    return probeE2eCapability({ worktree: root, commit: sha });
  } }) {
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
    overlapUnavailable: prs ? prs.filter((pr) => pr.headRefName !== ownBranch && pr.unavailableReason)
      .map(({ number, title, unavailableReason: reason }) => ({ number, title, reason })) : [],
  };
  return {
    ...facts,
    ...(body === undefined ? {} : { prBodyProblems: [
      ...bodyProblems(body, facts, files, prBase, template ?? readTemplate(worktree, base)),
      ...(runs === undefined ? [] : knownMainFailureProblems(body, runs)),
    ] }),
    ...(runs === undefined ? {} : { prEvidenceProblems: [
      ...evidenceProblems(runs, changed, commit),
      ...selectionProblems(runs, files, requiredTests, commit),
      ...targetedEvidenceProblems(runs, commit, worktree),
      ...capabilityProbeProblems(runs, worktree, commit, probeCapability),
      ...ciCheckProblems(runs, changed, commit),
      ...tierEvidenceProblems(runs.e2eCapability, (Array.isArray(runs.targetedInventory?.entries) ? runs.targetedInventory.entries : []).filter((entry) => entry?.kind === "e2e").map((entry) => entry.path)),
    ] }),
  };
}

/**
 * Confirm the verifier's CI carry still matches this machine's read-only
 * runtime probe. A fabricated "no Docker" report cannot waive E2E merely by
 * selecting no tier; a changed prerequisite requires fresh evidence.
 */
export function capabilityProbeProblems(evidence, worktree, commit, probeCapability) {
  const carried = (Array.isArray(evidence?.testRuns) ? evidence.testRuns : [])
    .filter((run) => run?.status === "not-run" && typeof run.path === "string" && isE2ePath(run.path));
  if (carried.length === 0) return [];
  const recorded = evidence?.e2eCapability;
  if (!commit || recorded?.probedCommit !== commit) return ["E2E capability probe is not bound to the final committed HEAD"];
  let current;
  try { current = probeCapability({ worktree, commit }); }
  catch { return ["current E2E capability probe could not be verified; do not carry specs to CI"]; }
  if (!current?.container || !current.desktopHarness || current.probedCommit !== commit) {
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
  for (const key of REQUIRED_CONTAINER_IDENTITY) {
    if (named.secretsSet?.[key] !== current.container.secretsSet[key]) {
      return ["E2E identity-key presence differs from the current machine; rerun the read-only capability probe"];
    }
  }
  if (carried.some((run) => run.path.startsWith("apps/desktop/"))
    && (recorded.desktopHarness?.available !== current.desktopHarness.available
      || recorded.desktopHarness?.reason !== current.desktopHarness.reason
      || recorded.desktopHarness?.probe !== current.desktopHarness.probe)) {
    return ["Desktop displayless probe differs from the current machine; rerun the read-only capability probe"];
  }
  return [];
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
  const { entries: selection, problems: shapeProblems } = readTestSelection(runsFile);
  const listed = (entry) => Array.isArray(entry?.tests) && entry.tests.every((test) => typeof test === "string");
  const problems = [...shapeProblems];
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
    if (!passed(test) && !e2eCarriedForCi(runsFile, selection, test, commit)) {
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
 * Desktop additionally needs the matching not-run lane from test:lanes.
 */
function e2eCarriedForCi(evidence, selection, spec, commit) {
  if (!commit || !isE2ePath(spec) || !TEST_SPEC_PATTERN.test(spec)) return false;
  const capability = evidence?.e2eCapability;
  if (!capability || !Array.isArray(capability.unavailableSpecs) || !capability.unavailableSpecs.includes(spec)) return false;
  const limitation = specExecutionLimitation(capability, spec, commit);
  if (!limitation) return false;
  if (!selection.some((entry) => entry.selector === "e2e-reference" && Array.isArray(entry.tests) && entry.tests.includes(spec))) return false;
  const desktop = spec.startsWith("apps/desktop/");
  const reason = desktop ? NOT_RUN_NO_DESKTOP_HARNESS : NOT_RUN_NO_IDENTITY;
  const ciOwner = desktop ? E2E_CI_OWNER.desktop : E2E_CI_OWNER.web;
  if (!Array.isArray(capability.ciCoverage) || !capability.ciCoverage.includes(ciOwner)
    || evidence?.targetedInventory?.laneReport?.command !== "pnpm test:lanes") return false;
  const runs = Array.isArray(evidence.testRuns) ? evidence.testRuns : [];
  const own = runs.some((run) => run?.path === spec && run.status === "not-run" && run.commit === commit
    && run.reason === reason && run.ciOwner === ciOwner && run.selectionSource === "e2e-reference"
    && run.laneReportSource === "pnpm test:lanes" && (limitation.tier === null
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
export function targetedEvidenceProblems(runsFile, commit, worktree) {
  const inventory = runsFile?.targetedInventory;
  if (!inventory || typeof inventory !== "object") return ["targeted inventory of the final committed diff is missing"];
  const { entries: selection } = readTestSelection(runsFile);
  const problems = [...prEvidenceShapeProblems(runsFile)];
  const impactKey = runsFile?.qaImpact?.laneKey ?? inventory.impactKey;
  if (inventory.actor !== "read-only") problems.push("targeted inventory must come from a read-only subagent");
  if (inventory.source !== "final-committed-diff") problems.push("targeted inventory must read the final committed diff, not the plan");
  if (runsFile?.qaImpact && (!/^[a-f0-9]{16}$/.test(impactKey ?? "") || inventory.impactKey !== impactKey)) {
    problems.push("targeted inventory does not name qa-impact.mjs changed-file scope");
  }
  if (inventory.laneReport?.command !== "pnpm test:lanes") problems.push("targeted inventory must use pnpm test:lanes as the repository lane source");
  if (!Array.isArray(inventory.laneReport?.matches)) problems.push("targeted inventory must list the post-merge lane matches from pnpm test:lanes");
  const runs = Array.isArray(runsFile?.testRuns) ? runsFile.testRuns : [];
  const laneMatches = Array.isArray(inventory.laneReport?.matches) ? inventory.laneReport.matches : [];
  for (const lane of laneMatches) {
    if (!lane?.name || !lane?.command) problems.push("each matching post-merge lane needs its repository name and exact command");
    else if (!(lane.mentionOnly === true && text(lane.notRunReason))
      && !runs.some((run) => run?.lane === lane.name && run.command === lane.command && (!impactKey || run.laneKey === impactKey)
        && (passedOrMainPreexisting(run) || desktopLeftForCi(run)))) {
      problems.push(`lane ${lane.name}: no passing run of its test:lanes command for changed-file scope ${impactKey ?? "missing"}; a hand-picked subset is not the lane (#9238)`);
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
      if (!e2eCarriedForCi(runsFile, selection, entry.path, commit)) {
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
 * `desktop-e2e/validated` run covers it (ISS-13321).
 */
function desktopLeftForCi(run) {
  return run?.status === "not-run" && isDesktopE2eLane(run.command ?? "") && text(run.reason);
}

/**
 * Every main-preexisting run is named in the body under Known main failures,
 * so the reviewer sees what the pull request did not cause (ISS-13321).
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

function text(value) {
  return typeof value === "string" && value.trim() !== "";
}
