import assert from "node:assert/strict";
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, mutationPreload, runNode, SYMPHONY_PATH_POLICY } from "../../vibe/scripts/test-fixtures.mjs";
import { seedAlignedDecisionTable, writeCheckoutFile as write } from "../../vibe/scripts/test-fixtures.mjs";
import { moveCriterion, resolveFrozenStoryMoves, ticketMoveCriteria } from "./frozen-story-moves.mjs";
import { storybookSchemeOf } from "./storybook-taxonomy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const RETIRED = path.join(HERE, "..", "..", "vibe", "scripts", "retired-tests.mjs");
const ALLOWLIST = "scripts/lint/source-gate-allowlist.json";
const FOCUS_RING = { rule: "no-hand-rolled-focus-ring", file: "packages/app/a.tsx", fingerprint: "packages/app/a.tsx", count: 1, reason: "seeded" };
const HEX = { rule: "no-hex-color-in-jsx-styling", file: "apps/app/b.tsx", fingerprint: "apps/app/b.tsx", count: 3, reason: "seeded" };
const allowlist = (entries) =>
  `${JSON.stringify({ registeredRules: ["no-hand-rolled-focus-ring", "no-hex-color-in-jsx-styling"], entries }, null, 2)}\n`;

function setup(t, slug, extraFiles = {}, { repoName = "symphony-alpha", remoteUrl, declared = true } = {}) {
  const fixture = makeHome("handoff-inventory-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", repoName);
  const { origin } = makeCheckout({
    root: fixture.root,
    home: fixture.home,
    checkout,
    files: {
      "scripts/loops-setup.sh": "echo old\n",
      ".github/workflows/ci.yml": "on: push\n",
      "apps/app/page.tsx": "export const page = 1;\n",
      "apps/web/content/docs/concepts/bulk-actions.mdx": "Bulk actions.\n",
      "apps/web/content/docs/api-reference/projects/listProjects.mdx": "generated\n",
      "apps/web/content/docs/meta.json": "{\"pages\":[]}\n",
      "docs/runbooks/bulk-actions.md": "Runbook.\n",
      [ALLOWLIST]: allowlist([FOCUS_RING, HEX]),
      ...(declared ? { "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY } : {}),
      ...extraFiles,
    },
    ...(remoteUrl ? { remoteUrl } : {}),
  });
  const created = runNode(
    SESSIONS,
    ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  seedAlignedDecisionTable(created.json.session.worktree);
  return { ...fixture, checkout, origin, worktree: created.json.session.worktree };
}

function useMasterDefault({ home, checkout, origin, worktree }) {
  git(checkout, ["branch", "-m", "master"], home);
  git(checkout, ["push", "origin", "master"], home);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/master"], home);
  git(checkout, ["push", "origin", "--delete", "main"], home);
  git(worktree, ["fetch", "--prune", "origin"], home);
  git(worktree, ["remote", "set-head", "origin", "-a"], home);
}

const PATH_POLICY = "vibe-handoff-paths.json";
test("AC-14 admits a cited root manifest and requires its exact disclosure in the PR body", (t) => {
  const { home, worktree } = setup(t, "cited-manifest", { "package.json": "{}\n" });
  const scripts = path.resolve(HERE, "../../vibe/scripts");
  const ticket = "ISS-123";
  const criterion = "Update the root `package.json` scripts.";
  const body = "## Acceptance criteria\n- [ ] " + criterion + "\n";
  assert.equal(runNode(SESSIONS, ["touch", "--worktree", worktree, "--live-ticket", ticket], home).status, 0);
  const evidence = runNode(path.join(scripts, "session-plan.mjs"), ["paths", "--worktree", worktree], home).json;
  mkdirSync(evidence.root, { recursive: true });
  const document = evidence.liveTicketDocument;
  const saveRead = (slug, content) => {
    writeFileSync(document, JSON.stringify({ slug, latestVersion: 2, version: { version: 2, content } }));
    writeFileSync(evidence.liveTicket, content);
  };
  saveRead(ticket, body);
  write(worktree, "package.json", '{"scripts":{}}\n');
  const inventory = (...args) => runNode(INVENTORY, ["--phase", "pull-request", "--worktree", worktree, ...args], home).json;
  const rejected = () => assert.deepEqual(inventory().outsideAllowed.map(file => file.path), ["package.json"]);
  rejected();
  const input = path.join(home, "card.json");
  const cite = { path: "package.json", cites: "AC-1" };
  const card = { version: 1, criteria: [{ id: "AC-1", text: criterion, source: ticket, evidence: "test" }],
    plan: { summary: "Deliver root scripts", ownerFiles: ["package.json"], justifications: [cite] } };
  writeFileSync(input, JSON.stringify(card));
  assert.equal(runNode(path.join(scripts, "spec-card.mjs"), ["save", "--stage", "locked", "--worktree", worktree, input], home).status, 0);
  const accepted = inventory();
  assert.deepEqual(accepted.outsideAllowed, []);
  assert.equal(accepted.blocking.forbiddenPaths, true);
  const [entry] = accepted.pathCitations;
  assert.deepEqual([entry.ticket, entry.criterion, entry.path], [ticket, "AC-1", "package.json"]);
  const prs = path.join(home, "prs.json");
  writeFileSync(prs, "[]");
  writeFileSync(evidence.prBody, "Change package scripts.\n");
  const check = () => inventory("--body", evidence.prBody, "--prs-json", prs).prBodyProblems;
  assert.ok(check().some(problem => problem.includes(entry.disclosure)));
  writeFileSync(evidence.prBody, "<!--\n" + entry.disclosure + "\n-->\n");
  assert.ok(check().some(problem => problem.includes(entry.disclosure)));
  writeFileSync(evidence.prBody, entry.disclosure + "\n");
  assert.ok(!check().some(problem => problem.includes(entry.disclosure)));
  saveRead("ISS-124", body);
  rejected();
  saveRead(ticket, "## Acceptance criteria\n- [ ] A different criterion.\n");
  rejected();
  saveRead(ticket, "## Acceptance criteria\nNo criteria yet.\n");
  rejected();
  const citePath = (file, id) => runNode(SESSIONS, ["touch", "--worktree", worktree, "--cite-path", file, "--criterion", id], home);
  const intake = (...paths) => runNode(path.join(scripts, "dist/scope-intake.mjs"), [
    "--worktree", worktree, "--phase", "pull-request", ...paths.flatMap(file => ["--path", file]),
  ], home).json;
  assert.equal(citePath("package.json", "AC-5").status, 1);
  saveRead(ticket, "## Acceptance criteria\n1. Edit package.json.\n1. Edit a different file.\n");
  assert.equal(citePath("package.json", "AC-1").status, 1);
  saveRead(ticket, "## Acceptance criteria\n<!--\n1. Edit package.json.\n-->\n");
  assert.equal(citePath("package.json", "AC-1").status, 1);
  for (const text of ["Use apps/package.json", "Use package.json.bak", "Use *.json",
    "Use package.json*", "Use pnpm docker:ensure", "Use <package.json> as a placeholder"]) {
    saveRead(ticket, "## Acceptance criteria\n1. " + text + "\n");
    assert.equal(citePath("package.json", "AC-1").status, 1, text);
  }
  saveRead(ticket, "## Acceptance criteria\n1. Publish scripts from package.json.\n2. Edit AGENTS.md.\n");
  assert.equal(citePath("package.json", "AC-1").status, 0);
  assert.equal(citePath("AGENTS.md", "AC-2").status, 0);
  const planned = intake("package.json", "AGENTS.md", "apps/app/page.tsx", "untouched.txt");
  assert.deepEqual(planned.allowed, ["apps/app/page.tsx", "package.json"]);
  assert.deepEqual(planned.forbidden, ["AGENTS.md"]);
  assert.deepEqual(planned.outsideAllowed, ["untouched.txt"]);
  const sessionCitation = inventory().pathCitations[0];
  assert.equal(sessionCitation.source, "session");
  assert.equal(sessionCitation.text, "Publish scripts from package.json.");
  writeFileSync(evidence.liveTicket, "## Acceptance criteria\n1. Use different scripts.\n");
  rejected();
});

const CLAUDE_PLUGIN_POLICY = readFileSync(path.resolve(HERE, "../../../../..", PATH_POLICY), "utf8");

test("AC-019 build inventory reports when the table cannot advance to handoff", (t) => {
  const { home, worktree } = setup(t, "stale-table");
  const table = seedAlignedDecisionTable(worktree);
  const verified = readFileSync(table, "utf8");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  writeFileSync(table, verified.replace("- Checked the fixture behavior.", "(post-implementation)"));
  const build = runNode(INVENTORY, ["--worktree", worktree, "--phase", "build"], home);
  assert.equal(build.json.decisionTableReadyForHandoff, false);
  assert.match(build.json.decisionTableProblems.join("\n"), /Verification Findings is empty/);
  const blocked = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(blocked.json.blocking.decisionTablesCurrent, false);
  writeFileSync(table, verified);
  const reconciled = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(reconciled.json.blocking.decisionTablesCurrent, true);
});

test("target repository declaration admits claude-plugins source, tools, evals, changelog and docs", (t) => {
  const { home, worktree } = setup(t, "claude-paths", { [PATH_POLICY]: CLAUDE_PLUGIN_POLICY }, {
    repoName: "claude-plugins", remoteUrl: "git@github.com:closedloop-ai/claude-plugins.git", declared: false,
  });
  const paths = ["plugins/vibe/skills/handoff/scripts/handoff-inventory.mjs", "tools/vibe-workers/src/claude-worker.ts",
    "evals/vibe/case.md", "CHANGELOG.md", "docs/vibe.md"];
  for (const file of paths) write(worktree, file, "changed\n");
  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
  assert.equal(result.json.pathPolicyFile, PATH_POLICY);
  assert.equal(result.json.pathPolicySource.kind, "base");
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
  write(worktree, "plugins/vibe/AGENTS.md", "changed\n");
  const blocked = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.equal(blocked.json.blocking.forbiddenPaths, false);
  assert.deepEqual(blocked.json.forbidden, [{ path: "plugins/vibe/AGENTS.md", status: "A" }]);
});

test("the claude-plugins handoff exception admits only edits to its existing root AGENTS.md", (t) => {
  // Existing repositories can still carry the older declaration without a root instruction allowance.
  const legacyPolicy = JSON.parse(CLAUDE_PLUGIN_POLICY);
  legacyPolicy.allowedFiles = legacyPolicy.allowedFiles.filter((file) => file !== "AGENTS.md");
  const { home, worktree } = setup(t, "root-instructions", {
    [PATH_POLICY]: JSON.stringify(legacyPolicy),
    "AGENTS.md": "Root instructions\n",
    "CLAUDE.md": "Load AGENTS.md\n",
    "plugins/vibe/AGENTS.md": "Nested instructions\n",
  }, { repoName: "claude-plugins", remoteUrl: "git@github.com:closedloop-ai/claude-plugins.git", declared: false });
  git(worktree, ["config", "vibe.baseRef", "main"], home);
  write(worktree, "AGENTS.md", "Root instructions, edited\n");
  const inventory = (phase = "pull-request") => runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home).json;
  write(worktree, PATH_POLICY, JSON.stringify({ ...legacyPolicy, allowedFiles: [...legacyPolicy.allowedFiles, "AGENTS.md"] }));
  for (const phase of ["handoff", "pull-request"]) {
    const result = inventory(phase);
    assert.equal(result.blocking.forbiddenPaths, true, JSON.stringify(result.forbidden));
    assert.deepEqual(result.outsideAllowed, []);
  }

  for (const file of ["CLAUDE.md", "plugins/vibe/AGENTS.md", "plugins/vibe/CLAUDE.md", "AGENTS.override.md", ".github/workflows/ci.yml"]) {
    write(worktree, file, "Still protected\n");
  }
  const blocked = inventory();
  assert.equal(blocked.blocking.forbiddenPaths, false);
  assert.deepEqual(blocked.forbidden.map(({ path }) => path).sort(), [
    ".github/workflows/ci.yml", "AGENTS.override.md", "CLAUDE.md", "plugins/vibe/AGENTS.md", "plugins/vibe/CLAUDE.md",
  ]);
  unlinkSync(path.join(worktree, "AGENTS.md"));
  assert.ok(inventory().forbidden.some(({ path, status }) => path === "AGENTS.md" && status === "D"));

  write(worktree, "AGENTS.md", "Root instructions, edited\n");
  git(worktree, ["config", "remote.origin.url", "git@github.com:example/claude-plugins.git"], home);
  assert.ok(inventory().forbidden.some(({ path, status }) => path === "AGENTS.md" && status === "M"));
});

test("root declaration uses the verified origin default when the captured base lacks one", (t) => {
  const { home, checkout, worktree } = setup(t, "claude-root-rollout", {}, {
    repoName: "claude-plugins", declared: false,
  });
  write(worktree, "plugins/vibe/skills/handoff/scripts/allowed.mjs", "export {};");
  write(checkout, PATH_POLICY, CLAUDE_PLUGIN_POLICY);
  git(checkout, ["add", PATH_POLICY], home);
  git(checkout, ["commit", "-m", "Declare root handoff paths"], home);
  git(checkout, ["push", "origin", "main"], home);
  git(worktree, ["fetch", "origin", "main"], home);
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
  assert.equal(result.json.pathPolicyFile, PATH_POLICY);
  assert.equal(result.json.pathPolicySource.kind, "origin-default");
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
});

test("added, modified and deleted root declarations cannot self-authorize", (t) => {
  const declared = setup(t, "claude-root-edit", { [PATH_POLICY]: CLAUDE_PLUGIN_POLICY }, {
    repoName: "claude-plugins", declared: false,
  });
  const { home, worktree } = declared;
  const expanded = JSON.stringify({ ...JSON.parse(CLAUDE_PLUGIN_POLICY), allowedPrefixes: ["plugins/", "tools/", "evals/", "docs/", "rogue/"] });
  write(worktree, PATH_POLICY, expanded);
  write(worktree, "rogue/escape.ts", "export {};");
  const modified = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(modified.json.blocking.forbiddenPaths, false);
  assert.deepEqual(modified.json.forbidden, [{ path: PATH_POLICY, status: "M" }]);
  assert.deepEqual(modified.json.outsideAllowed, [{ path: "rogue/escape.ts", status: "A" }]);
  git(worktree, ["rm", "-f", "-q", PATH_POLICY], home);
  const deleted = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(deleted.json.blocking.forbiddenPaths, false);
  assert.deepEqual(deleted.json.forbidden, [{ path: PATH_POLICY, status: "D" }]);

  const undeclared = setup(t, "claude-root-add", {}, {
    repoName: "claude-plugins", declared: false,
  });
  write(undeclared.worktree, PATH_POLICY, CLAUDE_PLUGIN_POLICY);
  write(undeclared.worktree, "plugins/vibe/allowed.mjs", "export {};");
  const added = runNode(INVENTORY, ["--worktree", undeclared.worktree], undeclared.home);
  assert.equal(added.json.blocking.forbiddenPaths, false);
  assert.equal(added.json.pathPolicySource.kind, "built-in-default", "the default applies while the declaration is only being added");
  assert.deepEqual(added.json.forbidden, [{ path: PATH_POLICY, status: "A" }]);
});

test("a sole nested declaration fails closed and names the required root location", (t) => {
  const { home, worktree } = setup(t, "nested-only-policy", {
    "plugins/vibe/vibe-handoff-paths.json": CLAUDE_PLUGIN_POLICY,
  }, { repoName: "claude-plugins", declared: false });
  write(worktree, "plugins/vibe/allowed.mjs", "export {};\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.equal(result.json.pathPolicyFile, "plugins/vibe/vibe-handoff-paths.json");
  assert.match(result.json.pathPolicyProblem, /repository root.*vibe-handoff-paths\.json|vibe-handoff-paths\.json.*repository root/);
});

test("a root declaration alongside a nested declaration fails closed as a duplicate", (t) => {
  const { home, worktree } = setup(t, "root-and-nested-policy", {
    [PATH_POLICY]: CLAUDE_PLUGIN_POLICY,
    "plugins/vibe/vibe-handoff-paths.json": CLAUDE_PLUGIN_POLICY,
  }, { repoName: "claude-plugins", declared: false });
  write(worktree, "plugins/vibe/allowed.mjs", "export {};\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.match(result.json.pathPolicyProblem, /found 2/);
});

// Operator ruling, 2026-11-11: with no declaration the built-in default applies (no protected path classes).
test("with no target declaration the built-in default admits every path, and an unverifiable default branch still fails closed", (t) => {
  const { root, home, worktree } = setup(t, "undeclared-paths", {}, { declared: false });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, true);
  assert.equal(result.json.pathPolicyProblem, undefined);
  assert.equal(result.json.pathPolicyFile, null);
  assert.equal(result.json.pathPolicySource.kind, "built-in-default");
  assert.deepEqual(result.json.outsideAllowed, []);
  git(worktree, ["remote", "set-url", "origin", path.join(root, "missing-origin.git")], home);
  const unavailable = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.json.error, /Cannot verify.*vibe-handoff-paths\.json/);
});

test("an undeclared non-main default branch is checked before the built-in default applies", (t) => {
  const fixture = setup(t, "master-undeclared", {}, { declared: false });
  const { home, worktree } = fixture;
  useMasterDefault(fixture);
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, true);
  assert.equal(result.json.pathPolicySource.kind, "built-in-default");
});

test("a declared non-main default branch allows its repository paths", (t) => {
  const fixture = setup(t, "master-declared");
  const { home, worktree } = fixture;
  useMasterDefault(fixture);
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
  git(worktree, ["config", "vibe.baseRef", "master"], home);
  git(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], home);
  const configured = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(configured.json.blocking.forbiddenPaths, true, JSON.stringify(configured.json));
});

