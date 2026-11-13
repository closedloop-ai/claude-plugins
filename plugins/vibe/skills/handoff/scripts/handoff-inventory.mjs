#!/usr/bin/env node
// Inventory a vibe session's work for handoff (its redeploy commits and
// anything not committed yet, against its base on main) and run the
// mechanical guardrail checks. Prints one JSON object; exits 0 when every
// blocking check passes and 1 otherwise. Changes nothing.
//
// Files in the session record's `localFixes` (workarounds for symphony-alpha
// bugs that the setup worker filed as tickets) are not the person's work:
// they are listed under `localFixes` and left out of `changedFiles` and every
// guardrail check, and no redeploy or handoff commit includes them.
//
// A target repository declares its own allowed and forbidden paths in one
// committed root-level vibe-handoff-paths.json. It is read from the captured
// base commit, or a newer fetched origin default branch if that base predates
// the declaration, so a session cannot expand its own permissions.
// Shrink-only source-gate allowlist edits retain their existing exception.
//
// Target-specific docs rules belong in that repository's declaration.
//
// Root web and Desktop test specs are admitted only in the pull-request phase.
//
// In the build and handoff phases a test file may only be repaired: an
// existing test or fixture modified so the tree compiles after the session's
// own change, never added, deleted or a snapshot updated. Repairs are listed
// under `testRepairs` for the guardrails reviewer, which checks that no
// assertion changed. The one deletion allowed there is a test file that covered
// only code the request retires, recorded with ../../vibe/scripts/retired-tests.mjs;
// every recorded deletion, file or case, is listed under `retiredTests` with
// its status so the reviewer can verify it and the ticket can list it.
//
// Story files are judged by the Storybook scheme the session's base uses
// (storybook-taxonomy.mjs), reported as `storybookScheme`. From symphony-alpha
// #8867 on (the lifecycle scheme) the v1.0 baseline is every story file titled
// under a `<Level> v1.0/` root or tagged `deprecated`, and new work goes under
// the plain current roots with one lifecycle tag; on an older base (the
// version scheme) it is the plain roots and the `v1.0` tag, and new work goes
// under `<Level> v2.0/`. A story file newly titled under or tagged for the
// v1.0 baseline is listed under `v1Stories` and blocks. A story file that was
// v1.0 at the base is frozen: any edit or move of it is listed under
// `v1Stories` with the reason `frozen` and blocks, so new states of its
// component go in a new entry under the current roots instead. The one
// exception is a compile-only repair (design ruling, 2026-10-15): an in-place edit that
// keeps the meta title, the meta tags and the set of exported story names, and
// so every story ID, is listed under `compileOnlyV1Repairs` and does not block;
// the ticket asks engineering to confirm it changed no visuals. Any other existing
// story file keeps its meta title, because Storybook builds story IDs from it:
// a title changed from the base, moves included, is listed under
// `retitledStories` and blocks unless the session record lists the file as a
// replacement's entry (`vibe-sessions.mjs story-replacement`). The base is the
// main the session last synced, so the retitles a main import brought (#8867
// renamed every root) are in the base and never counted as the session's. A
// base whose story-group-order.ts exports `StorybookLifecycle` in a shape
// storybook-taxonomy.mjs cannot read blocks a session that changed a story
// file (`storybookSchemeRecognized`) instead of guessing its rules.
//
// A story file whose meta title is under the `Start Here/` root, at the base
// or now, is exempt from the freeze, the v1.0 title and tag checks and the
// retitle check (design ruling, 2026-10-06): Start Here is unversioned, as
// symphony-alpha's .storybook/manager.ts treats it, and its Version History
// page is edited by every Storybook release, so a tag there is not a version.
//
// `diffRules` is diff-rules.mjs's result on the session's own changes (local
// fixes left out); any `diffRules.blocking` finding blocks
// (`blocking.diffRulesClear`). The build phase lists a `frozen-render` finding
// under `diffRules.deferredToHandoff` instead, because rendering every
// affected frozen story is heavy validation, which vibe's build loop leaves to
// handoff (vibe SKILL.md section 5); the handoff and pull-request phases block
// on it. A writer's DONE once waited hours on 49 such renders (2026-10-26).
//
// In the handoff and pull-request phases `bundle` is the summarizer's prebuilt
// evidence (inventory-bundle.mjs): backend paths by kind, guard predicates and
// flag reads on the changed lines, the session's flag keys, Storybook links to
// each changed story, and a worktree blast bundle per changed source file. It
// covers tracked changes, is additive, and reads `{ unavailable }` rather than
// failing the inventory.
//
// `backendChanged` says whether the work touched backend code
// (`backendFiles`). Handoff adds two workflow-code-review passes when it did;
// its test run stays targeted either way.
//
// The handoff and pull-request phases also report the pull request facts
// (pr-facts.mjs); `--ticket` adds `asks` (repeat it for a fleet unit's member tickets), `--overlap` adds `overlap` (one
// `gh pr list`, or `--prs-json`). In the pull-request phase `--body` adds
// `blocking.prBody` and `--runs` with `--commit` adds `blocking.prEvidence`.
// `--rulings` is the program's rulings file, read when the evidence cites a
// targeted-tests ruling recorded there (targeted-tests-ruling.mjs).
//
// Usage: handoff-inventory.mjs --worktree <path> [--phase build|handoff|pull-request]
//   [--ticket <file>] [--rulings <file>] [--overlap] [--prs-json <file>] [--body <file>] [--runs <file> --commit <sha>]

