import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const inventory = path.join(here, "handoff-inventory.mjs");
const sessions = path.join(here, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const policy = readFileSync(path.resolve(here, "../../../../..", "vibe-handoff-paths.json"), "utf8");

test("handoff overlap reads the target repository from its worktree", (t) => {
  const { root, home, cleanup } = makeHome("handoff-overlap-");
  t.after(cleanup);
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "claude-plugins");
  makeCheckout({ root, home, checkout, remoteUrl: "git@github.com:closedloop-ai/claude-plugins.git",
    files: { "vibe-handoff-paths.json": policy, "plugins/vibe/skills/handoff/scripts/owner.mjs": "export const owner = false;\n" } });
  const created = runNode(sessions,
    ["new", "--repo", checkout, "--slug", "claude-overlap", "--summary", "claude-overlap", "--mode", "seeded",
      "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const file = path.join(worktree, "plugins/vibe/skills/handoff/scripts/owner.mjs");
  writeFileSync(file, "export const owner = true;\n");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "repo view") [ "$PWD" = "${worktree}" ] || exit 9; printf '%s\\n' 'closedloop-ai/claude-plugins' ;;
  "pr list") case " $* " in *"--repo closedloop-ai/claude-plugins"*) printf '%s\\n' '[]' ;; *) exit 8 ;; esac ;;
  *) exit 3 ;;
esac
`);
  chmodSync(gh, 0o700);
  const result = runNode(inventory, ["--worktree", worktree, "--phase", "handoff", "--overlap"], home,
    { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.json.overlapError, undefined, result.stderr);
  assert.deepEqual(result.json.overlap, []);
});