test("a pre-declaration session reads the fetched default branch policy after its base lacks one", (t) => {
  const { home, checkout, worktree } = setup(t, "declaration-rollout", {}, { declared: false });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(checkout, "vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare unchanged handoff paths"], home);
  git(checkout, ["push", "origin", "main"], home);
  git(worktree, ["fetch", "origin", "main"], home);
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
  assert.equal(result.json.pathPolicySource.kind, "origin-default");
  assert.equal(result.json.pathPolicySource.commit, git(worktree, ["rev-parse", "origin/main"], home));
  git(worktree, ["update-ref", "refs/remotes/origin/main", result.json.baseCommit], home);
  const staleTrackingRef = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(staleTrackingRef.status, 1);
  assert.match(staleTrackingRef.json.error, /fetched origin\/main does not match the remote's advertised HEAD/);
  git(worktree, ["config", "vibe.baseRef", "main"], home);
  const staleFallback = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(staleFallback.json.blocking.forbiddenPaths, false);
  assert.match(staleFallback.json.pathPolicyProblem, /does not match the remote's advertised HEAD/);
});

test("a nondefault comparison base cannot supply fallback policy", (t) => {
  const { home, checkout, worktree } = setup(t, "nondefault-policy", {}, { declared: false });
  write(checkout, "vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare default branch policy"], home);
  git(checkout, ["push", "origin", "main"], home);
  git(checkout, ["checkout", "-b", "preview"], home);
  write(checkout, "vibe-handoff-paths.json", CLAUDE_PLUGIN_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Add divergent preview policy"], home);
  git(checkout, ["push", "origin", "preview"], home);
  git(worktree, ["fetch", "origin", "main", "preview"], home);
  git(worktree, ["config", "vibe.baseRef", "preview"], home);
  write(worktree, "tools/rogue.ts", "export {};\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "tools/rogue.ts", status: "A" }]);
  assert.equal(result.json.pathPolicySource.kind, "origin-default");
  assert.equal(result.json.pathPolicySource.commit, git(worktree, ["rev-parse", "origin/main"], home));
  git(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/preview"], home);
  const repointed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(repointed.json.blocking.forbiddenPaths, false);
  assert.deepEqual(repointed.json.outsideAllowed, [{ path: "tools/rogue.ts", status: "A" }]);
  assert.equal(repointed.json.pathPolicySource.commit, git(worktree, ["rev-parse", "origin/main"], home));
});

test("an unconfigured comparison base ignores a locally repointed origin HEAD", (t) => {
  const { home, checkout, worktree } = setup(t, "repointed-comparison", {}, { declared: false });
  const oldBase = git(worktree, ["rev-parse", "HEAD"], home);
  write(checkout, "vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare default policy"], home);
  git(checkout, ["push", "origin", "main"], home);
  git(checkout, ["checkout", "-b", "preview", oldBase], home);
  write(checkout, "vibe-handoff-paths.json", CLAUDE_PLUGIN_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare permissive preview policy"], home);
  git(checkout, ["push", "origin", "preview"], home);
  git(worktree, ["fetch", "origin", "main", "preview"], home);
  git(worktree, ["merge", "--ff-only", "origin/preview"], home);
  git(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/preview"], home);
  write(worktree, "tools/rogue.ts", "export {};\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.baseCommit, oldBase);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "tools/rogue.ts", status: "A" }]);
  assert.equal(result.json.pathPolicySource.commit, git(worktree, ["rev-parse", "origin/main"], home));
});

test("remote default verification pins one commit despite a tracking-ref swap", (t) => {
  const { root, home, checkout, worktree } = setup(t, "tracking-ref-race", {}, { declared: false });
  const oldBase = git(worktree, ["rev-parse", "HEAD"], home);
  write(checkout, "vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare default policy"], home);
  git(checkout, ["push", "origin", "main"], home);
  const defaultSha = git(worktree, ["rev-parse", "origin/main"], home);
  git(checkout, ["checkout", "-b", "preview", oldBase], home);
  write(checkout, "vibe-handoff-paths.json", CLAUDE_PLUGIN_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Declare permissive preview policy"], home);
  git(checkout, ["push", "origin", "preview"], home);
  git(worktree, ["fetch", "origin", "main", "preview"], home);
  git(worktree, ["merge", "--ff-only", "origin/preview"], home);
  const previewSha = git(worktree, ["rev-parse", "origin/preview"], home);
  const refFile = path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], home), "refs/remotes/origin/main");
  mkdirSync(path.dirname(refFile), { recursive: true });
  const preload = path.join(root, "swap-tracking-ref.mjs");
  writeFileSync(preload, `import childProcess from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = childProcess.execFileSync;\nlet swapped = false;\nchildProcess.execFileSync = function(command, args, ...rest) {\n  const result = original(command, args, ...rest);\n  if (!swapped && command === 'git' && JSON.stringify(args) === JSON.stringify(['rev-parse', 'refs/remotes/origin/main'])) {\n    swapped = true; writeFileSync(${JSON.stringify(refFile)}, ${JSON.stringify(`${previewSha}\n`)});\n  }\n  return result;\n};\nsyncBuiltinESMExports();\n`);
  write(worktree, "tools/rogue.ts", "export {};\n");
  const run = spawnSync(process.execPath, ["--import", preload, INVENTORY, "--worktree", worktree],
    { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(run.status, 1, run.stdout || run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.baseCommit, oldBase);
  assert.equal(result.pathPolicySource.commit, defaultSha);
  assert.deepEqual(result.outsideAllowed, [{ path: "tools/rogue.ts", status: "A" }]);
});

test("symphony declaration retains the old allowed and forbidden decisions", (t) => {
  const { home, worktree } = setup(t, "symphony-declared", {
    "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY,
  });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const allowed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(allowed.json.blocking.forbiddenPaths, true, JSON.stringify(allowed.json));
  write(worktree, "scripts/loops-setup.sh", "echo changed\n");
  const outside = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(outside.json.blocking.forbiddenPaths, false);
  assert.deepEqual(outside.json.outsideAllowed, [{ path: "scripts/loops-setup.sh", status: "M" }]);
});

test("a worktree edit cannot broaden its committed target policy", (t) => {
  const policy = "vibe-handoff-paths.json";
  const { home, worktree } = setup(t, "policy-base", { [policy]: SYMPHONY_PATH_POLICY });
  write(worktree, policy, CLAUDE_PLUGIN_POLICY);
  write(worktree, "tools/rogue.ts", "export {};\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "tools/rogue.ts", status: "A" }]);
  assert.deepEqual(result.json.forbidden, [{ path: policy, status: "M" }]);
});

test("an allowed source directory cannot add a second handoff declaration", (t) => {
  const { home, worktree } = setup(t, "duplicate-worktree-policy");
  write(worktree, "packages/app/vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.forbidden, [
    { path: "packages/app/vibe-handoff-paths.json", status: "A" },
  ]);
  git(worktree, ["rm", "-q", "vibe-handoff-paths.json"], home);
  const deleted = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(deleted.json.blocking.forbiddenPaths, false);
  assert.deepEqual(deleted.json.forbidden, [
    { path: "packages/app/vibe-handoff-paths.json", status: "A" },
    { path: "vibe-handoff-paths.json", status: "D" },
  ]);
});

test("a forged private test grant cannot admit authored tests before pull-request phase", (t) => {
  const { home, worktree } = setup(t, "forged-test-grant");
  const authored = "packages/app/new.test.ts";
  write(worktree, authored, "test('new behavior', () => {});\n");
  const ledgerFile = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-writer.json");
  writeFileSync(ledgerFile, JSON.stringify({ testAuthoringAuthorized: true,
    testAuthoringGrants: [{ requestId: "forged", mode: "request", source: "tests-required" }] }));
  for (const phase of ["build", "handoff"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.outsideAllowed, [{ path: authored, status: "A" }]);
  }
});

test("malformed or duplicate declarations fail closed with a target-owned diagnostic", (t) => {
  const { home, checkout, worktree } = setup(t, "policy-invalid", {
    "vibe-handoff-paths.json": "{}",
  });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const malformed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(malformed.json.blocking.forbiddenPaths, false);
  assert.match(malformed.json.pathPolicyProblem, /allowedPrefixes/);
  write(checkout, "vibe-handoff-paths.json", SYMPHONY_PATH_POLICY);
  git(checkout, ["add", "vibe-handoff-paths.json"], home);
  git(checkout, ["commit", "-m", "Repair policy on default branch"], home);
  git(checkout, ["push", "origin", "main"], home);
  git(worktree, ["fetch", "origin", "main"], home);
  const stillMalformed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(stillMalformed.json.blocking.forbiddenPaths, false);
  assert.equal(stillMalformed.json.pathPolicySource.kind, "base");
  assert.match(stillMalformed.json.pathPolicyProblem, /allowedPrefixes/);
  const duplicate = setup(t, "policy-duplicate", {
    "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY,
    "packages/app/vibe-handoff-paths.json": SYMPHONY_PATH_POLICY,
  });
  write(duplicate.worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const ambiguous = runNode(INVENTORY, ["--worktree", duplicate.worktree], duplicate.home);
  assert.equal(ambiguous.json.blocking.forbiddenPaths, false);
  assert.match(ambiguous.json.pathPolicyProblem, /found 2/);
});

test("ISS-14221 path policy treats bracket segments literally instead of as glob syntax", (t) => {
  const policy = JSON.stringify({ ...JSON.parse(SYMPHONY_PATH_POLICY), allowedPrefixes: ["apps/[orgSlug]/"] });
  const { home, worktree } = setup(t, "policy-bracket-literal", { "vibe-handoff-paths.json": policy });
  const route = "apps/[orgSlug]/page.tsx";
  write(worktree, route, "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.pathPolicyProblem, undefined);
  assert.deepEqual(result.json.changedFiles, [{ path: route, status: "A" }]);
  assert.equal(result.json.blocking.forbiddenPaths, true);
});

test('inventory rejects a mutation between source reads and receipt attribution', t => {
  const { root, home, worktree } = setup(t, 'inventory-read-race');
  write(worktree, ALLOWLIST, allowlist([FOCUS_RING]));
  write(worktree, 'apps/app/page.tsx', 'export const page = 2;\n');
  const preload = mutationPreload(root, { file: path.join(worktree, ALLOWLIST), caller: 'isShrinkOnlyEdit', text: allowlist([FOCUS_RING, HEX]) });
  const run = spawnSync(process.execPath, ['--import', preload, INVENTORY, '--worktree', worktree], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(run.stderr, /SOURCE-MOVED/);
  assert.doesNotMatch(run.stdout, /"source"/);
});

test("worktree-local plans are not deliverables and neighboring artifacts fail closed", (t) => {
  const { home, worktree } = setup(t, "private-plan");
  write(worktree, ".closedloop-ai/vibe-plans/request-1.md", "private plan\n");
  write(worktree, ".closedloop-ai/vibe-plans-other.md", "not a local plan\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.match(result.json.source.diffSha256, /^[a-f0-9]{64}$/);
  assert.match(result.json.source.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.status, 1, JSON.stringify(result.json));
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.localPlans, [{ path: ".closedloop-ai/vibe-plans/request-1.md", status: "A" }]);
  assert.deepEqual(result.json.trackedLocalPlans, []);
  assert.deepEqual(result.json.changedFiles.map(file => file.path), [".closedloop-ai/vibe-plans-other.md", "apps/app/page.tsx"]);
  assert.deepEqual(result.json.outsideAllowed, [{ path: ".closedloop-ai/vibe-plans-other.md", status: "A" }]);
});

test("staged or committed plans block handoff instead of hiding a planning leak", (t) => {
  const { home, worktree } = setup(t, "tracked-plan");
  const plan = ".closedloop-ai/vibe-plans/request-1.md";
  write(worktree, plan, "private plan\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  git(worktree, ["add", plan], home);
  for (const committed of [false, true]) {
    if (committed) git(worktree, ["commit", "-m", "Fixture: accidentally tracked plan"], home);
    const result = runNode(INVENTORY, ["--worktree", worktree], home);
    assert.equal(result.status, 1);
    assert.equal(result.json.blocking.localPlansUntracked, false);
    assert.deepEqual(result.json.trackedLocalPlans, [plan]);
  }
});

test("root web, desktop and every e2e-root test spec are allowed only for a requested pull request, never at handoff", (t) => {
  const { home, worktree } = setup(t, "pull-request-tests");
  write(worktree, "e2e/feature.spec.ts", "export {};\n");
  write(worktree, "e2e-web-smoke/feature.spec.ts", "export {};\n");
  write(worktree, "apps/desktop/test/feature.spec.ts", "export {};\n");
  write(worktree, "e2e/playwright.config.ts", "export {};\n");
  const specs = [
    { path: "apps/desktop/test/feature.spec.ts", status: "A" },
    { path: "e2e-web-smoke/feature.spec.ts", status: "A" },
    { path: "e2e/feature.spec.ts", status: "A" },
    { path: "e2e/playwright.config.ts", status: "A" },
  ];
  const build = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.deepEqual(build.json.outsideAllowed, specs);
  const handoff = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.deepEqual(handoff.json.outsideAllowed, specs);
  const pullRequest = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.deepEqual(pullRequest.json.outsideAllowed, [{ path: "e2e/playwright.config.ts", status: "A" }]);
  const invalid = runNode(INVENTORY, ["--worktree", worktree, "--phase", "unknown"], home);
  assert.equal(invalid.status, 1);
});

test("existing tests and fixtures may be repaired in every phase; only a pull request adds, deletes or snapshot-updates one", (t) => {
  const { home, worktree } = setup(t, "test-repairs", {
    "packages/app/sessions/list.test.tsx": "expect(render(List)).toBeTruthy();\n",
    "packages/app/sessions/__fixtures__/rows.ts": "export const rows = [];\n",
    "packages/app/sessions/__snapshots__/list.test.tsx.snap": "exports[`list`] = `<ul />`;\n",
    "packages/app/sessions/retired.test.tsx": "expect(retired()).toBe(1);\n",
    "e2e/sessions.spec.ts": "test('sessions', () => {});\n",
    "e2e/fixtures/auth.ts": "export const auth = {};\n",
    "e2e-web-smoke/boot.spec.ts": "test('boot', () => {});\n",
  });
  write(worktree, "e2e-web-smoke/boot.spec.ts", "test('boot', async () => {});\n");
  write(worktree, "packages/app/sessions/list.test.tsx", "expect(render(ListV2)).toBeTruthy();\n");
  write(worktree, "packages/app/sessions/__fixtures__/rows.ts", "export const rows: Row[] = [];\n");
  write(worktree, "packages/app/sessions/__snapshots__/list.test.tsx.snap", "exports[`list`] = `<ol />`;\n");
  write(worktree, "e2e/sessions.spec.ts", "test('sessions', async () => {});\n");
  write(worktree, "e2e/fixtures/auth.ts", "export const auth: Auth = {};\n");
  write(worktree, "packages/app/sessions/new.test.tsx", "expect(1).toBe(1);\n");
  write(worktree, "packages/app/sessions/__tests__/helper.ts", "export {};\n");
  git(worktree, ["rm", "-q", "packages/app/sessions/retired.test.tsx"], home);
  const repairs = [
    { path: "e2e-web-smoke/boot.spec.ts", status: "M" },
    { path: "e2e/fixtures/auth.ts", status: "M" },
    { path: "e2e/sessions.spec.ts", status: "M" },
    { path: "packages/app/sessions/__fixtures__/rows.ts", status: "M" },
    { path: "packages/app/sessions/list.test.tsx", status: "M" },
  ];
  const authored = [
    { path: "packages/app/sessions/__snapshots__/list.test.tsx.snap", status: "M" },
    { path: "packages/app/sessions/__tests__/helper.ts", status: "A" },
    { path: "packages/app/sessions/new.test.tsx", status: "A" },
    { path: "packages/app/sessions/retired.test.tsx", status: "D" },
  ];
  for (const phase of ["build", "handoff"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.testRepairs, repairs, phase);
    assert.deepEqual(result.json.outsideAllowed, authored, phase);
  }
  const pullRequest = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.deepEqual(pullRequest.json.testRepairs, repairs);
  assert.deepEqual(pullRequest.json.outsideAllowed, []);
});

test("a deleted test is allowed outside a pull request only when recorded as covering retired code", (t) => {
  const { home, worktree } = setup(t, "retired-tests", {
    "packages/app/sessions/grouped-list.test.tsx": "expect(renderGrouped()).toBeTruthy();\n",
    "packages/app/sessions/live.test.tsx": "expect(renderLive()).toBeTruthy();\n",
    "packages/app/sessions/list.test.tsx": "it('flat', () => {});\nit('grouped', () => {});\n",
  });
  git(worktree, ["rm", "-q", "packages/app/sessions/grouped-list.test.tsx", "packages/app/sessions/live.test.tsx"], home);
  write(worktree, "packages/app/sessions/list.test.tsx", "it('flat', () => {});\n");
  const recorded = [
    ["--path", "packages/app/sessions/grouped-list.test.tsx", "--retired-by", "PRD-720", "--covers", "GroupedListRenderer"],
    ["--path", "packages/app/sessions/list.test.tsx", "--case", "grouped", "--retired-by", "PRD-720", "--covers", "the grouped mode"],
  ];
  for (const args of recorded) {
    assert.equal(runNode(RETIRED, ["record", "--worktree", worktree, ...args], home).status, 0);
  }
  for (const phase of ["build", "handoff"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.outsideAllowed, [{ path: "packages/app/sessions/live.test.tsx", status: "D" }], phase);
    assert.deepEqual(result.json.testRepairs, [{ path: "packages/app/sessions/list.test.tsx", status: "M" }], phase);
    assert.deepEqual(result.json.retiredTests, [
      { path: "packages/app/sessions/grouped-list.test.tsx", retiredBy: "PRD-720", covers: "GroupedListRenderer", status: "D" },
      { path: "packages/app/sessions/list.test.tsx", case: "grouped", retiredBy: "PRD-720", covers: "the grouped mode", status: "M" },
    ], phase);
  }
  const caseOnly = runNode(RETIRED, ["record", "--worktree", worktree, "--path", "packages/app/sessions/live.test.tsx",
    "--case", "renders", "--retired-by", "PRD-720", "--covers", "nothing retired"], home);
  assert.equal(caseOnly.status, 0);
  const stillOutside = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.deepEqual(stillOutside.json.outsideAllowed, [{ path: "packages/app/sessions/live.test.tsx", status: "D" }]);
});

test("a test repair never admits a harness or a path the session may not edit", (t) => {
  const { home, worktree } = setup(t, "repair-bounds", {
    "e2e/playwright.config.ts": "export default {};\n",
    "apps/mcp/fixtures/tool.ts": "export const tool = {};\n",
  });
  write(worktree, "e2e/playwright.config.ts", "export default { retries: 5 };\n");
  write(worktree, "apps/mcp/fixtures/tool.ts", "export const tool: Tool = {};\n");
  for (const phase of ["build", "handoff", "pull-request"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.testRepairs, [], phase);
    assert.deepEqual(result.json.outsideAllowed, [
      { path: "apps/mcp/fixtures/tool.ts", status: "M" },
      { path: "e2e/playwright.config.ts", status: "M" },
    ], phase);
  }
});

test("no docs page is ever an allowed change, in any phase", (t) => {
  const { home, worktree } = setup(t, "feature-docs");
  write(worktree, "apps/web/content/docs/concepts/bulk-actions.mdx", "Bulk actions, agent draft.\n");
  write(worktree, "docs/runbooks/bulk-actions.md", "Runbook, updated draft.\n");
  write(worktree, "apps/web/content/docs/api-reference/projects/listProjects.mdx", "generated, hand edited\n");
  write(worktree, "apps/web/content/docs/meta.json", "{\"pages\":[\"new\"]}\n");
  write(worktree, "apps/web/content/docs/concepts/new-page.mdx", "A page nobody asked for.\n");
  const outside = [
    { path: "apps/web/content/docs/api-reference/projects/listProjects.mdx", status: "M" },
    { path: "apps/web/content/docs/concepts/bulk-actions.mdx", status: "M" },
    { path: "apps/web/content/docs/concepts/new-page.mdx", status: "A" },
    { path: "apps/web/content/docs/meta.json", status: "M" },
    { path: "docs/runbooks/bulk-actions.md", status: "M" },
  ];
  for (const phase of ["build", "handoff", "pull-request"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.outsideAllowed, outside, phase);
  }
});

test("local fixes are listed on their own and kept out of every guardrail check", (t) => {
  const { home, worktree } = setup(t, "local-fixes");
  // The setup worker's workaround: a forbidden repo script and a new helper.
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  write(worktree, "apps/app/env-fix.ts", "export const fixed = true;\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh", "--path", "apps/app/env-fix.ts"],
    home
  );
  // The person's own work.
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.changedFiles, [{ path: "apps/app/page.tsx", status: "M" }]);
  assert.deepEqual(result.json.localFixes, [
    { path: "apps/app/env-fix.ts", status: "A", ticket: "ISS-77" },
    { path: "scripts/loops-setup.sh", status: "M", ticket: "ISS-77" },
  ]);
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
});

test("the same forbidden change is still blocked when it is not a recorded local fix", (t) => {
  const { home, worktree } = setup(t, "no-local-fix");
  write(worktree, ".github/workflows/ci.yml", "on: pull_request\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.forbidden, [{ path: ".github/workflows/ci.yml", status: "M" }]);
  assert.deepEqual(result.json.localFixes, []);
});

test("every path outside the allowed table blocks except a shrink-only allowlist", (t) => {
  const { home, worktree } = setup(t, "outside-allowed-blocks", {
    "plugins/product/skills/example/SKILL.md": "# Existing skill\n",
  });
  write(worktree, "scripts/release.mjs", "export const release = true;\n");
  write(worktree, "plugins/product/skills/example/SKILL.md", "# Changed skill\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.outsideAllowed, [
    { path: "plugins/product/skills/example/SKILL.md", status: "M" },
    { path: "scripts/release.mjs", status: "A" },
  ]);
});

test("a session whose only changes are local fixes has nothing to hand off", (t) => {
  const { home, worktree } = setup(t, "only-fixes");
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh"],
    home
  );

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.hasChanges, false);
  assert.deepEqual(result.json.changedFiles, []);
  assert.equal(result.json.localFixes.length, 1);
});

test("a recorded local fix that was already restored is not listed", (t) => {
  const { home, worktree } = setup(t, "restored");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh"],
    home
  );
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.localFixes, []);
});

test("committed redeploys count as the session's work and the live ticket is reported", (t) => {
  const { home, worktree } = setup(t, "redeployed");
  write(worktree, "apps/app/page.tsx", "export const page = 3;\n");
  git(worktree, ["add", "apps/app/page.tsx"], home);
  git(worktree, ["commit", "--quiet", "-m", "redeploy 1"], home);
  write(worktree, "apps/app/later.tsx", "const later = 1;\n");
  runNode(SESSIONS, ["touch", "--worktree", worktree, "--live-ticket", "ISS-90"], home);

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.changedFiles, [
    { path: "apps/app/later.tsx", status: "A" },
    { path: "apps/app/page.tsx", status: "M" },
  ]);
  assert.equal(result.json.liveTicket, "ISS-90");
  assert.equal(result.json.mode, "seeded");
  assert.equal(result.json.vercel.appUrl, "https://app-stage-git-vibe-redeployed.preview.closedloop-stage.ai");
});

test("a session may only shrink the source-gate allowlist under scripts/", (t) => {
  const { home, worktree } = setup(t, "shrink");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, ALLOWLIST, allowlist([HEX]));
  const removed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(removed.status, 0, JSON.stringify(removed.json.forbidden));
  assert.deepEqual(removed.json.shrinkOnlyAllowlists, [{ path: ALLOWLIST, status: "M" }]);
  assert.deepEqual(removed.json.forbidden, []);
  assert.deepEqual(removed.json.outsideAllowed, []);

  write(worktree, ALLOWLIST, allowlist([FOCUS_RING, { ...HEX, count: 2 }]));
  assert.deepEqual(runNode(INVENTORY, ["--worktree", worktree], home).json.outsideAllowed, []);

  const grown = { ...HEX, count: 4 };
  const added = { ...HEX, file: "apps/app/c.tsx", fingerprint: "apps/app/c.tsx" };
  for (const entries of [[FOCUS_RING, grown], [FOCUS_RING, HEX, added], [{ ...FOCUS_RING, reason: "changed" }]]) {
    write(worktree, ALLOWLIST, allowlist(entries));
    const refused = runNode(INVENTORY, ["--worktree", worktree], home);
    assert.deepEqual(refused.json.outsideAllowed, [{ path: ALLOWLIST, status: "M" }], JSON.stringify(entries));
    assert.deepEqual(refused.json.shrinkOnlyAllowlists, []);
    assert.equal(refused.json.blocking.forbiddenPaths, false);
    assert.equal(refused.status, 1);
  }

  write(worktree, ALLOWLIST, allowlist([HEX]));
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  const other = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.deepEqual(other.json.outsideAllowed, [{ path: "scripts/loops-setup.sh", status: "M" }]);
  assert.equal(other.json.blocking.forbiddenPaths, false);
  assert.equal(other.status, 1);
});