import { laneSourceBootstrap } from "./ci-job-shape.mjs";
import { laneSourceShapeProblems } from "./pr-evidence-schema.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BACKEND_PATH } from "../../vibe/scripts/area-paths.mjs";
import { committedLocalPlans, isLocalPlanPath, LOCAL_PLAN_PREFIX } from "../../vibe/scripts/local-plans.mjs";
import { isOwnedPrototypeSession, requirePrototypePublication } from "../../vibe/scripts/prototype-session.mjs";
import { readRetiredTests } from "../../vibe/scripts/retired-tests.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { readMainSyncProvenance } from "../../vibe/scripts/dist/main-sync.mjs";
import { isShrinkOnlyAllowlistEdit, SHRINK_ONLY_ALLOWLISTS } from "./allowlist-shrink.mjs";
import { unexplainedLockfileEntries } from "./lockfile-manifest.mjs";
import { classifyHandoffPath, PathDisposition } from "./path-classifier.mjs";
import { runDiffRules } from "./diff-rules.mjs";
import { buildInventoryBundle } from "./inventory-bundle.mjs";
import { isPortableSurfaceAllowlistEdit, PORTABLE_SURFACE_CHECKER } from "./prototype-allowlist.mjs";
import { loadOpenPrs, proofCorpusBase, pullRequestFacts } from "./pr-facts.mjs";
import {
  isUnversionedStory,
  keepsStoryIdentity,
  STORY_GROUP_ORDER_PATH,
  StorybookScheme,
  storybookSchemeOf,
  storyMetaTitle,
} from "./storybook-taxonomy.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { withStableSource } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BRANCH_PREFIX = "vibe/";

// The sole implementation writer owns frontend and backend changes (ISS-12135);
// an engineer reviews both before merge.
const PATH_POLICY_BASENAME = "vibe-handoff-paths.json";

const HANDOFF_ONLY_RULES = new Set(["frozen-render"]);
const STORY_PATTERN = /\.stories\.tsx?$/;
const COMPONENT_PATTERN = /\/components\/.+\.tsx$/;
const STORY_PATHSPECS = ["*.stories.ts", "*.stories.tsx"];
// Tests are admitted here when the person explicitly asks for a pull request;
// otherwise earlier phases may only repair existing
// tests and fixtures the session's change broke (operator ruling,
// 2026-10-13, after the PRD-720 live test) or delete a recorded retired-only
// test (operator ruling, 2026-10-13).
const PHASES = ["build", "handoff", "pull-request"];

