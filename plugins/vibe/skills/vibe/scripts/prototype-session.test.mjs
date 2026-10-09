import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, portableSurfaceChecker, runNode } from "./test-fixtures.mjs";
import { checkLiveTicket, parseSections, TICKET_SECTIONS } from "../../handoff/scripts/live-ticket-check.mjs";
import { isOwnedPrototypeSession, validatePrototypePublication } from "./prototype-session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS = path.join(HERE, "vibe-sessions.mjs");
const INVENTORY = path.join(HERE, "../../handoff/scripts/handoff-inventory.mjs");
const CHECK = path.join(HERE, "../../handoff/scripts/live-ticket-check.mjs");
const OPERATOR = ["--operator-id", "user-andy", "--operator-email", "andy@example.com"];

function setup(t, files = {}) {
  const fixture = makeHome("vibe-prototype-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "checkout with spaces");
  makeCheckout({ ...fixture, checkout, files });
  const created = runNode(SESSIONS, ["new-prototype", "--repo", checkout,
    "--slug", "board-mockup", "--summary", "Board mockup", ...OPERATOR], fixture.home);
  assert.equal(created.status, 0, JSON.stringify(created.json));
  const worktree = created.json.session.worktree;
  const privateDir = git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home);
  return { ...fixture, checkout, worktree, privateDir, record: created.json.session };
}

function publish(fixture, overrides = {}) {
  const file = path.join(fixture.privateDir, "prototype-result.json");
  writeFileSync(file, JSON.stringify({ slug: "board-mockup",
    previewUrl: "https://prototypes-abc123.preview.closedloop-stage.ai/p/board-mockup",
    deployedCommit: git(fixture.worktree, ["rev-parse", "HEAD"], fixture.home),
    ...overrides }));
  return runNode(SESSIONS, ["prototype-result", "--worktree", fixture.worktree, "--file", file], fixture.home);
}

function write(fixture, file) {
  const target = path.join(fixture.worktree, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "export const value = 1;\n");
}

test("owned mockups create and resume without app data, flags, or fabricated URLs", (t) => {
  const fixture = setup(t);
  assert.equal(fixture.record.branch, "prototype/board-mockup");
  assert.equal(fixture.record.mode, null);
  assert.equal(fixture.record.vercel, null);
  assert.equal(fixture.record.flagSnapshot, null);
  git(fixture.checkout, ["worktree", "add", "-b", "prototype/unowned", path.join(fixture.root, "unowned")], fixture.home);
  const listed = runNode(SESSIONS, ["list", "--repo", fixture.checkout], fixture.home);
  assert.deepEqual(listed.json.sessions.map((record) => record.branch), [fixture.record.branch]);
  assert.equal(listed.json.sessions[0].vercel, null);
  assert.equal(runNode(SESSIONS, ["touch", "--worktree", fixture.worktree, "--mode", "blank"], fixture.home).status, 1);
  assert.equal(runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home).status, 1);
  assert.equal(runNode(SESSIONS, ["dispatch-inputs", "--worktree", fixture.worktree, "--out", path.join(fixture.root, "inputs.json")], fixture.home).status, 1);
});

test("publication checks slug, full HEAD, immutable URL, and timestamp before storage", (t) => {
  const fixture = setup(t);
  for (const overrides of [
    { slug: "other" }, { deployedCommit: "a".repeat(40) },
    { deployedCommit: "abc123" }, { previewUrl: "https://prototypes-git-prototype-board-mockup.vercel.app/p/board-mockup" },
    { previewUrl: "https://prototypes-git-prototype-board-mockup.preview.closedloop-stage.ai/p/board-mockup" },
    { previewUrl: "https://prototypes.preview.closedloop-stage.ai/p/board-mockup" },
    { previewUrl: "http://prototypes-abc123.vercel.app/p/board-mockup" },
    { previewUrl: "https://prototypes-abc123.vercel.app/p/other" },
    { verifiedAt: "bad-date" },
    { verifiedAt: null },
  ]) {
    assert.equal(publish(fixture, overrides).status, 1, JSON.stringify(overrides));
  }
  const saved = publish(fixture);
  assert.equal(saved.status, 0, JSON.stringify(saved.json));
  assert.equal(saved.json.session.prototype.deployedCommit, git(fixture.worktree, ["rev-parse", "HEAD"], fixture.home));
  assert.ok(saved.json.session.prototype.verifiedAt);
  assert.equal(saved.json.session.vercel, null);
  const persisted = JSON.parse(readFileSync(path.join(fixture.privateDir, "vibe-session.json"), "utf8"));
  assert.deepEqual(persisted.prototype, saved.json.session.prototype);
  assert.equal(publish(fixture, { previewUrl: "https://prototypes-abc123-team.vercel.app/p/board-mockup" }).status, 0);
  assert.equal(publish(fixture).status, 0);
  assert.equal(isOwnedPrototypeSession(persisted, "prototype/other"), false);
  assert.throws(() => validatePrototypePublication(persisted.prototype, { ...persisted, operator: null }, persisted.prototype.deployedCommit));
});