test("frontend-only work reports no backend change", (t) => {
  const { home, worktree } = setup(t, "frontend-only");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "packages/app/tags/components/tag-menu.tsx", "const TagMenu = 1;\n");
  write(worktree, "apps/desktop/src/renderer/view.tsx", "const view = 1;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.backendChanged, false);
  assert.deepEqual(result.json.backendFiles, []);
});

test("backend work is allowed and reported for the full checks", (t) => {
  const { home, worktree } = setup(t, "backend", { "packages/database/__tests__/migrations.test.ts": "test();\n" });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "apps/api/app/tags/route.ts", "export const GET = 1;\n");
  write(worktree, "packages/api/src/types/tag.ts", "type Tag = string;\n");
  write(worktree, "packages/database/prisma/migrations/1_tags/migration.sql", "select 1;\n");
  write(worktree, "apps/desktop/src/main/tags.ts", "const tags = 1;\n");
  writeFileSync(path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-changes.md"), "Migration test: 1_tags: packages/database/__tests__/migrations.test.ts\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
  assert.equal(result.json.backendChanged, true);
  assert.deepEqual(
    result.json.backendFiles.map((file) => file.path),
    [
      "apps/api/app/tags/route.ts",
      "apps/desktop/src/main/tags.ts",
      "packages/api/src/types/tag.ts",
      "packages/database/prisma/migrations/1_tags/migration.sql",
    ]
  );
});