const { values } = parseArgs({
  options: {
    worktree: { type: "string" },
    phase: { type: "string", default: "build" },
    ticket: { type: "string", multiple: true },
    rulings: { type: "string" },
    overlap: { type: "boolean" },
    "prs-json": { type: "string" },
    body: { type: "string" },
    runs: { type: "string" },
    commit: { type: "string" },
  },
});
if (!values.worktree) {
  fail("--worktree is required.");
}
if (!PHASES.includes(values.phase)) {
  fail("--phase must be build, handoff or pull-request.");
}
if ((values.body || values.runs) && values.phase !== "pull-request") {
  fail("--body and --runs need --phase pull-request.");
}
const worktree = path.resolve(values.worktree);

const result = withStableSource(worktree, () => {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const record = readSessionRecord(worktree);
  let verifiedDefault;
  const prototype = isOwnedPrototypeSession(record, branch);
  if (!branch.startsWith(BRANCH_PREFIX) && !prototype) {
    fail(`${worktree} is on ${branch}, not a vibe branch (${BRANCH_PREFIX}*).`);
  }

  let publicationProblem;
  if (prototype) {
    try { requirePrototypePublication(record, git(["rev-parse", "HEAD"])); }
    catch (error) { publicationProblem = error.message; }
  }
  const localFixTickets = localFixTicketsByPath(record);
  const mainSync = record?.status === "active" && record?.operator ? readMainSyncProvenance(worktree) : undefined;
  let comparison;
  const baseCommit = proofCorpusBase(worktree, () => getComparison().operand);
  const { policy: pathPolicy, file: pathPolicyFile, problem: pathPolicyProblem,
    source: pathPolicySource } = readPathPolicy();
  const allChangedFiles = listChangedFiles(baseCommit);
  const localPlans = allChangedFiles.filter((file) => isLocalPlanPath(file.path));
  const trackedLocalPlans = [...new Set([
    ...git(["ls-files", "--", LOCAL_PLAN_PREFIX]).split("\n"),
    ...committedLocalPlans(git),
  ])].filter(Boolean);
  const changedFiles = allChangedFiles.filter((file) => !localFixTickets.has(file.path) && !isLocalPlanPath(file.path));
  const localFixes = allChangedFiles
    .filter((file) => localFixTickets.has(file.path))
    .map((file) => ({ ...file, ticket: localFixTickets.get(file.path) }));
  const retiredRecord = readRetiredTests(worktree);
  const retiredFiles = new Set(retiredRecord.filter((entry) => entry.case === undefined).map((entry) => entry.path));
  const changedStatus = new Map(changedFiles.map((file) => [file.path, file.status]));
  const retiredTests = retiredRecord.map((entry) => ({ ...entry, status: changedStatus.get(entry.path) ?? null }));
  const shrinkOnlyAllowlists = changedFiles.filter((file) => isShrinkOnlyEdit(file));
  const shrinkOnlyPaths = new Set(shrinkOnlyAllowlists.map((file) => file.path));
  const classifications = new Map(changedFiles.map((file) => [file.path, classifyPath(file)]));
  const testRepairs = changedFiles.filter((file) => classifications.get(file.path)?.reason === "test-repair");
  const lockfile = changedFiles.find((file) => file.path === "pnpm-lock.yaml");
  const unexplainedLockfile = lockfile
    ? unexplainedLockfileEntries({
      before: readBaseFile(lockfile.path) ?? null,
      after: readWorktreeFile(lockfile.path) ?? null,
      manifests: changedFiles.filter((file) => path.posix.basename(file.path) === "package.json" &&
        classifications.get(file.path)?.disposition === PathDisposition.Allowed).map((file) => ({
          file: file.path,
          before: readBaseFile(file.path) ?? null,
          after: readWorktreeFile(file.path) ?? null,
        })),
    }) : [];
  const explainedLockfile = lockfile && unexplainedLockfile.length === 0;
  const forbidden = changedFiles.filter((file) =>
    classifications.get(file.path)?.disposition === PathDisposition.Forbidden && !shrinkOnlyPaths.has(file.path));
  const outsideAllowed = changedFiles.filter(
    (file) => classifications.get(file.path)?.disposition === PathDisposition.Outside &&
      !shrinkOnlyPaths.has(file.path) && !(file === lockfile && explainedLockfile)
  );
  const backendFiles = changedFiles.filter((file) => isBackend(file.path));
  const componentsWithoutStories = findComponentsWithoutStories(changedFiles);
  const movedStories = findMovedStories();
  const storybookScheme = storybookSchemeOf(readBaseFile(STORY_GROUP_ORDER_PATH));
  const storybookSchemeUnreadable = storybookScheme.summary.name === StorybookScheme.Unrecognized &&
    changedFiles.some((file) => STORY_PATTERN.test(file.path));
  const { v1Stories, compileOnlyV1Repairs } = findV1Stories(changedFiles);
  const retitledStories = findRetitledStories(changedFiles);
  const diffRules = runDiffRules({ worktree, base: baseCommit, exclude: new Set(localFixTickets.keys()), isFrozenStory: isV1Story,
    storyReplacements: new Set((Array.isArray(record?.storyReplacements) ? record.storyReplacements : []).map((entry) => entry?.path)),
    phase: values.phase,
  });
  const prFacts = values.phase === "build" ? null : readPullRequestFacts();
  const deferredToHandoff = values.phase === "build" ? diffRules.blocking.filter((finding) => HANDOFF_ONLY_RULES.has(finding.rule)) : [];
  const diffRulesBlocking = diffRules.blocking.filter((finding) => !deferredToHandoff.includes(finding));

  const blocking = {
    forbiddenPaths: !pathPolicyProblem && forbidden.length === 0 && outsideAllowed.length === 0 && unexplainedLockfile.length === 0,
    hasChanges: changedFiles.length > 0,
    storiesInV2Taxonomy: v1Stories.length === 0,
    existingStoryTitlesKept: retitledStories.every((story) => story.replacement !== null),
    diffRulesClear: diffRulesBlocking.length === 0,
    ...(storybookSchemeUnreadable ? { storybookSchemeRecognized: false } : {}),
    ...(trackedLocalPlans.length ? { localPlansUntracked: false } : {}),
    ...(prototype ? { prototypePublicationCurrent: publicationProblem === undefined } : {}),
    ...(mainSync?.pendingMerge ? { mainSyncMergeCommitted: false } : {}),
    ...(prFacts?.prBodyProblems ? { prBody: prFacts.prBodyProblems.length === 0 } : {}),
    ...(prFacts?.prEvidenceProblems ? { prEvidence: prFacts.prEvidenceProblems.length === 0 } : {}),
  };

  const result = {
    ok: Object.values(blocking).every(Boolean),
    worktree,
    branch,
    ownedPrototype: prototype,
    sessionSlug: record?.slug ?? null,
    mode: record?.mode ?? null,
    liveTicket: record?.liveTicket ?? record?.handoffTicket ?? null,
    vercel: record?.vercel ?? null,
    ...(prototype ? { prototype: record.prototype } : {}),
    ...(publicationProblem ? { publicationProblem } : {}),
    baseCommit,
    pathPolicyFile,
    ...(pathPolicySource ? { pathPolicySource } : {}),
    ...(pathPolicyProblem ? { pathPolicyProblem } : {}),
    ...(mainSync ? { mainSync } : {}),
    ...(mainSync?.featureTestHistory.length ? { featureTestHistory: mainSync.featureTestHistory } : {}),
    blocking,
    changedFiles,
    localFixes,
    localPlans,
    trackedLocalPlans,
    forbidden,
    outsideAllowed,
    unexplainedLockfileEntries: unexplainedLockfile,
    shrinkOnlyAllowlists,
    testRepairs,
    retiredTests,
    backendChanged: backendFiles.length > 0,
    backendFiles,
    componentsWithoutStories,
    storybookScheme: storybookScheme.summary,
    v1Stories,
    compileOnlyV1Repairs,
    retitledStories,
    diffRules: { blocking: diffRulesBlocking, deferredToHandoff, requiredTests: diffRules.requiredTests, requiredChecks: diffRules.requiredChecks },
    ...(values.phase === "build" ? {} : { bundle: buildBundle() }),
    ...prFacts,
  };
  return result;
  function git(args, timeoutMs) {
    return execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function getComparison() {
    return comparison ??= comparisonBase();
  }

  function readPullRequestFacts() {
    let prs = null;
    let overlapError;
    if (values.overlap || values.body || values["prs-json"]) {
      try {
        prs = values["prs-json"] ? JSON.parse(readFileSync(values["prs-json"], "utf8")) : loadOpenPrs(worktree);
      } catch (error) {
        overlapError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
    }
    const facts = pullRequestFacts({
      worktree,
      base: baseCommit,
      include: new Set(changedFiles.map((file) => file.path)),
      prs,
      ownBranch: branch,
      prBase: getComparison().branch,
      ticketText: values.ticket?.length ? values.ticket.map((file) => readFileSync(file, "utf8")).join("\n") : undefined,
      rulingsText: values.rulings ? readFileSync(values.rulings, "utf8") : undefined,
      body: values.body ? readFileSync(values.body, "utf8") : undefined,
      runs: values.runs ? JSON.parse(readFileSync(values.runs, "utf8")) : undefined,
      commit: values.commit,
      requiredTests: diffRules.requiredTests,
    });
    return overlapError ? { ...facts, overlapError } : facts;
  }


  function listChangedFiles(base) {
    const files = new Map();
    const tracked = git(["diff", "--name-status", "--no-renames", base]);
    for (const line of tracked.split("\n").filter(Boolean)) {
      const [status, filePath] = line.split("\t");
      files.set(filePath, { path: filePath, status });
    }
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    for (const filePath of untracked.split("\n").filter(Boolean)) {
      files.set(filePath, { path: filePath, status: "A" });
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Use the captured base first, then a fetched newer default branch only for a missing declaration. */
  function readPathPolicy() {
    const required = `Declare exactly one committed ${PATH_POLICY_BASENAME} at the target repository root with version, allowedPrefixes, allowedFiles, forbiddenPrefixes, forbiddenBasenames and rootTests`;
    const base = readPathPolicyAt(baseCommit, "base", required);
    if (!base.missing) return base;
    let defaultCommit;
    let defaultBranch;
    try {
      const advertised = advertisedRemoteDefault();
      defaultBranch = advertised.branch;
      defaultCommit = advertised.commit;
      git(["merge-base", "--is-ancestor", baseCommit, defaultCommit]);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return { policy: null, file: null, source: null,
        problem: `${required}; absent in base ${baseCommit} and no verified fetched descendant ${defaultBranch ? `origin/${defaultBranch}` : "remote HEAD"} is available: ${reason}.` };
    }
    const current = readPathPolicyAt(defaultCommit, "origin-default", required);
    if (!current.missing) return current;
    return { policy: null, file: null, source: null,
      problem: `${required}; absent in base ${baseCommit} and fetched origin/${defaultBranch} at ${defaultCommit}.` };
  }

  /** Distinguish an absent declaration from a malformed one at one immutable commit. */
  function readPathPolicyAt(commit, kind, required) {
    const files = git(["ls-tree", "-rz", "--name-only", commit]).split("\0")
      .filter((file) => path.posix.basename(file) === PATH_POLICY_BASENAME);
    if (files.length === 0) return { policy: null, file: null, problem: null, source: null, missing: true };
    if (files.length !== 1) {
      return { policy: null, file: null, source: { kind, commit },
        problem: `${required}; found ${files.length} in ${kind} ${commit}.` };
    }
    const file = files[0];
    if (file !== PATH_POLICY_BASENAME) {
      return { policy: null, file, source: { kind, commit },
        problem: `${required}; found ${file} in ${kind} ${commit}, but the declaration must be at repository root (${PATH_POLICY_BASENAME}).` };
    }
    try {
      const policy = JSON.parse(git(["show", `${commit}:${file}`]));
      const problem = pathPolicyProblemFor(policy);
      return problem ? { policy: null, file, source: { kind, commit }, problem: `${file}: ${problem}. ${required}.` }
        : { policy, file, source: { kind, commit }, problem: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return { policy: null, file, source: { kind, commit }, problem: `${file}: ${reason}. ${required}.` };
    }
  }

  /** Reject partial or permissive policy shapes before any path classification. */
  function pathPolicyProblemFor(policy) {
    const keys = ["version", "allowedPrefixes", "allowedFiles", "forbiddenPrefixes", "forbiddenBasenames", "rootTests"];
    if (policy?.laneSource !== undefined) keys.push("laneSource");
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).sort().join("|") !== keys.sort().join("|")) {
      return `expected fields ${keys.join(", ")}`;
    }
    if (policy.laneSource !== undefined && laneSourceShapeProblems(policy.laneSource).length) return "invalid typed laneSource";
    if (policy.version !== 1 || typeof policy.rootTests !== "boolean") {
      return "version must be 1 and rootTests must be a boolean";
    }
    for (const field of ["allowedPrefixes", "allowedFiles", "forbiddenPrefixes", "forbiddenBasenames"]) {
      if (!Array.isArray(policy[field]) || !policy[field].every((entry) => safePolicyPath(entry,
        field.endsWith("Prefixes") ? "prefix" : field === "forbiddenBasenames" ? "basename" : "file"))) {
        return `${field} must contain literal repository-relative paths`;
      }
    }
    if (policy.allowedPrefixes.length + policy.allowedFiles.length === 0) {
      return "declare at least one allowed prefix or file";
    }
    return null;
  }

  /** Accept literal relative paths only, with no glob or traversal grammar. */
  function safePolicyPath(value, kind) {
    if (typeof value !== "string" || !value || value.startsWith("/") || /[\\\0*?\[\]]/.test(value)) return false;
    if ((kind === "prefix") !== value.endsWith("/")) return false;
    if (kind === "basename" && value.includes("/")) return false;
    const segments = value.replace(/\/$/, "").split("/");
    return segments.every((segment) => segment && segment !== "." && segment !== "..");
  }

  /** A modified shrink-only allowlist whose working-tree copy only shrinks the base copy. */
  function isShrinkOnlyEdit(file) {
    if (file.status !== "M" || !SHRINK_ONLY_ALLOWLISTS.has(file.path)) {
      return false;
    }
    const absolute = path.join(worktree, file.path);
    if (!existsSync(absolute)) {
      return false;
    }
    let baseText;
    try {
      baseText = git(["show", `${baseCommit}:${file.path}`]);
    } catch {
      return false;
    }
    return isShrinkOnlyAllowlistEdit(baseText, readFileSync(absolute, "utf8"));
  }

  function classifyPath(file) {
    if (file.path === PATH_POLICY_BASENAME && file.status === "M") {
      try {
        const target = advertisedRemoteDefault({ fresh: true, branch: getComparison().branch });
        if (laneSourceBootstrap(worktree, baseCommit, target.commit)) return { disposition: PathDisposition.Allowed, reason: "lane-source-bootstrap" };
      } catch { /* Unverified target never authorizes a protected declaration edit. */ }
    }
    return classifyHandoffPath({
      file,
      phase: values.phase,
      policy: pathPolicy,
      prototype: { owned: prototype, slug: record?.slug },
      portableSurfaceAllowed: portableSurfaceEditAllowed(file),
      retiredDeletion: isRetiredDeletion(file),
    });
  }

  function portableSurfaceEditAllowed(file) {
    const filePath = file.path;
    if (prototype && filePath === PORTABLE_SURFACE_CHECKER) {
      try {
        return isPortableSurfaceAllowlistEdit(
          git(["show", `${baseCommit}:${filePath}`]),
          readFileSync(path.join(worktree, filePath), "utf8"),
          (specifier) => [".ts", ".tsx", ".mjs"].some((extension) =>
            existsSync(path.join(worktree, "packages/app", `${specifier.slice("@repo/app/".length)}${extension}`)))
        );
      } catch { return false; }
    }
    return false;
  }

  /** A deleted test file the writer recorded as covering only code the request retires. */
  function isRetiredDeletion(file) {
    return file.status === "D" && retiredFiles.has(file.path);
  }

  function findComponentsWithoutStories(files) {
    const changedPaths = new Set(files.map((file) => file.path));
    return files
      .filter(
        (file) =>
          file.status !== "D" &&
          COMPONENT_PATTERN.test(`/${file.path}`) &&
          !STORY_PATTERN.test(file.path) &&
          !isTestFile(file.path)
      )
      .filter((file) => {
        const story = file.path.replace(/\.tsx$/, ".stories.tsx");
        return !changedPaths.has(story) && !existsSync(path.join(worktree, story));
      })
      .map((file) => file.path);
  }

  function comparisonBase() {
    let bootstrap = false;
    try {
      const after = JSON.parse(readFileSync(path.join(worktree, PATH_POLICY_BASENAME), "utf8"));
      if (after.laneSource?.kind === "github-workflow" && /^[a-f0-9]{40}$/.test(record.baseCommit ?? "")) {
        const before = JSON.parse(git(["show", `${record.baseCommit}:${PATH_POLICY_BASENAME}`]));
        bootstrap = !Object.hasOwn(before, "laneSource");
      }
    } catch { /* Normal repositories keep their existing comparison path. */ }
    let configured;
    try { configured = git(["config", "--get", "vibe.baseRef"]); } catch {}
    if (configured && !bootstrap) return { branch: configured, operand: `origin/${configured}` };
    try {
      const advertised = advertisedRemoteDefault({ fresh: bootstrap, branch: configured });
      return { branch: advertised.branch, operand: advertised.commit };
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      fail(`Cannot verify the target repository's remote default branch for ${PATH_POLICY_BASENAME}: ${reason}. Fetch origin or set vibe.baseRef for comparison.`);
    }
  }

  /** Reuse the comparison owner; metadata migration additionally fetches and rechecks the exact merge target. */
  function advertisedRemoteDefault({ fresh = false, branch: chosen } = {}) {
    if (verifiedDefault && (!chosen || chosen === verifiedDefault.branch) && (!fresh || verifiedDefault.freshlyFetched)) return verifiedDefault;
    if (chosen) git(["check-ref-format", "--branch", chosen]);
    const advertised = () => {
      const lines = git(["ls-remote", "--symref", "origin", chosen ? `refs/heads/${chosen}` : "HEAD"], 15_000).split("\n");
      const branch = chosen ?? lines.map(line => /^ref: refs\/heads\/([^\s]+)\tHEAD$/.exec(line)).find(Boolean)?.[1];
      const ref = chosen ? `refs/heads/${chosen}` : "HEAD";
      const commit = lines.map(line => line.split("\t")).find(([sha, name]) => /^[a-f0-9]{40,64}$/.test(sha) && name === ref)?.[0];
      if (!branch || !commit) throw new Error("origin did not advertise the merge target branch and commit");
      git(["check-ref-format", "--branch", branch]);
      return { branch, commit };
    };
    const target = advertised();
    if (fresh) git(["fetch", "--no-tags", "origin", `refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`], 30_000);
    const fetched = git(["rev-parse", `refs/remotes/origin/${target.branch}`]);
    if (fetched !== target.commit || fresh && JSON.stringify(advertised()) !== JSON.stringify(target)) {
      throw new Error(`fetched origin/${target.branch} does not match the remote's advertised HEAD; fetch origin first`);
    }
    verifiedDefault = { ...target, freshlyFetched: fresh };
    return verifiedDefault;
  }

  function localFixTicketsByPath(sessionRecord) {
    const tickets = new Map();
    const fixes = Array.isArray(sessionRecord?.localFixes) ? sessionRecord.localFixes : [];
    for (const fix of fixes) {
      for (const filePath of Array.isArray(fix?.paths) ? fix.paths : []) {
        if (typeof filePath === "string" && !tickets.has(filePath)) {
          tickets.set(filePath, typeof fix.ticket === "string" ? fix.ticket : null);
        }
      }
    }
    return tickets;
  }

  function isBackend(filePath) {
    return BACKEND_PATH.test(filePath);
  }

  /**
   * `v1Stories`: story files whose meta title sits in a v1.0 root or whose tags
   * mark the v1.0 baseline, by the base's scheme, where the base had neither,
   * and every modified or moved story file that was v1.0 at the base
   * (`frozen`), except under the unversioned Start Here root. `compileOnlyV1Repairs`: the in-place edits of a v1.0 file
   * that keep its story IDs and tags.
   */
  function findV1Stories(files) {
    const movedFrom = new Map(movedStories.map((story) => [story.path, story.from]));
    const v1 = [];
    const compileOnly = [];
    for (const file of files) {
      if (file.status === "D" || !STORY_PATTERN.test(file.path)) {
        continue;
      }
      const source = readWorktreeFile(file.path);
      if (source === undefined) {
        continue;
      }
      const from = movedFrom.get(file.path);
      const basePath = file.status === "M" ? file.path : from;
      const base = basePath === undefined ? undefined : readBaseFile(basePath);
      if (isUnversionedStory(base) || isUnversionedStory(source)) {
        continue;
      }
      const gained = (isV1) => isV1(source) && !(base !== undefined && isV1(base));
      const reasons = [
        ...(gained(storybookScheme.frozenTitle) ? ["title"] : []),
        ...(gained(storybookScheme.frozenTag) ? ["tag"] : []),
        ...(base !== undefined && isV1Story(base) ? ["frozen"] : []),
      ];
      if (reasons.length === 1 && reasons[0] === "frozen" && file.status === "M" && keepsStoryIdentity(base, source)) {
        compileOnly.push(file);
      } else if (reasons.length) {
        v1.push({ ...file, ...(from === undefined ? {} : { from }), reasons });
      }
    }
    return { v1Stories: v1, compileOnlyV1Repairs: compileOnly };
  }

  function isV1Story(source) {
    return storybookScheme.frozenTitle(source) || storybookScheme.frozenTag(source);
  }

  /**
   * Story files present at the base whose meta title changed, in place or moved
   * to another path, each with the replacement it was recorded for or null.
   * Start Here is unversioned, so a retitle into, out of or within it is not listed.
   */
  function findRetitledStories(files) {
    const modified = files
      .filter((file) => file.status === "M" && STORY_PATTERN.test(file.path))
      .map((file) => ({ path: file.path, from: file.path }));
    const replacements = new Map(
      (Array.isArray(record?.storyReplacements) ? record.storyReplacements : [])
        .filter((entry) => typeof entry?.path === "string")
        .map((entry) => [entry.path, entry.replacement ?? null])
    );
    return [...modified, ...movedStories].flatMap(({ path: filePath, from }) => {
      const source = readWorktreeFile(filePath);
      const base = readBaseFile(from);
      if (source === undefined || base === undefined || isUnversionedStory(base) || isUnversionedStory(source)) {
        return [];
      }
      const baseTitle = storyMetaTitle(base);
      const title = storyMetaTitle(source);
      if (baseTitle === title) {
        return [];
      }
      return [{
        path: filePath,
        ...(from === filePath ? {} : { from }),
        baseTitle,
        title,
        replacement: replacements.get(filePath) ?? replacements.get(from) ?? null,
      }];
    });
  }

  /** Story files git sees as renamed since the base, tracked changes only. */
  function findMovedStories() {
    const renames = git(["diff", "--name-status", "-M", "--diff-filter=R", baseCommit, "--", ...STORY_PATHSPECS]);
    return renames.split("\n").filter(Boolean).map((line) => {
      const [, from, to] = line.split("\t");
      return { path: to, from };
    });
  }

  function readWorktreeFile(filePath) {
    const absolute = path.join(worktree, filePath);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  }

  function readBaseFile(filePath) {
    try {
      return git(["show", `${baseCommit}:${filePath}`]);
    } catch {
      return undefined;
    }
  }

  /** The summarizer's prebuilt evidence (inventory-bundle.mjs) over the session's tracked changes; never fails the inventory. */
  function buildBundle() {
    const excluded = [...localFixTickets.keys()].map((file) => `:(exclude)${file}`);
    return buildInventoryBundle({
      worktree,
      diffText: git(["diff", "--no-color", "--unified=0", "-M", baseCommit, "--", ".", ":(exclude).closedloop-ai/vibe-plans", ...excluded]),
      backendFiles: backendFiles.map((file) => file.path),
      record,
      readHead: readWorktreeFile,
    });
  }
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}
