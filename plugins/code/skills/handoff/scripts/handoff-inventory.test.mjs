import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");

function setup(t, slug) {
  const fixture = makeHome("handoff-inventory-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({
    root: fixture.root,
    home: fixture.home,
    checkout,
    files: {
      "scripts/loops-setup.sh": "echo old\n",
      "apps/app/page.tsx": "export const page = 1;\n",
    },
  });
  const created = runNode(
    SESSIONS,
    ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--scope", "draft"],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

function write(worktree, file, content) {
  const absolute = path.join(worktree, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

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
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.forbidden, [{ path: "scripts/loops-setup.sh", status: "M" }]);
  assert.deepEqual(result.json.localFixes, []);
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