test("a migration outside the backend packages and a local-fix backend file count the right way", (t) => {
  const { home, worktree } = setup(t, "migration-elsewhere");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "apps/desktop/src/server/fix.ts", "export const fix = 1;\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "apps/desktop/src/server/fix.ts"],
    home
  );
  const withoutBackend = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(withoutBackend.json.backendChanged, false);

  write(worktree, "apps/mcp/prisma/migrations/2_x/migration.sql", "select 1;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.backendChanged, true);
  assert.deepEqual(result.json.backendFiles, [{ path: "apps/mcp/prisma/migrations/2_x/migration.sql", status: "A" }]);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "apps/mcp/prisma/migrations/2_x/migration.sql", status: "A" }]);
});

test("a desktop prisma file that is not .sql still counts as backend", (t) => {
  const { home, worktree } = setup(t, "desktop-prisma-non-sql");
  write(worktree, "apps/desktop/prisma/migrations/migration_lock.toml", 'provider = "sqlite"\n');
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.backendChanged, true);
  assert.deepEqual(result.json.backendFiles, [{ path: "apps/desktop/prisma/migrations/migration_lock.toml", status: "A" }]);
});

// The story cases below run on a base with no story-group-order.ts, so the
// version scheme (pre-#8867) applies; handoff-inventory-storybook-scheme.test.mjs
// covers the lifecycle scheme and the move between them.
test("a v1.0 story file is frozen: an edit or move blocks, and new states go in a new v2.0 entry", (t) => {
  const v1Meta = (title, tags) => `export default { title: "${title}", tags: [${tags.map((tag) => `"${tag}"`).join(", ")}] };\n`;
  const subtree = "apps/storybook/stories/composites/sortable-subtree.stories.tsx";
  const treeRow = "apps/storybook/stories/composites/tree-row.stories.tsx";
  const movedTreeRow = "apps/storybook/stories/tree/tree-row.stories.tsx";
  const { home, worktree } = setup(t, "story-taxonomy", {
    [subtree]: v1Meta("Primitives/Data Display/Sortable Subtree", ["autodocs"]),
    [treeRow]: `${v1Meta("Composites/Data Display/Tree Row", ["v1.0"])}export const Default = { args: { label: "Row" } };\n`,
    "apps/storybook/stories/composites-v2/grid-groups.stories.tsx": v1Meta("Composites v2.0/Artifacts/Grid Groups", ["v2.0"]),
  });
  write(worktree, subtree, `${v1Meta("Primitives/Data Display/Sortable Subtree", ["autodocs"])}export const Grouped = {};\n`);
  mkdirSync(path.join(worktree, "apps/storybook/stories/tree"), { recursive: true });
  git(worktree, ["mv", treeRow, movedTreeRow], home);
  write(worktree, "apps/storybook/stories/composites-v2/grid-groups.stories.tsx", v1Meta("Composites v2.0/Artifacts/Grid Groups", ["v2.0", "v1.0"]));
  write(worktree, "packages/app/documents/components/documents-grid-groups-body.stories.tsx", v1Meta("Composites/Documents/Documents Grid Groups Body", ["v1.0"]));
  write(worktree, "apps/storybook/stories/composites-v2/documents-grid-groups-body.stories.tsx", v1Meta("Composites v2.0/Artifacts/Documents/Grid Groups Body", ["v2.0"]));
  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.v1Stories, [
    { path: "apps/storybook/stories/composites-v2/grid-groups.stories.tsx", status: "M", reasons: ["tag"] },
    { path: subtree, status: "M", reasons: ["frozen"] },
    { path: movedTreeRow, status: "A", from: treeRow, reasons: ["frozen"] },
    { path: "packages/app/documents/components/documents-grid-groups-body.stories.tsx", status: "A", reasons: ["title", "tag"] },
  ]);
  assert.deepEqual(result.json.retitledStories, []);

  git(worktree, ["mv", movedTreeRow, treeRow], home);
  git(worktree, ["checkout", "-q", "--", subtree, "apps/storybook/stories/composites-v2/grid-groups.stories.tsx"], home);
  git(worktree, ["clean", "-qfd", "packages/app"], home);
  write(worktree, "apps/storybook/stories/primitives-v2/sortable-subtree-grouping.stories.tsx", `${v1Meta("Primitives v2.0/Data Display/Sortable Subtree Grouping", ["v2.0"])}export const Grouped = {};\n`);
  const clean = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(clean.json.blocking.storiesInV2Taxonomy, true, JSON.stringify(clean.json.v1Stories));
  assert.deepEqual(clean.json.v1Stories, []);
  assert.equal(clean.status, 0, JSON.stringify(clean.json));
});

