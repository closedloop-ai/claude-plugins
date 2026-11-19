import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode, SYMPHONY_PATH_POLICY, seedAlignedDecisionTable } from "../../vibe/scripts/test-fixtures.mjs";
import { hashParts, readInventoryCache, rulesVersion, writeInventoryCache } from "./inventory-cache.mjs";
import { inventoryGateProblem } from "./handoff-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const SESSION_PLAN = path.join(HERE, "..", "..", "vibe", "scripts", "session-plan.mjs");

function setup(t, slug = "cache") {
  const fixture = makeHome("handoff-inventory-cache-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "repo");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout,
    files: { "apps/app/page.tsx": "export const page = 1;\n", "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY } });
  const created = runNode(SESSIONS, ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--mode", "seeded",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], fixture.home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  seedAlignedDecisionTable(worktree);
  writeFileSync(path.join(worktree, "apps/app/page.tsx"), "export const page = 2;\n");
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home);
  const prs = path.join(fixture.root, "prs.json");
  writeFileSync(prs, "[]\n");
  return { ...fixture, worktree, gitDir, prs };
}

const inventory = (fixture, ...args) => runNode(INVENTORY, ["--worktree", fixture.worktree, ...args], fixture.home);

/** Plant a marker finding in every cached entry, so a reused entry is visible in the result. */
function plantMarker(gitDir) {
  const dir = path.join(gitDir, "vibe-inventory-cache");
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    const entry = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    entry.value.diffRules.blocking.push({ rule: "planted", file: "apps/app/page.tsx", line: 1, problem: "planted", fix: "planted" });
    writeFileSync(path.join(dir, name), JSON.stringify(entry));
  }
}
function editRecord(fixture, change) {
  const file = path.join(fixture.gitDir, "vibe-session.json");
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8"))), null, 2));
}
const planted = (result) => result.json.diffRules.blocking.some((finding) => finding.rule === "planted");

test("ISS-14116: an identical key reuses the cached inventory; a changed head, diff or change log does not", (t) => {
  const fixture = setup(t);
  const first = inventory(fixture);
  assert.equal(first.json.inventoryCache, "miss", JSON.stringify(first.json));
  plantMarker(fixture.gitDir);
  const second = inventory(fixture);
  assert.equal(second.json.inventoryCache, "hit");
  assert.ok(planted(second), "the matching entry was reused");

  // Activity the inventory does not read leaves the key alone: a touch, and a provider probe time on the binding.
  assert.equal(runNode(SESSIONS, ["touch", "--worktree", fixture.worktree], fixture.home).status, 0);
  assert.equal(inventory(fixture).json.inventoryCache, "hit", "a touch keeps the entry");
  for (const probedAt of ["2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z"]) {
    editRecord(fixture, (record) => {
      assert.ok(record.provider, "the fixture session records its provider binding");
      return { ...record, provider: { ...record.provider, probedAt } };
    });
    const probed = inventory(fixture);
    assert.equal(probed.json.inventoryCache, "hit", `a provider probe at ${probedAt} keeps the entry`);
    assert.ok(planted(probed));
  }

  // Decision table: the one input changed -> whether the planted entry may be reused.
  const rows = [
    ["record field the rules read (localFixes)", () => editRecord(fixture, (record) => ({ ...record,
      localFixes: [{ ticket: "ISS-1", paths: ["apps/app/other.tsx"] }] }))],
    ["record field the bundle reads (vercel.storybookUrl)", () => editRecord(fixture, (record) => ({ ...record,
      vercel: { ...record.vercel, storybookUrl: "https://storybook.example.invalid" } }))],
    ["uncommitted diff", () => writeFileSync(path.join(fixture.worktree, "apps/app/page.tsx"), "export const page = 3;\n")],
    ["change log", () => writeFileSync(path.join(fixture.gitDir, "vibe-changes.md"), "- Export: page: consumer\n")],
    ["head commit", () => {
      git(fixture.worktree, ["add", "apps/app/page.tsx"], fixture.home);
      git(fixture.worktree, ["commit", "-m", "page"], fixture.home);
    }],
    // Both sides clean, so the uncommitted diff hashes alike and only the head differs.
    ["head commit alone", () => {
      writeFileSync(path.join(fixture.worktree, "apps/app/page.tsx"), "export const page = 4;\n");
      git(fixture.worktree, ["commit", "-am", "page again"], fixture.home);
    }],
  ];
  for (const [name, change] of rows) {
    plantMarker(fixture.gitDir);
    assert.ok(planted(inventory(fixture)), `${name}: unchanged inputs still hit`);
    change();
    const changed = inventory(fixture);
    assert.equal(changed.json.inventoryCache, "miss", name);
    assert.equal(planted(changed), false, `${name}: the entry for other inputs is never reused`);
  }
});

test("ISS-14116: the phase is part of the key, and a body-only change reuses the pull-request inventory", (t) => {
  const fixture = setup(t);
  inventory(fixture, "--phase", "handoff");
  plantMarker(fixture.gitDir);
  assert.equal(planted(inventory(fixture, "--phase", "pull-request")), false);
  const body = path.join(fixture.root, "body.md");
  writeFileSync(body, "## Summary\n\nFirst draft.\n");
  inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs);
  plantMarker(fixture.gitDir);
  writeFileSync(body, "## Summary\n\nSecond draft.\n");
  const edited = inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs);
  assert.equal(edited.json.inventoryCache, "hit");
  assert.ok(planted(edited));
  assert.ok(Array.isArray(edited.json.prBodyProblems), "the body itself is checked on every run");
});