test("prototype inventory admits only its sandbox host and canonical shared paths", (t) => {
  const checker = "apps/prototypes/scripts/check-catalog-imports.mjs";
  const fixture = setup(t, { [checker]: portableSurfaceChecker() });
  assert.equal(publish(fixture).status, 0);
  for (const file of ["apps/prototypes/app/p/board-mockup/page.tsx",
    "apps/prototypes/lib/registry.generated.ts",
    "packages/app/board/components/board-preview.tsx", "packages/app/board/components/board-preview.stories.tsx"]) {
    write(fixture, file);
  }
  writeFileSync(path.join(fixture.worktree, checker), portableSurfaceChecker(["@repo/app/board/components/board-preview"]));
  const inventory = runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home);
  assert.equal(inventory.status, 0, JSON.stringify(inventory.json));
  assert.deepEqual(inventory.json.outsideAllowed, []);
  assert.equal(inventory.json.backendChanged, false);
  assert.deepEqual(inventory.json.componentsWithoutStories, []);
  write(fixture, "apps/prototypes/app/p/unrelated/page.tsx");
  assert.deepEqual(runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home).json.outsideAllowed,
    [{ path: "apps/prototypes/app/p/unrelated/page.tsx", status: "A" }]);
  git(fixture.worktree, ["add", "apps/prototypes/app/p/board-mockup/page.tsx"], fixture.home);
  git(fixture.worktree, ["commit", "-m", "iterate"], fixture.home);
  const stale = runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home);
  assert.equal(stale.status, 1);
  assert.equal(stale.json.blocking.prototypePublicationCurrent, false);
  assert.ok(stale.json.baseCommit);
  assert.ok(stale.json.changedFiles.length > 0);
  assert.equal(publish(fixture).status, 0);
});

test("handoff validates owned publication and session ids without weakening app tickets", (t) => {
  const fixture = setup(t);
  runNode(SESSIONS, ["codex-sessions", "--worktree", fixture.worktree, "--thread", "thread-prototype"], fixture.home);
  runNode(SESSIONS, ["touch", "--worktree", fixture.worktree, "--live-ticket", "ISS-123"], fixture.home);
  const publication = publish(fixture).json.session;
  const sections = parseSections(runNode(SESSIONS, ["ticket-sections", "--worktree", fixture.worktree], fixture.home).json.markdown);
  const designReview = [
    `- Canonical prototype preview: ${publication.prototype.previewUrl} at ${publication.prototype.deployedCommit}.`,
    "- App/Storybook: not independently published by this synthetic fixture.",
    "- Scope: mockup only; source/catalog inventory is synthetic.",
    "- Visual inspection: not performed; protection and appearance remain unverified.",
  ].join("\n");
  sections.set("Design Review", designReview);
  const body = TICKET_SECTIONS.map((heading) => `## ${heading}\n\n${sections.get(heading) ?? "None."}\n`).join("\n");
  const file = path.join(fixture.privateDir, "ticket.md");
  writeFileSync(file, body);
  const currentHead = git(fixture.worktree, ["rev-parse", "HEAD"], fixture.home);
  const checked = runNode(CHECK, ["--file", file, "--worktree", fixture.worktree, "--base-commit", currentHead], fixture.home);
  assert.equal(checked.status, 0, JSON.stringify(checked.json));
  assert.equal(checkLiveTicket(body).ok, false, "app tickets still need App, API, Storybook and flags");
  assert.equal(checkLiveTicket(body, { record: publication, headSha: "a".repeat(40) }).ok, false);
  const unverified = { ...publication, prototype: { ...publication.prototype, verifiedAt: undefined } };
  assert.equal(checkLiveTicket(body, { record: unverified, headSha: currentHead }).ok, false);
  assert.equal(checkLiveTicket(body.replace(publication.prototype.previewUrl, "https://other.vercel.app/p/board-mockup"),
    { record: publication, headSha: currentHead }).ok, false);
  assert.equal(checkLiveTicket(body.replace("thread-prototype", ""), { record: publication, headSha: currentHead }).ok, false);
  assert.equal(checkLiveTicket(body, { record: publication, headSha: currentHead, branch: "prototype/other" }).ok, false);
  const handedOff = runNode(SESSIONS, ["touch", "--worktree", fixture.worktree, "--status", "handed-off"], fixture.home);
  assert.equal(handedOff.json.session.liveTicket, "ISS-123");
  assert.equal(runNode(SESSIONS, ["discard", "--worktree", fixture.worktree, "--confirm"], fixture.home).status, 1);
});