test("a compile-only repair of a v1.0 story file passes for engineering review; a story, title, tag or move change still blocks", (t) => {
  const dir = "apps/storybook/stories/composites";
  const v1File = (name, { title = `Composites/Data Display/${name}`, tags = ["v1.0", "autodocs"], prop = "label", from = "@repo/design-system/tree-row", stories = ["Default", "Selected"] } = {}) =>
    [
      `import type { Meta } from "@storybook/react";`,
      `import { TreeRow } from "${from}";`,
      "const meta = {",
      `  title: "${title}",`,
      "  component: TreeRow,",
      `  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],`,
      "} satisfies Meta<typeof TreeRow>;",
      "export default meta;",
      ...stories.map((story) => `export const ${story} = { args: { ${prop}: "${story}" } };`),
      "",
    ].join("\n");
  const cases = {
    propRename: "Prop Rename",
    addedStory: "Added Story",
    removedStory: "Removed Story",
    renamedStory: "Renamed Story",
    retitled: "Retitled",
    retagged: "Retagged",
    moved: "Moved",
  };
  const file = (key) => `${dir}/${key}.stories.tsx`;
  const movedTo = "apps/storybook/stories/tree/moved.stories.tsx";
  const { home, worktree } = setup(
    t,
    "story-compile-only",
    Object.fromEntries(Object.entries(cases).map(([key, name]) => [file(key), v1File(name)]))
  );
  const repaired = { prop: "text", from: "@repo/design-system/tree/tree-row" };
  write(worktree, file("propRename"), v1File(cases.propRename, repaired));
  write(worktree, file("addedStory"), v1File(cases.addedStory, { ...repaired, stories: ["Default", "Selected", "Disabled"] }));
  write(worktree, file("removedStory"), v1File(cases.removedStory, { ...repaired, stories: ["Default"] }));
  write(worktree, file("renamedStory"), v1File(cases.renamedStory, { ...repaired, stories: ["Default", "Active"] }));
  write(worktree, file("retitled"), v1File(cases.retitled, { ...repaired, title: "Composites/Data Display/Retitled Row" }));
  write(worktree, file("retagged"), v1File(cases.retagged, { ...repaired, tags: ["v1.0"] }));
  mkdirSync(path.join(worktree, "apps/storybook/stories/tree"), { recursive: true });
  git(worktree, ["mv", file("moved"), movedTo], home);
  write(worktree, movedTo, v1File(cases.moved, repaired));

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.compileOnlyV1Repairs, [{ path: file("propRename"), status: "M" }]);
  assert.deepEqual(result.json.v1Stories, [
    { path: file("addedStory"), status: "M", reasons: ["frozen"] },
    { path: file("removedStory"), status: "M", reasons: ["frozen"] },
    { path: file("renamedStory"), status: "M", reasons: ["frozen"] },
    { path: file("retagged"), status: "M", reasons: ["frozen"] },
    { path: file("retitled"), status: "M", reasons: ["frozen"] },
    { path: movedTo, status: "A", from: file("moved"), reasons: ["frozen"] },
  ]);

  git(worktree, ["mv", movedTo, file("moved")], home);
  git(worktree, ["checkout", "-q", "--", ...["addedStory", "removedStory", "renamedStory", "retitled", "retagged", "moved"].map(file)], home);
  const repairOnly = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(repairOnly.status, 0, JSON.stringify(repairOnly.json));
  assert.equal(repairOnly.json.blocking.storiesInV2Taxonomy, true);
  assert.deepEqual(repairOnly.json.v1Stories, []);
  assert.deepEqual(repairOnly.json.compileOnlyV1Repairs, [{ path: file("propRename"), status: "M" }]);
});

test("Start Here is unversioned: its Version History and other pages may be edited, re-tagged and retitled while other v1.0 files stay frozen", (t) => {
  const page = (title, tags, releases) =>
    [
      `import type { Meta } from "@storybook/react";`,
      `import packageJson from "../package.json";`,
      `const RELEASES = [${releases.map((version) => `{ version: "${version}" }`).join(", ")}];`,
      "const meta = {",
      `  title: "${title}",`,
      `  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],`,
      "} satisfies Meta;",
      "export default meta;",
      "export const Page = { args: { releases: RELEASES, version: packageJson.version } };",
      "",
    ].join("\n");
  const history = "apps/storybook/stories/start-here-version-history.stories.tsx";
  const catalog = "apps/storybook/stories/start-here-catalog.stories.tsx";
  const treeRow = "apps/storybook/stories/composites/tree-row.stories.tsx";
  const treeRowMeta = `export default { title: "Composites/Data Display/Tree Row", tags: ["v1.0"] };\nexport const Default = {};\n`;
  const { home, worktree } = setup(t, "start-here-unversioned", {
    [history]: page("Start Here/Version History", ["v1.0"], ["2.0.30"]),
    [catalog]: page("Start Here/Catalog", ["v1.0"], []),
    [treeRow]: treeRowMeta,
  });
  write(worktree, history, page("Start Here/Version History", ["v2.0"], ["2.0.31", "2.0.30"]));
  write(worktree, catalog, page("Start Here/Component Catalog", ["v1.0"], []));
  write(worktree, treeRow, `${treeRowMeta}export const Selected = {};\n`);

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.v1Stories, [{ path: treeRow, status: "M", reasons: ["frozen"] }]);
  assert.deepEqual(result.json.compileOnlyV1Repairs, []);
  assert.equal(result.json.blocking.existingStoryTitlesKept, true);
  assert.deepEqual(result.json.retitledStories, []);

  git(worktree, ["checkout", "-q", "--", treeRow], home);
  const startHereOnly = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(startHereOnly.status, 0, JSON.stringify(startHereOnly.json));
  assert.equal(startHereOnly.json.blocking.storiesInV2Taxonomy, true);
  assert.deepEqual(startHereOnly.json.v1Stories, []);
  assert.deepEqual(startHereOnly.json.retitledStories, []);
  assert.deepEqual(startHereOnly.json.changedFiles.map((file) => file.path), [catalog, history]);
});

test("an existing non-v1.0 story file whose meta title changed blocks unless recorded as a replacement's entry", (t) => {
  const meta = (title, tags) => `const meta = {\n  title: "${title}",\n  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],\n};\nexport default meta;\n`;
  const table = "apps/storybook/stories/grid-table-v2.stories.tsx";
  const toolbar = "apps/storybook/stories/grid-table-toolbar.stories.tsx";
  const footer = "apps/storybook/stories/grid-table-footer.stories.tsx";
  const card = "apps/storybook/stories/grid-table-card.stories.tsx";
  const { home, worktree } = setup(t, "story-retitle", {
    [table]: meta("Composites v2.0/Data Display/Tables/Grid Table V2", ["v2.0"]),
    [toolbar]: meta("Composites v2.0/Data Display/Tables/Grid Table Toolbar", ["v2.0"]),
    [footer]: `${meta("Composites v2.0/Data Display/Tables/Grid Table Footer", ["v2.0"])}export const Default = { args: { label: "Rows" } };\n`,
    [card]: `${meta("Composites v2.0/Data Display/Tables/Grid Table Card", ["v2.0"])}export const Default = { args: { label: "Card" } };\n`,
  });
  write(worktree, table, `${meta("Composites v2.0/Tables/Grid Table V2", ["v2.0"])}export const Grouped = {};\n`);
  write(worktree, toolbar, `${meta("Composites v2.0/Data Display/Tables/Grid Table Toolbar", ["v2.0"])}export const Grouped = { args: { title: "Composites v2.0/Not a meta title" } };\n`);
  mkdirSync(path.join(worktree, "apps/storybook/stories/tables"), { recursive: true });
  git(worktree, ["mv", footer, "apps/storybook/stories/tables/grid-table-footer.stories.tsx"], home);
  write(worktree, "apps/storybook/stories/tables/grid-table-footer.stories.tsx", `${meta("Composites v2.0/Tables/Grid Table Footer", ["v2.0"])}export const Default = { args: { label: "Rows" } };\n`);
  git(worktree, ["mv", card, "apps/storybook/stories/tables/grid-table-card.stories.tsx"], home);
  git(worktree, ["commit", "--quiet", "-m", "redeploy 1"], home);

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.existingStoryTitlesKept, false);
  assert.deepEqual(result.json.v1Stories, []);
  assert.deepEqual(result.json.retitledStories, [
    { path: table, baseTitle: "Composites v2.0/Data Display/Tables/Grid Table V2", title: "Composites v2.0/Tables/Grid Table V2", replacement: null },
    {
      path: "apps/storybook/stories/tables/grid-table-footer.stories.tsx",
      from: footer,
      baseTitle: "Composites v2.0/Data Display/Tables/Grid Table Footer",
      title: "Composites v2.0/Tables/Grid Table Footer",
      replacement: null,
    },
  ]);

  const rejected = runNode(SESSIONS, ["story-replacement", "--worktree", worktree, "--path", "apps/app/page.tsx", "--replacement", "GridTableV3"], home);
  assert.equal(rejected.status, 1);
  assert.match(rejected.json.error, /must name a story file/);
  for (const story of [table, footer]) {
    const recorded = runNode(SESSIONS, ["story-replacement", "--worktree", worktree, "--path", story, "--replacement", "GridTableV3"], home);
    assert.equal(recorded.status, 0, JSON.stringify(recorded.json));
  }
  const replaced = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(replaced.json.blocking.existingStoryTitlesKept, true, JSON.stringify(replaced.json.retitledStories));
  assert.equal(replaced.status, 0, JSON.stringify(replaced.json.blocking));
  assert.deepEqual(replaced.json.retitledStories.map((story) => story.replacement), ["GridTableV3", "GridTableV3"]);
});

test("all of apps/storybook is allowed while root scripts, .github and AGENTS.md stay out", (t) => {
  const { home, worktree } = setup(t, "storybook-wiring", {
    "apps/storybook/.storybook/main.ts": "export default {};\n",
    "apps/storybook/.storybook/preview.tsx": "export default {};\n",
    "apps/storybook/TAXONOMY.md": "# Taxonomy\n",
    "apps/storybook/scripts/taxonomy-classification.mjs": "export const DS_PRIMITIVES = [];\n",
    "apps/storybook/AGENTS.md": "# Storybook\n",
  });
  const storybook = [
    "apps/storybook/.storybook/decorators/flag-decorator.tsx",
    "apps/storybook/.storybook/main.ts",
    "apps/storybook/.storybook/manager.ts",
    "apps/storybook/.storybook/preview.tsx",
    "apps/storybook/scripts/taxonomy-classification.mjs",
    "apps/storybook/TAXONOMY.md",
  ];
  for (const file of storybook) write(worktree, file, "export const changed = true;\n");
  const allowed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(allowed.status, 0, JSON.stringify(allowed.json));
  assert.deepEqual(allowed.json.changedFiles.map((file) => file.path), storybook);
  assert.deepEqual(allowed.json.outsideAllowed, []);
  assert.deepEqual(allowed.json.forbidden, []);

  write(worktree, "scripts/lint/rules/no-threaded-feature-flag.ts", "export {};\n");
  write(worktree, ".github/workflows/storybook-release.yml", "on: release\n");
  write(worktree, "apps/storybook/AGENTS.md", "# Storybook, changed\n");
  const refused = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.blocking.forbiddenPaths, false);
  assert.deepEqual(refused.json.forbidden, [
    { path: ".github/workflows/storybook-release.yml", status: "A" },
    { path: "apps/storybook/AGENTS.md", status: "M" },
  ]);
  assert.deepEqual(refused.json.outsideAllowed, [{ path: "scripts/lint/rules/no-threaded-feature-flag.ts", status: "A" }]);
});

test("diff rule findings block the inventory and its required tests are reported, local fixes left out", (t) => {
  const { home, worktree } = setup(t, "diff-rules", {
    "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts": "test\n",
    "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 1;\n",
  });
  write(worktree, "packages/design-system/lib/grid-table-v2-types.ts", "export type A = 2;\n");
  const clean = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(clean.status, 0, JSON.stringify(clean.json));
  assert.equal(clean.json.blocking.diffRulesClear, true);
  assert.deepEqual(clean.json.diffRules.requiredTests.map((entry) => entry.path), ["apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts"]);

  const write_ = "await tx.artifactLink.deleteMany({ where: { targetId: id } });\n";
  write(worktree, "apps/api/app/links/fix.ts", write_);
  runNode(SESSIONS, ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "apps/api/app/links/fix.ts"], home);
  assert.equal(runNode(INVENTORY, ["--worktree", worktree], home).json.blocking.diffRulesClear, true);

  write(worktree, "apps/api/app/links/service.ts", write_);
  const blocked = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.json.blocking.diffRulesClear, false);
  assert.deepEqual(blocked.json.diffRules.blocking.map((finding) => [finding.rule, finding.file]), [["artifact-link-delete", "apps/api/app/links/service.ts"]]);
});