test("ISS-14116: a body-only check with no matching inventory checks the body alone and claims no inventory", (t) => {
  const fixture = setup(t);
  const body = path.join(fixture.root, "body.md");
  writeFileSync(body, "## Summary\n\nDraft.\n");
  const alone = inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs, "--body-only");
  assert.equal(alone.json.inventory, null);
  assert.match(alone.json.inventoryProblem, /No inventory matches head [0-9a-f]{40}/);
  assert.deepEqual(Object.keys(alone.json.blocking), ["prBody"]);
  assert.equal(alone.json.diffRules, undefined);
  assert.ok(Array.isArray(alone.json.prBodyProblems));
  assert.equal(readdirSafe(path.join(fixture.gitDir, "vibe-inventory-cache")).length, 0, "a body-only run writes no inventory");
  inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs);
  const matched = inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs, "--body-only");
  assert.equal(matched.json.inventoryCache, "hit");
  assert.equal(matched.json.inventory, undefined);
  assert.ok(matched.json.diffRules, "with a matching inventory the full result is reported");
  assert.equal(inventory(fixture, "--body-only").json.error, "--body-only needs --phase pull-request and --body.");
  // The documented rerun after a body repair carries the verifier evidence too; with no entry it is left unchecked.
  const runs = path.join(fixture.root, "runs.json");
  writeFileSync(runs, "{}\n");
  git(fixture.worktree, ["add", "-A"], fixture.home);
  git(fixture.worktree, ["commit", "-m", "page"], fixture.home);
  const head = git(fixture.worktree, ["rev-parse", "HEAD"], fixture.home);
  const documented = ["--phase", "pull-request", "--body", body, "--prs-json", fixture.prs, "--runs", runs, "--commit", head, "--body-only"];
  const unmatched = inventory(fixture, ...documented);
  assert.equal(unmatched.json.inventory, null);
  assert.match(unmatched.json.inventoryProblem, /not the verifier evidence/);
  assert.equal(unmatched.json.prEvidenceProblems, undefined);
  inventory(fixture, ...documented.slice(0, -1));
  const rerun = inventory(fixture, ...documented);
  assert.equal(rerun.json.inventoryCache, "hit");
  assert.ok(Array.isArray(rerun.json.prEvidenceProblems), "with a matching inventory the evidence is checked as well");
});

test("ISS-14116: the handoff gate refuses a body-only result as inventory evidence", (t) => {
  const fixture = setup(t);
  const body = path.join(fixture.root, "body.md");
  writeFileSync(body, "## Summary\n\nDraft.\n");
  const bodyOnly = inventory(fixture, "--phase", "pull-request", "--body", body, "--prs-json", fixture.prs, "--body-only").json;
  assert.equal(bodyOnly.inventory, null);
  // Even a body-only result whose body and evidence flags read true is no inventory evidence.
  assert.match(inventoryGateProblem({ ...bodyOnly, ok: true, blocking: { prBody: true, prEvidence: true } }),
    /^pull-request inventory is missing: No inventory matches head/);
  assert.equal(inventoryGateProblem({ ok: true, blocking: { prBody: true, prEvidence: true } }), null);
  assert.match(inventoryGateProblem({ ok: true, blocking: { prBody: true } }), /did not pass/);
});