test("prototype creation refuses a canonical slug collision and invalid app-only options", (t) => {
  const fixture = setup(t, { "apps/prototypes/app/p/existing/page.tsx": "export const page = 1;\n" });
  for (const [slug, extra] of [["existing", []], ["1-invalid", []], ["new-mock", ["--mode", "seeded"]]]) {
    const created = runNode(SESSIONS, ["new-prototype", "--repo", fixture.checkout,
      "--slug", slug, "--summary", "Mockup", ...OPERATOR, ...extra], fixture.home);
    assert.equal(created.status, 1, slug);
    assert.equal(git(fixture.checkout, ["branch", "--list", `prototype/${slug}`], fixture.home), "");
  }
});

test("pushed prototype discard deletes only its owned branch and never requests schema cleanup", (t) => {
  const fixture = setup(t);
  git(fixture.worktree, ["push", "origin", fixture.record.branch], fixture.home);
  const preview = runNode(SESSIONS, ["discard", "--worktree", fixture.worktree], fixture.home);
  assert.equal(preview.json.wouldLose.pushed, true);
  const discarded = runNode(SESSIONS, ["discard", "--worktree", fixture.worktree, "--confirm"], fixture.home);
  assert.equal(discarded.status, 0, JSON.stringify(discarded.json));
  assert.equal(discarded.json.schemaCleanupRequested, false);
  assert.equal(discarded.json.remoteBranchDeleted, true);
  assert.equal(git(fixture.checkout, ["ls-remote", "--heads", "origin", fixture.record.branch], fixture.home), "");
});

test("publication refuses a worktree switched away from its ownership record", (t) => {
  const fixture = setup(t);
  git(fixture.worktree, ["switch", "-c", "prototype/other"], fixture.home);
  const saved = publish(fixture);
  assert.equal(saved.status, 1);
  assert.match(saved.json.error, /not on its owned prototype branch/);
  assert.equal(runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home).status, 1);
});

test("unpublished prototype inventory remains complete so handoff can route canonical sharing", (t) => {
  const fixture = setup(t);
  write(fixture, "apps/prototypes/app/p/board-mockup/page.tsx");
  const inventory = runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home);
  assert.equal(inventory.status, 1);
  assert.equal(inventory.json.blocking.prototypePublicationCurrent, false);
  assert.match(inventory.json.publicationProblem, /no verified canonical publication/);
  assert.ok(inventory.json.baseCommit);
  assert.deepEqual(inventory.json.changedFiles, [{ path: "apps/prototypes/app/p/board-mockup/page.tsx", status: "A" }]);
});

test("an unrelated prunable worktree cannot break owned session discovery", (t) => {
  const fixture = setup(t);
  const unrelated = path.join(fixture.root, "unrelated");
  git(fixture.checkout, ["worktree", "add", "-b", "fix/unrelated", unrelated], fixture.home);
  rmSync(unrelated, { recursive: true });
  const listed = runNode(SESSIONS, ["list", "--repo", fixture.checkout], fixture.home);
  assert.equal(listed.status, 0, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.sessions.map((session) => session.branch), [fixture.record.branch]);
});

test("inventory refuses edits to checker guards outside the exact portable initializer", (t) => {
  const checker = "apps/prototypes/scripts/check-catalog-imports.mjs";
  const fixture = setup(t, { [checker]: portableSurfaceChecker() });
  publish(fixture);
  write(fixture, "packages/app/board/components/board-preview.tsx");
  const valid = portableSurfaceChecker(["@repo/app/board/components/board-preview"]);
  for (const content of [valid.replace("infrastructurePattern", "widenedPattern"), portableSurfaceChecker(["@repo/app/*"]),
    portableSurfaceChecker(["@repo/app/does-not-exist"]), valid.replace("portableSurfaceAllowlist.has(specifier)", "true")]) {
    writeFileSync(path.join(fixture.worktree, checker), content);
    const inventory = runNode(INVENTORY, ["--worktree", fixture.worktree], fixture.home);
    assert.deepEqual(inventory.json.outsideAllowed, [{ path: checker, status: "M" }]);
  }
});