// vibe SKILL.md section 5 runs heavy validation only at handoff; a build-phase
// frozen-render gate held a writer's first commit for hours (2026-10-26).
test("a frozen render is settled at handoff: the build phase reports it without blocking, handoff and pull-request phases block", (t) => {
  const row = "apps/storybook/stories/row.stories.tsx";
  const { home, worktree } = setup(t, "frozen-render-phase", {
    [row]: "import { Row } from \"@repo/design-system/components/row\";\nexport default { title: \"Composites/Row\", tags: [\"v1.0\"] };\nexport const Default = {};\n",
    "packages/design-system/components/row.tsx": "export const Row = 1;\n",
  });
  write(worktree, "packages/design-system/components/row.tsx", "export const Row = 2;\n");
  const build = runNode(INVENTORY, ["--worktree", worktree, "--phase", "build"], home);
  assert.equal(build.json.blocking.diffRulesClear, true, JSON.stringify(build.json.diffRules));
  assert.deepEqual(build.json.diffRules.blocking, []);
  assert.deepEqual(build.json.diffRules.deferredToHandoff.map((finding) => [finding.rule, finding.file]), [["frozen-render", row]]);
  for (const phase of ["handoff", "pull-request"]) {
    const later = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.equal(later.json.blocking.diffRulesClear, false, phase);
    assert.deepEqual(later.json.diffRules.blocking.map((finding) => finding.rule), ["frozen-render"], phase);
    assert.deepEqual(later.json.diffRules.deferredToHandoff, [], phase);
  }
});

test("a new comparator outside the pull-request phase clears with its tie test listed as missing (ISS-13321)", (t) => {
  const { home, worktree } = setup(t, "comparator-tie", { "apps/app/rank.ts": "export const rank = (rows) => rows;\n" });
  write(worktree, "apps/app/rank.ts", "export const rank = (rows) => rows.sort((a, b) => a.n - b.n || a.id.localeCompare(b.id));\n");
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"], home).trim();
  const ties = (phase) => runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home).json.diffRules.blocking.filter((finding) => finding.rule === "comparator-tie");
  assert.match(ties("handoff")[0].fix, /list the tie test under Missing tests, and record `Comparator: <file>: missing test listed`/);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), "Comparator: apps/app/rank.ts: missing test listed\n");
  assert.deepEqual(ties("build"), []);
  assert.deepEqual(ties("handoff"), []);
  assert.equal(ties("pull-request").length, 1, "the pull-request turn writes the tie test");
});


test("root lane metadata is typed without widening path permissions or accepting unknown declaration fields", t => {
  for (const [name, patch] of [["invalid-source", { laneSource: { kind: "environment", name: "LANES" } }],
    ["unknown-field", { laneSources: [] }]]) {
    const policy = { ...JSON.parse(CLAUDE_PLUGIN_POLICY), ...patch };
    const { home, worktree } = setup(t, `lane-${name}`, { [PATH_POLICY]: JSON.stringify(policy) }, {
      repoName: "claude-plugins", declared: false,
    });
    const result = runNode(INVENTORY, ["--worktree", worktree], home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.match(result.json.pathPolicyProblem, /typed laneSource|expected fields/);
  }
});


test("lane source bootstrap admits only metadata for the sole unchanged committed workflow", t => {
  const before = JSON.parse(CLAUDE_PLUGIN_POLICY); delete before.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n";
  const { home, worktree } = setup(t, "lane-source-bootstrap", { [PATH_POLICY]: JSON.stringify(before),
    ".github/workflows/ci.yml": workflow }, { repoName: "claude-plugins", declared: false });
  const after = { ...before, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } };
  write(worktree, PATH_POLICY, JSON.stringify(after));
  const inspect = () => runNode(INVENTORY, ["--worktree", worktree], home).json;
  assert.equal(inspect().blocking.forbiddenPaths, true);
  write(worktree, PATH_POLICY, JSON.stringify({ ...after, allowedPrefixes: [...before.allowedPrefixes, "rogue/"] }));
  assert.equal(inspect().blocking.forbiddenPaths, false);
  write(worktree, PATH_POLICY, JSON.stringify(after));
  write(worktree, ".github/workflows/ci.yml", workflow.replace("node --test", "echo passed"));
  assert.equal(inspect().blocking.forbiddenPaths, false);
});


test("lane source bootstrap rejects ambiguous workflows and replacement of an existing source", t => {
  const legacy = JSON.parse(CLAUDE_PLUGIN_POLICY); delete legacy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n";
  for (const kind of ["ambiguous", "replacement", "command"]) {
    const source = { kind: "github-workflow", path: ".github/workflows/ci.yml" };
    const before = kind === "replacement" ? { ...legacy, laneSource: source } : legacy;
    const files = { [PATH_POLICY]: JSON.stringify(before), ".github/workflows/ci.yml": workflow,
      ...(kind === "ambiguous" ? { ".github/workflows/other.yml": workflow } : {}) };
    const { home, worktree } = setup(t, `lane-bootstrap-${kind}`, files, { repoName: "claude-plugins", declared: false });
    write(worktree, PATH_POLICY, JSON.stringify({ ...legacy, laneSource: kind === "command"
      ? { kind: "command", command: "echo passed" } : kind === "replacement" ? { ...source, path: ".github/workflows/other.yml" } : source }));
    const result = runNode(INVENTORY, ["--worktree", worktree], home).json;
    assert.equal(result.blocking.forbiddenPaths, false);
    assert.deepEqual(result.forbidden, [{ path: PATH_POLICY, status: "M" }]);
  }
});


test("bootstrap refuses a workflow added on fetched main after the writer captured its base", t => {
  const policy = JSON.parse(CLAUDE_PLUGIN_POLICY); delete policy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo pass\n";
  const f = setup(t, "lane-main-moved", { [PATH_POLICY]: JSON.stringify(policy), ".github/workflows/ci.yml": workflow },
    { repoName: "claude-plugins", declared: false });
  write(f.worktree, PATH_POLICY, JSON.stringify({ ...policy, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } }));
  write(f.checkout, ".github/workflows/second.yml", workflow);
  git(f.checkout, ["add", ".github/workflows/second.yml"], f.home);
  git(f.checkout, ["commit", "--quiet", "-m", "parallel workflow"], f.home);
  git(f.checkout, ["push", "origin", "main"], f.home);
  git(f.worktree, ["fetch", "origin"], f.home);
  const result = runNode(INVENTORY, ["--worktree", f.worktree], f.home).json;
  assert.equal(result.blocking.forbiddenPaths, false);
  assert.deepEqual(result.forbidden, [{ path: PATH_POLICY, status: "M" }]);
});


test("metadata bootstrap freshly fetches a compatible moved merge target without relying on an old tracking ref", t => {
  const policy = JSON.parse(CLAUDE_PLUGIN_POLICY); delete policy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo pass\n";
  const f = setup(t, "lane-fresh-target", { [PATH_POLICY]: JSON.stringify(policy), ".github/workflows/ci.yml": workflow },
    { repoName: "claude-plugins", declared: false });
  write(f.worktree, PATH_POLICY, JSON.stringify({ ...policy, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } }));
  const old = git(f.worktree, ["rev-parse", "origin/main"], f.home);
  write(f.checkout, "README.md", "unrelated main change\n");
  git(f.checkout, ["commit", "--quiet", "-am", "advance main"], f.home); git(f.checkout, ["push", "origin", "main"], f.home);
  const target = git(f.checkout, ["rev-parse", "HEAD"], f.home);
  assert.notEqual(target, old);
  const result = runNode(INVENTORY, ["--worktree", f.worktree], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, result.stderr);
  assert.equal(git(f.worktree, ["rev-parse", "origin/main"], f.home), target);
});

for (const kind of ["bytes", "removed", "renamed", "permissions", "source", "mode", "symlink"]) test(`bootstrap rejects fetched target ${kind} changes`, t => {
  const policy = JSON.parse(CLAUDE_PLUGIN_POLICY); delete policy.laneSource;
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo pass\n";
  const f = setup(t, `lane-target-${kind}`, { [PATH_POLICY]: JSON.stringify(policy), ".github/workflows/ci.yml": workflow },
    { repoName: "claude-plugins", declared: false });
  write(f.worktree, PATH_POLICY, JSON.stringify({ ...policy, laneSource: { kind: "github-workflow", path: ".github/workflows/ci.yml" } }));
  const file = path.join(f.checkout, ".github/workflows/ci.yml");
  if (kind === "bytes") writeFileSync(file, workflow.replace("echo pass", "echo changed"));
  if (kind === "removed") git(f.checkout, ["rm", "-q", ".github/workflows/ci.yml"], f.home);
  if (kind === "renamed") git(f.checkout, ["mv", ".github/workflows/ci.yml", ".github/workflows/renamed.yml"], f.home);
  if (kind === "permissions") write(f.checkout, PATH_POLICY, JSON.stringify({ ...policy, rootTests: !policy.rootTests }));
  if (kind === "source") write(f.checkout, PATH_POLICY, JSON.stringify({ ...policy, laneSource: { kind: "command", command: "echo pass" } }));
  if (kind === "mode") chmodSync(file, 0o755);
  if (kind === "symlink") { unlinkSync(file); symlinkSync("../../README.md", file); }
  git(f.checkout, ["add", "-A"], f.home); git(f.checkout, ["commit", "--quiet", "-m", `main ${kind}`], f.home);
  git(f.checkout, ["push", "origin", "main"], f.home); git(f.worktree, ["fetch", "origin"], f.home);
  const result = runNode(INVENTORY, ["--worktree", f.worktree], f.home).json;
  assert.equal(result.blocking.forbiddenPaths, false);
  assert.deepEqual(result.forbidden, [{ path: PATH_POLICY, status: "M" }]);
});

test("an inventory longer than one 64 KiB pipe buffer reaches a spawnSync reader whole, as the handoff gate reads it", (t) => {
  const { home, worktree } = setup(t, "large-inventory");
  mkdirSync(path.join(worktree, "apps", "app", "generated-pages"), { recursive: true });
  for (let index = 0; index < 900; index += 1) {
    write(worktree, `apps/app/generated-pages/a-page-with-a-long-descriptive-file-name-number-${String(index).padStart(4, "0")}.ts`, `export const page${index} = ${index};\n`);
  }
  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "build"], home);
  assert.ok(result.json.changedFiles.length >= 900, "every changed file is listed");
  assert.ok(JSON.stringify(result.json).length > 64 * 1024, "the output is larger than one pipe buffer");
});

// ISS-14682: a frozen v1.0 story a live-ticket criterion authorizes moving or retiring. The base has no
// story-group-order.ts, so the version scheme applies: plain roots and the v1.0 tag are frozen, `<Level> v2.0/` is current.
const FROZEN_ROW = "apps/storybook/stories/row.stories.tsx";
const MOVED_ROW = "apps/storybook/stories/composites-v2/row.stories.tsx";
const FROZEN_CELL = "apps/storybook/stories/cell.stories.tsx";
const ROW_IDS = ["composites-row--default", "composites-row--selected"];
const MOVE_CRITERION = `Size the row to its content; move \`${FROZEN_ROW}\` to the current taxonomy.`;
const ROW_REFERENCE = "apps/app/row.test.ts";

/**
 * A session whose component change reaches the frozen Row story, which it moved to the current taxonomy, and which
 * retitles Cell. `mode` is how the Row story leaves its frozen path: `git mv` ("staged"), a plain rename ("unstaged"),
 * `git rm` ("retired"), or a move whose destination keeps the v1.0 tag ("frozen-destination").
 */
