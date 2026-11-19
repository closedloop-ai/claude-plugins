import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isolatedVibeEnvironment, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

function seed(root) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, ".git", "vibe-session.json"), '{"branch":"fixture","provider":{"state":"none"}}');
  const startup = path.join(root, ".codex", "vibe", "plugin-version");
  mkdirSync(startup, { recursive: true });
  writeFileSync(path.join(startup, "fixture-chat.json"), '{"status":"current","provider":{"state":"none"}}');
  const hooks = path.join(root, ".vibe-hook-scope");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, "fixture-chat.json"), '{"skill":"vibe"}');
  return root;
}

test("AC-020 private state readers refuse a path outside the test fixture even if their caller catches it", (t) => {
  const fixture = makeHome("vibe-state-isolation-");
  t.after(fixture.cleanup);
  const scratch = path.join(fixture.root, "test-tmp");
  const live = seed(path.join(fixture.root, "outside-test-tmp"));
  const safe = seed(path.join(scratch, "fixture"));
  const calls = [
    ["session-record.mjs", "readSessionRecord", "root"],
    ["provider.mjs", "recordedBinding", "{ worktree: root, conversation: 'fixture-chat', home: root }"],
    ["provider.mjs", "recordedBinding", "{ conversation: 'fixture-chat', home: root }"],
    ["startup-record.mjs", "readStartupRecord", "'fixture-chat', root"],
    ["../../../hooks/hook-session-scope.mjs", "readHookSkillRecord", "'fixture-chat', root"],
  ];
  for (const [module, read, args] of calls) {
    const invoke = (directory) => spawnSync(process.execPath, ["--input-type=module", "-e", `
import { ${read} } from ${JSON.stringify(new URL(module, import.meta.url).href)};
const root = process.argv[1];
try { if (${read}(${args})) process.stdout.write('read fixture'); } catch {}
`, directory], { cwd: fixture.root, env: { ...isolatedVibeEnvironment(fixture.home), TMPDIR: scratch }, encoding: "utf8", timeout: 5000 });
    const accepted = invoke(safe);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, "read fixture", read);
    const refused = invoke(live);
    assert.equal(refused.status, 1, `${read}: ${refused.stderr}`);
    assert.match(refused.stderr, /VIBE_TEST_LIVE_STATE/);
    assert.equal(refused.stdout, "", read);
  }
});