test("ISS-14116: a missing live ticket fails before any inventory work and names where the ticket worker saves it", (t) => {
  const fixture = setup(t);
  const sanctioned = runNode(SESSION_PLAN, ["paths", "--worktree", fixture.worktree], fixture.home).json.liveTicket;
  const gitDirTicket = path.join(fixture.gitDir, "vibe-live-ticket.md");
  // Off a vibe branch, the full inventory would fail on the branch; the missing ticket is reported first.
  git(fixture.worktree, ["checkout", "-q", "-b", "not-vibe"], fixture.home);
  for (const args of [["--live-ticket"], ["--ticket", gitDirTicket]]) {
    const result = inventory(fixture, "--phase", "pull-request", ...args);
    assert.equal(result.status, 1);
    assert.match(result.json.error, /Cannot read the ticket file .*ENOENT/);
    assert.ok(result.json.error.includes(sanctioned), result.json.error);
    assert.match(result.json.error, /handoff mode/);
  }
  git(fixture.worktree, ["checkout", "-q", "-"], fixture.home);
  writeFileSync(sanctioned, "## Scope\n\nPlease explain in the PR why the page changed.\n");
  const read = inventory(fixture, "--phase", "pull-request", "--live-ticket");
  assert.deepEqual(read.json.asks, ["Please explain in the PR why the page changed."]);
});

test("ISS-14116: the rules version follows rule source content, and the cache matches whole keys only", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rules-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roots = [path.join(dir, "a"), path.join(dir, "b")];
  roots.forEach((root) => mkdirSync(path.join(root, "nested"), { recursive: true }));
  writeFileSync(path.join(roots[0], "rule.mjs"), "export const rule = 1;\n");
  writeFileSync(path.join(roots[1], "nested", "other.mjs"), "export const other = 1;\n");
  writeFileSync(path.join(roots[1], "rule.test.mjs"), "test\n");
  const version = rulesVersion(roots);
  writeFileSync(path.join(roots[1], "rule.test.mjs"), "changed test\n");
  assert.equal(rulesVersion(roots), version, "a test file is not a rule source");
  writeFileSync(path.join(roots[1], "nested", "other.mjs"), "export const other = 2;\n");
  assert.notEqual(rulesVersion(roots), version, "a nested rule source changes the version");

  const gitDir = path.join(dir, "git");
  mkdirSync(gitDir);
  const key = { head: "a".repeat(40), diffHash: hashParts(["diff"]), rulesVersion: version, phase: "build" };
  writeInventoryCache(gitDir, key, { marker: 1 });
  assert.deepEqual(readInventoryCache(gitDir, key), { marker: 1 });
  for (const field of Object.keys(key)) {
    assert.equal(readInventoryCache(gitDir, { ...key, [field]: `${key[field]}x` }), null, field);
  }
  assert.notEqual(hashParts(["ab", "c"]), hashParts(["a", "bc"]));
});

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

test("ISS-14116: the cache keeps its newest 16 entries, and among entries tied on time it keeps the first names in order", () => {
  const gitDir = mkdtempSync(path.join(tmpdir(), "inventory-cache-tie-"));
  try {
    const dir = path.join(gitDir, "vibe-inventory-cache");
    for (let index = 0; index < 16; index += 1) writeInventoryCache(gitDir, { head: `h${index}` }, { index });
    const tied = new Date("2026-01-01T00:00:00Z");
    const before = readdirSync(dir).sort();
    for (const name of before) utimesSync(path.join(dir, name), tied, tied);
    writeInventoryCache(gitDir, { head: "newest" }, { index: 16 });
    const kept = readdirSync(dir).sort();
    assert.equal(kept.length, 16);
    assert.ok(kept.includes(`${hashParts([{ head: "newest" }])}.json`), "the newest entry is kept");
    assert.deepEqual(before.filter((name) => !kept.includes(name)), [before.at(-1)], "of the 16 tied entries, the last name goes");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});