function frozenMoveSession(t, slug, mode = "staged") {
  const story = (title, tags, from = "") => `${from}export default { title: "${title}", tags: [${tags.map((tag) => `"${tag}"`).join(", ")}] };\nexport const Default = {};\nexport const Selected = {};\n`;
  const imports = 'import { Row } from "@repo/design-system/components/row";\n';
  const session = setup(t, slug, {
    [FROZEN_ROW]: story("Composites/Row", ["v1.0"], imports),
    [FROZEN_CELL]: story("Composites/Cell", ["v1.0"]),
    "packages/design-system/components/row.tsx": "export const Row = 1;\n",
    // A test elsewhere that still opens a retired story by ID.
    ...(mode === "retired" ? { [ROW_REFERENCE]: 'test("opens composites-row--selected", () => {});\n' } : {}),
  });
  const { home, worktree } = session;
  write(worktree, "packages/design-system/components/row.tsx", "export const Row = 2;\n");
  mkdirSync(path.join(worktree, "apps/storybook/stories/composites-v2"), { recursive: true });
  if (mode === "retired") git(worktree, ["rm", "-q", FROZEN_ROW], home);
  else if (mode === "unstaged") renameSync(path.join(worktree, FROZEN_ROW), path.join(worktree, MOVED_ROW));
  else git(worktree, ["mv", FROZEN_ROW, MOVED_ROW], home);
  if (mode !== "retired") write(worktree, MOVED_ROW, story("Composites v2.0/Row", [mode === "frozen-destination" ? "v1.0" : "v2.0"], imports));
  write(worktree, FROZEN_CELL, story("Composites/Cell Renamed", ["v1.0"]));
  const ticket = "ISS-123";
  assert.equal(runNode(SESSIONS, ["touch", "--worktree", worktree, "--live-ticket", ticket], home).status, 0);
  const evidence = runNode(path.resolve(HERE, "../../vibe/scripts/session-plan.mjs"), ["paths", "--worktree", worktree], home).json;
  mkdirSync(evidence.root, { recursive: true });
  const saveRead = (content) => {
    writeFileSync(evidence.liveTicketDocument, JSON.stringify({ slug: ticket, latestVersion: 2, version: { version: 2, content } }));
    writeFileSync(evidence.liveTicket, content);
  };
  saveRead(`## Acceptance criteria\n\n- [ ] ${MOVE_CRITERION}\n- [ ] Keep the cell's label.\n`
    + `- [ ] Move \`${FROZEN_CELL}\` to the current taxonomy.\n- [ ] Frozen v1.0 stories must not be moved or retired.\n`
    + "- [ ] Retire the composites-row--default story and its siblings.\n"
    + `- [ ] Do not move \`${FROZEN_ROW}\`; keep its frozen renders.\n`);
  const authorize = (criterion, file = FROZEN_ROW) =>
    runNode(SESSIONS, ["frozen-story-move", "--worktree", worktree, "--path", file, "--criterion", criterion], home);
  const inventory = (...args) => runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff", ...args], home).json;
  return { ...session, ticket, evidence, saveRead, authorize, inventory };
}

test("ISS-14682 AC4: an AC-authorized frozen story move passes and is listed with its ticket and criterion", (t) => {
  const { home, worktree, ticket, evidence, authorize, inventory } = frozenMoveSession(t, "frozen-move-authorized");
  const before = inventory();
  assert.deepEqual(before.v1Stories.map((story) => story.path).sort(), [FROZEN_CELL, MOVED_ROW]);
  assert.deepEqual(before.diffRules.blocking.filter((finding) => finding.rule === "frozen-render").map((finding) => finding.file), [FROZEN_ROW]);
  const recorded = authorize("AC-1");
  assert.equal(recorded.status, 0, recorded.stderr);
  const after = inventory();
  assert.deepEqual(after.frozenStoryMoves, [{ path: FROZEN_ROW, to: MOVED_ROW, kind: "moved", ticket, criterion: "AC-1", version: 2,
    storyIds: ROW_IDS, disclosures: ROW_IDS.map((id) => `Frozen story moved: \`${id}\` (${ticket} AC-1).`) }]);
  assert.equal(after.frozenStoryMoveProblems, undefined);
  assert.deepEqual(after.v1Stories.map((story) => story.path), [FROZEN_CELL]);
  assert.deepEqual(after.retitledStories.map((story) => story.path), [FROZEN_CELL]);
  assert.deepEqual(after.diffRules.blocking.filter((finding) => ["frozen-render", "lost-story-id"].includes(finding.rule)
    && [FROZEN_ROW, MOVED_ROW].includes(finding.file)), []);
  // ISS-14682 AC3: the pull request body lists each moved story ID with its ticket and criterion.
  const prs = path.join(home, "prs.json");
  writeFileSync(prs, "[]");
  const bodyProblems = () => runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request", "--body", evidence.prBody, "--prs-json", prs], home)
    .json.prBodyProblems.filter((problem) => problem.includes("Frozen story moved:"));
  writeFileSync(evidence.prBody, "Moves the Row story.\n");
  assert.deepEqual(bodyProblems(), after.frozenStoryMoves[0].disclosures.map((line) => `PR body must include: ${line}`));
  writeFileSync(evidence.prBody, `Moves the Row story.\n\n${after.frozenStoryMoves[0].disclosures.map((line) => `- ${line}`).join("\n")}\n`);
  assert.deepEqual(bodyProblems(), []);
});

test("ISS-14682 AC4: a frozen story title change without an authorizing criterion is still blocked", (t) => {
  const { authorize, inventory } = frozenMoveSession(t, "frozen-move-unauthorized");
  assert.equal(authorize("AC-1").status, 0);
  // The criterion authorizes the Row move only; Cell's retitle is recorded nowhere and still blocks as before.
  const result = inventory();
  assert.equal(result.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.v1Stories, [{ path: FROZEN_CELL, status: "M", reasons: ["frozen"] }]);
  assert.equal(result.blocking.existingStoryTitlesKept, false);
  // A criterion that never speaks of moving or retiring a story authorizes nothing.
  const refused = authorize("AC-2", FROZEN_CELL);
  assert.equal(refused.status, 1);
  assert.ok(refused.json.error.includes(`criterion ISS-123 AC-2 ("Keep the cell's label.") does not authorize moving or retiring the story ${FROZEN_CELL}`), refused.json.error);
  assert.deepEqual(inventory().v1Stories, [{ path: FROZEN_CELL, status: "M", reasons: ["frozen"] }]);
});

test("ISS-14682 AC4: an authorization naming a missing criterion is refused, at record time and when the ticket changes", (t) => {
  const { authorize, inventory, saveRead } = frozenMoveSession(t, "frozen-move-missing");
  const refused = authorize("AC-9");
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /the live ticket has no criterion AC-9/);
  assert.equal(authorize("AC-1").status, 0);
  saveRead("## Acceptance criteria\n\n- [ ] Keep the cell's label.\n");
  const result = inventory();
  assert.deepEqual(result.frozenStoryMoves, []);
  assert.deepEqual(result.frozenStoryMoveProblems, [`frozen story move ${FROZEN_ROW}: criterion AC-1 changed since it was recorded; record the move again`]);
  assert.ok(result.v1Stories.some((story) => story.path === MOVED_ROW));
  saveRead("## Acceptance criteria\n\nNone yet.\n");
  assert.deepEqual(inventory().frozenStoryMoveProblems, [`frozen story move ${FROZEN_ROW}: the live ticket has no criterion AC-1`]);
});

test("ISS-14682 AC2: a criterion naming a different story, or forbidding moves, authorizes nothing", (t) => {
  const { authorize, inventory } = frozenMoveSession(t, "frozen-move-other-story");
  for (const criterion of ["AC-3", "AC-4"]) {
    const refused = authorize(criterion);
    assert.equal(refused.status, 1, criterion);
    assert.match(refused.json.error, new RegExp(`criterion ISS-123 ${criterion} \\(".+"\\) does not name apps/storybook/stories/row\\.stories\\.tsx or one of its story IDs`));
  }
  const result = inventory();
  assert.deepEqual(result.frozenStoryMoves, []);
  assert.ok(result.v1Stories.some((story) => story.path === MOVED_ROW));
});

test("ISS-14682 AC1: an AC-authorized retirement lifts the story's own blocks and is listed in every phase; a stale reference still blocks", (t) => {
  const { home, worktree, ticket, authorize, inventory } = frozenMoveSession(t, "frozen-move-retired", "retired");
  // AC-5 names the story by one of its IDs rather than its path.
  const recorded = authorize("AC-5");
  assert.equal(recorded.status, 0, recorded.stderr);
  const after = inventory();
  assert.deepEqual(after.frozenStoryMoves, [{ path: FROZEN_ROW, kind: "retired", ticket, criterion: "AC-5", version: 2,
    storyIds: ROW_IDS, disclosures: ROW_IDS.map((id) => `Frozen story retired: \`${id}\` (${ticket} AC-5).`) }]);
  const lost = after.diffRules.blocking.filter((finding) => finding.rule === "lost-story-id");
  assert.deepEqual(lost.map((finding) => finding.file), [ROW_REFERENCE]);
  assert.match(lost[0].problem, /still names the removed or renamed story ID composites-row--selected/);
  assert.deepEqual(runNode(INVENTORY, ["--worktree", worktree, "--phase", "build"], home).json.frozenStoryMoves, after.frozenStoryMoves);
});

test("ISS-14682 AC1: a move not yet staged is listed as a move, and the worktree's index is left alone", (t) => {
  const { home, worktree, authorize, inventory } = frozenMoveSession(t, "frozen-move-unstaged", "unstaged");
  assert.equal(authorize("AC-1").status, 0);
  const index = git(worktree, ["ls-files", "--stage"], home);
  const result = inventory();
  assert.deepEqual(result.frozenStoryMoves.map((move) => [move.kind, move.to]), [["moved", MOVED_ROW]]);
  assert.equal(result.frozenStoryMoveProblems, undefined);
  assert.equal(git(worktree, ["ls-files", "--stage"], home), index);
});

test("ISS-14682 AC2: a recorded move is refused for a story not frozen at the base, a still-frozen or unversioned destination, or another story's criterion", () => {
  const BADGE = "apps/storybook/stories/badge.stories.tsx";
  const story = (title, tags) => `export default { title: "${title}", tags: [${tags.map((tag) => `"${tag}"`).join(", ")}] };\nexport const Default = {};\n`;
  const base = { [FROZEN_ROW]: story("Composites/Row", ["v1.0"]), [BADGE]: story("Composites v2.0/Badge", ["v2.0"]) };
  const move = (file) => `Move \`${file}\` to the current taxonomy.`;
  const live = { ticket: "ISS-1", version: 1, criteria: [{ id: "AC-1", text: move(FROZEN_ROW) }, { id: "AC-2", text: move(BADGE) }, { id: "AC-3", text: move(FROZEN_CELL) }] };
  const resolve = (path, cites, head) => resolveFrozenStoryMoves({ entries: [{ path, cites, ticket: "ISS-1", text: live.criteria.find((row) => row.id === cites).text }],
    live, scheme: storybookSchemeOf(null), readBase: (file) => base[file], readHead: (file) => head[file], movedTo: () => MOVED_ROW });
  const refused = (destination) => `frozen story move ${FROZEN_ROW}: ${destination} does not give it a new current-taxonomy title`;
  assert.equal(resolve(FROZEN_ROW, "AC-1", { [MOVED_ROW]: story("Composites v2.0/Row", ["v2.0"]) }).moves.length, 1);
  assert.deepEqual(resolve(FROZEN_ROW, "AC-1", { [MOVED_ROW]: story("Composites v2.0/Row", ["v1.0"]) }).problems, [refused(MOVED_ROW)]);
  assert.deepEqual(resolve(FROZEN_ROW, "AC-1", { [MOVED_ROW]: story("Composites/Row Moved", []) }).problems, [refused(MOVED_ROW)]);
  assert.deepEqual(resolve(FROZEN_ROW, "AC-1", { [MOVED_ROW]: story("Start Here/Row", []) }).problems, [refused(MOVED_ROW)]);
  assert.deepEqual(resolve(BADGE, "AC-2", {}).problems, [`frozen story move ${BADGE}: it is not a frozen v1.0 story at the base`]);
  assert.deepEqual(resolve(FROZEN_ROW, "AC-3", { [MOVED_ROW]: story("Composites v2.0/Row", ["v2.0"]) }).problems,
    [`frozen story move ${FROZEN_ROW}: criterion ISS-1 AC-3 ("${move(FROZEN_CELL)}") does not name ${FROZEN_ROW} or one of its story IDs`]);
});

/** The refusal of criterion `cites` of `ticket`, quoting its `text` as read, for the story at `story`. */
const REFUSED_MOVE = (cites, text, ticket = "ISS-1", story = FROZEN_ROW) =>
  `criterion ${ticket} ${cites} ("${text}") does not move or retire the story ${story} as the direct object of an affirmative instruction, or carries a negation, exclusion or condition, so it authorizes nothing`;

test("ISS-14682 AC1: a criterion that names the story but negates the move authorizes nothing; a positive one on the same story still does", (t) => {
  const { authorize, inventory } = frozenMoveSession(t, "frozen-move-negated");
  const refused = authorize("AC-6");
  assert.equal(refused.status, 1);
  // The refusal names the story and the criterion as read, so the person can reword it.
  assert.ok(refused.json.error.includes(REFUSED_MOVE("AC-6", `Do not move \`${FROZEN_ROW}\`; keep its frozen renders.`, "ISS-123")), refused.json.error);
  assert.deepEqual(inventory().frozenStoryMoves, []);
  assert.equal(authorize("AC-1").status, 0);
  assert.deepEqual(inventory().frozenStoryMoves.map((move) => [move.path, move.criterion]), [[FROZEN_ROW, "AC-1"]]);
});

test("ISS-14682 AC1: moveCriterion authorizes a story only as the direct object of an affirmative move, retire or rename instruction, in a criterion with no negation, exclusion, condition or temporal gate", () => {
  const named = `\`${FROZEN_ROW}\``;
  const other = "`apps/storybook/stories/cell.stories.tsx`";
  const check = (text, names = [FROZEN_ROW, ...ROW_IDS]) => moveCriterion([{ id: "AC-1", text }], "AC-1", names, "ISS-1");
  const destination = `\`${MOVED_ROW}\``;
  const renamed = "`apps/storybook/stories/row-renamed.stories.tsx`";
  for (const text of [`Do not move ${named}.`, `Don't move ${named} to the current taxonomy.`, `Never retire the story ${named}.`,
    `The story ${named} must not be moved.`, `Size the row without moving or retiring the story ${named}.`,
    `The story ${named} should not be retired.`, `The story ${named} is not to be moved or retired.`,
    `No story moves for ${named}.`, `Moving the story ${named} is forbidden.`, `Keep the story ${named}; it can’t be moved.`,
    // Negations and exclusions after the move word, or further back than a few words (round-3 review probes).
    `Moving the story ${named} must not happen.`, `Moving the story ${named} is out of scope.`,
    `The story ${named} stays frozen; moving it is not required.`, `Retiring the story ${named} is not part of this ticket.`,
    `Avoid moving the story ${named}.`, `Keep the story ${named} as is rather than moving it.`,
    `None of the frozen stories, including ${named}, may be moved.`, `Do not under any circumstances whatsoever move the story ${named}.`,
    `Move the story ${other} instead of the story ${named}.`,
    // The story is named only outside the clause that moves another one, or kept in it.
    `Move the story ${other} to the current taxonomy; ${named} stays unchanged.`,
    `Move the story ${other} to the current taxonomy and keep ${named} frozen.`,
    // Conservative by ruling: an aside with a negation refuses too.
    `Retire the story ${named}, which is no longer used.`,
    // Round-4 review probes: a heading or trailing word that scopes the move out, unlisted wording that defers it, and
    // a second story in the same clause. None is an affirmative instruction naming only this story.
    `Out of scope: moving the story ${named}.`, `Not in this ticket: retire the story ${named}.`, `Non-goal: moving the story ${named}.`,
    `Deferred to a follow-up: moving the story ${named}.`, `Moving the story ${named}: never.`, `Excluded (move the story ${named}).`,
    `Moving the story ${named} is a non-goal.`, `Moving the story ${named} is out of the scope of this ticket.`,
    `Moving the story ${named} is outside this ticket.`, `Moving the story ${named} must wait for ISS-1.`,
    `Moving the story ${named} is blocked until ISS-1 ships.`, `Moving the story ${named} is optional and deferred.`,
    `Move the story ${other} to the current taxonomy, ${named} is unchanged.`,
    `Move the story ${other} to the current taxonomy and leave ${named} frozen.`,
    `Move the story ${other} to the current taxonomy while ${named} is untouched.`,
    `Retire the story ${other} unless ${named} is retired first.`,
    `Move the story ${named} to the current taxonomy, ${other} is unchanged.`,
    `Move the story ${named} and leave composites-cell--default frozen.`,
    // A colon no longer ends a clause, a newline does not either, and a question is no instruction.
    `${named} is moved? No.`, `Story ${named} is moved? No.`,
    // Round-5 residuals (ruling, 2026-11-24): a deny or condition token anywhere in the criterion refuses, and the
    // story must be the verb's object, with no "and", destination or path before it.
    `Move ${named} - skip this one.`, `Move ${named} if the design team approves it.`, `Out of scope. Move the story ${named}.`,
    `Not in this ticket; retire the story ${named}.`, `Move the padding token into the theme and update ${named}.`,
    `Move the story ${named} to the current taxonomy. Deferred to a follow-up.`, `Move the padding token into ${named}.`,
    `Move ${other} and ${named} to the current taxonomy.`,
    // Formerly authorized: the whole criterion now carries the deny token.
    `Never change frozen renders; move the story ${named} to the current taxonomy instead.`,
    `Move the story ${named} to the current taxonomy; ${other} stays unchanged.`,
    // Round-6 rulings (team lead, 2026-11-24): a temporal gate refuses; the story must be the verb's direct object, so
    // refactor wording about something inside the story file authorizes nothing; spelling variants of listed tokens refuse.
    `Retire the story ${named} after ISS-1 ships.`, `Move the story ${named} to the current taxonomy before the release.`,
    `Move the mock rows out of ${named} into \`row-fixtures.ts\`.`, `Move the inline styles in ${named} to theme tokens.`,
    `Retire the decorator in ${named}.`, `Rename the \`Primary\` export in ${named} to \`Default\`.`,
    `Retire the \`Selected\` story of ${named}.`, `Move the padding token then update ${named}.`,
    `Move the story ${named} to the current taxonomy (descoped).`, `Move the story ${named} to the current taxonomy (de-scoped).`,
    `Move the story ${named} to the current taxonomy (out-of-scope).`, `Move the story ${named} to the current taxonomy in a follow up.`,
    `Move the story ${named} to the current taxonomy (non goal).`,
    // Round-6 confirmation probes: a word after the story that makes it a modifier or possessive, so the verb moves
    // something inside the file. Only the clause's end, punctuation, "to", "into", "under" or "and" may follow it.
    `Move the ${named} fixtures to a shared module.`, `Retire the ${named} decorator.`,
    `Move ${named}'s mock rows into \`row-fixtures.ts\`.`, "Move the composites-row--default story args to `row-fixtures.ts`.",
    // Only story file paths and this story's own names are masked before the deny check, so a deny word joined to
    // another by a double hyphen still refuses.
    `Move the story ${named} to the current taxonomy. Do this later--after the release.`]) {
    assert.deepEqual(check(text), { problem: REFUSED_MOVE("AC-1", text) }, text);
  }
  for (const text of [`Move the story ${named} to the current taxonomy.`, `Retire the story ${named}.`, MOVE_CRITERION,
    `Rename the story ${named} to Composites/Row.`, `Move ${named} to ${destination}.`, `Rename the story ${named} to ${renamed}.`,
    `Move the story ${named} into ${destination}.`, `${named} is moved to ${destination}.`, `- [ ] Move ${named} to the current taxonomy.`,
    `AC-1: Retire the story ${named}.`, `1. Move the story ${named} to the current taxonomy.`,
    `${named} is moved to the current taxonomy.`, `${named} is retired.`, `${named} moves to the current taxonomy.`,
    `${named} is renamed to Composites/Row.`, "Retire the composites-row--default and composites-row--selected stories.",
    `Retire the frozen v1.0 story file ${named}.`, `Move the stories in ${named} to the current taxonomy.`]) {
    assert.equal(check(text).problem, undefined, text);
  }
  // A destination after "to", "into" or "under" is never itself authorized; only the moved story is.
  for (const [text, story] of [[`Move ${named} to ${destination}.`, MOVED_ROW], [`Rename the story ${named} to ${renamed}.`,
    "apps/storybook/stories/row-renamed.stories.tsx"], [`${named} is moved to ${destination}.`, MOVED_ROW]]) {
    assert.deepEqual(check(text, [story]), { problem: REFUSED_MOVE("AC-1", text, "ISS-1", story) }, text);
  }
});

test("ISS-14682 AC1: a deny word inside a story's own path or story ID does not refuse, and one elsewhere in the criterion still does", () => {
  const pending = "apps/storybook/stories/feature-flag-pending.stories.tsx";
  const names = [pending, "feedback-feature-flag-pending--default"];
  const check = (text) => moveCriterion([{ id: "AC-1", text }], "AC-1", names, "ISS-1");
  for (const text of [`Move \`${pending}\` to the current taxonomy.`, `Retire the story \`${pending}\`.`,
    "Retire the story feedback-feature-flag-pending--default.",
    `Move \`${pending}\` to \`apps/storybook/stories/feedback/feature-flag-pending.stories.tsx\`.`]) {
    assert.equal(check(text).problem, undefined, text);
  }
  for (const text of [`Move \`${pending}\` to the current taxonomy pending design review.`,
    `Retire the story \`${pending}\` if design approves.`]) {
    assert.deepEqual(check(text), { problem: REFUSED_MOVE("AC-1", text, "ISS-1", pending) }, text);
  }
});

test("ISS-14682 AC1: a sub-bullet under a criterion's box feeds only the deny check, through the real ticket reader", () => {
  const box = `- [ ] Move the story \`${FROZEN_ROW}\` to the current taxonomy.`;
  const check = (body) => moveCriterion(ticketMoveCriteria(`## Acceptance criteria\n\n${body}\n`), "AC-1", [FROZEN_ROW], "ISS-1");
  const text = `Move the story \`${FROZEN_ROW}\` to the current taxonomy.`;
  // The reader returns the box text alone; the sub-bullets below it still refuse.
  assert.deepEqual(ticketMoveCriteria(`## Acceptance criteria\n\n${box}\n  - only if design approves\n`).map((row) => [row.id, row.text]), [["AC-1", text]]);
  for (const nested of ["  - only if design approves", "  - not in this release", "  * deferred to a follow-up", "  - blocked--waiting on design"]) {
    assert.deepEqual(check(`${box}\n${nested}`), { problem: REFUSED_MOVE("AC-1", text) }, nested);
  }
  assert.equal(check(box).problem, undefined);
  assert.equal(check(`${box}\n  - bump the Storybook version`).problem, undefined);
  // A sub-bullet never authorizes: the box itself must move the story.
  assert.match(check(`- [ ] Size the row to its content.\n  - Move the story \`${FROZEN_ROW}\` to the current taxonomy.`).problem,
    /\("Size the row to its content\."\) does not authorize moving or retiring the story/);
  // The next sibling box ends the sub-bullets.
  assert.equal(check(`${box}\n- [ ] Keep the cell's label; it is not moved.`).problem, undefined);
});

test("ISS-14682 AC1: the gate's refusal of a recorded move names the story and the criterion it read, for each refused shape", () => {
  const story = (title, tags) => `export default { title: "${title}", tags: [${tags.map((tag) => `"${tag}"`).join(", ")}] };\nexport const Default = {};\n`;
  const base = { [FROZEN_ROW]: story("Composites/Row", ["v1.0"]), [FROZEN_CELL]: story("Composites/Cell", ["v1.0"]) };
  const head = { [MOVED_ROW]: story("Composites v2.0/Row", ["v2.0"]), "apps/storybook/stories/composites-v2/cell.stories.tsx": story("Composites v2.0/Cell", ["v2.0"]) };
  const row = `\`${FROZEN_ROW}\``;
  const cell = `\`${FROZEN_CELL}\``;
  const resolve = (path, text) => resolveFrozenStoryMoves({ entries: [{ path, cites: "AC-1", ticket: "ISS-1", text }],
    live: { ticket: "ISS-1", version: 1, criteria: [{ id: "AC-1", text }] }, scheme: storybookSchemeOf(null),
    readBase: (file) => base[file], readHead: (file) => head[file],
    movedTo: (file) => (file === FROZEN_ROW ? MOVED_ROW : "apps/storybook/stories/composites-v2/cell.stories.tsx") });
  for (const text of [`Do not move the story ${row}.`, `Moving the story ${row} is out of scope.`, `Avoid moving the story ${row}.`,
    `Retire the story ${row}, which is no longer used.`]) {
    assert.deepEqual(resolve(FROZEN_ROW, text), { moves: [], problems: [`frozen story move ${FROZEN_ROW}: ${REFUSED_MOVE("AC-1", text)}`] }, text);
  }
  // One criterion: the story it renames is authorized, its destination is refused by name.
  const both = `Rename the story ${row} to ${cell}.`;
  assert.deepEqual(resolve(FROZEN_ROW, both).moves.map((move) => [move.path, move.kind, move.criterion]), [[FROZEN_ROW, "moved", "AC-1"]]);
  assert.deepEqual(resolve(FROZEN_CELL, both).problems, [`frozen story move ${FROZEN_CELL}: ${REFUSED_MOVE("AC-1", both, "ISS-1", FROZEN_CELL)}`]);
  // A deny token anywhere in the criterion refuses every story it names.
  const kept = `Move the story ${row} to the current taxonomy; ${cell} stays unchanged.`;
  assert.deepEqual(resolve(FROZEN_ROW, kept).problems, [`frozen story move ${FROZEN_ROW}: ${REFUSED_MOVE("AC-1", kept)}`]);
});
