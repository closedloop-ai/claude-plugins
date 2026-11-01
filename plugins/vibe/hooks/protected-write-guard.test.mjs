import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "protected-write-guard.mjs");

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), "vibe-protected-write-"));
  const worktree = path.join(base, "worktree");
  mkdirSync(path.join(worktree, ".claude", "skills"), { recursive: true });
  mkdirSync(path.join(worktree, ".claude", "commands"), { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, worktree };
}

function run(worktree, hook_event_name, tool_name, tool_input) {
  return spawnSync(process.execPath, [hook, worktree], {
    input: JSON.stringify({ hook_event_name, tool_name, tool_input, cwd: worktree }),
    encoding: "utf8",
    timeout: 3000,
  });
}

function decision(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

test("PermissionRequest allows native Edit and Write only below the two canonical roots", (t) => {
  const { worktree } = fixture(t);
  for (const root of ["skills", "commands"]) {
    for (const tool of ["Edit", "Write"]) {
      const file_path = path.join(worktree, ".claude", root, "new.md");
      assert.equal(decision(run(worktree, "PermissionRequest", tool, { file_path }))?.decision?.behavior, "allow");
      assert.equal(decision(run(worktree, "PreToolUse", tool, { file_path })), null);
    }
  }
});

test("native protected writes deny other roots, traversal, siblings, and symlink escapes", (t) => {
  const { base, worktree } = fixture(t);
  symlinkSync(base, path.join(worktree, ".claude", "skills", "escape"));
  for (const file_path of [
    path.join(worktree, ".git", "config"),
    path.join(worktree, ".claude", "settings.json"),
    path.join(worktree, ".claude", "skills-extra", "x.md"),
    path.join(worktree, ".claude", "skills", "..", "settings.json"),
    path.join(worktree, ".claude", "skills", "escape", "x.md"),
    path.join(base, "external", ".claude", "settings.json"),
  ]) {
    const request = decision(run(worktree, "PermissionRequest", "Write", { file_path }));
    assert.equal(request?.decision?.behavior, "deny", file_path);
    const pre = decision(run(worktree, "PreToolUse", "Write", { file_path }));
    assert.equal(pre?.permissionDecision, "deny", file_path);
  }
});

test("hook-checked Bash write forms deny protected destinations", (t) => {
  const { base, worktree } = fixture(t);
  for (const command of [
    "python -c \"open('.claude/settings.json', 'w').write('x')\"",
    "node -e \"require('fs').writeFileSync('.claude/settings.json', 'x')\"",
    "cp source.txt .claude/settings.json",
    "mv source.txt .claude/settings.json",
    "sed -i '' 's/a/b/' .claude/settings.json",
    "cd .claude && cp source.txt settings.json",
    "cd .claude && mv source.txt settings.json",
    "cd .claude && sed -i '' 's/a/b/' settings.json",
    "cd $UNKNOWN_DIR && cp source.txt settings.json",
    "install -m 644 source.txt .claude/settings.json",
    "rsync source.txt .claude/settings.json",
    "ln -s source.txt .claude/settings.json",
    "python -c \"open('.claude/skills/new.md', 'w').write('x')\"",
    "python <<'PY'\nopen('.claude/settings.json', 'w').write('x')\nPY",
    `python -c "open('${path.join(base, "external", ".claude", "settings.json")}', 'w').write('x')"`,
  ]) {
    assert.equal(decision(run(worktree, "PreToolUse", "Bash", { command }))?.permissionDecision, "deny", command);
  }
});

test("legitimate Bash and runtime-checked redirect or tee forms receive no hook decision", (t) => {
  const { worktree } = fixture(t);
  for (const command of [
    "git status",
    "git diff -- .git",
    "pnpm test",
    "node scripts/lint.mjs",
    "ls .git",
    "cat .git/HEAD",
    "echo ok > output.txt",
    "cd build && cp source.txt output.txt",
    "install -m 644 source.txt output.txt",
    "rsync source.txt output.txt",
    "ln -s source.txt output.txt",
    "echo x > .claude/settings.json",
    "echo x | tee .claude/settings.json",
  ]) {
    const result = run(worktree, "PreToolUse", "Bash", { command });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", command);
  }
});

test("malformed protected-write event fails rather than allowing the tool call", (t) => {
  const { worktree } = fixture(t);
  const result = spawnSync(process.execPath, [hook, worktree], {
    input: "{bad json",
    encoding: "utf8",
    timeout: 3000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /protected-write guard/i);
});

test("writer refusal and internal preflight routing name the protected-write policy", () => {
  const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const writer = readFileSync(path.join(plugin, "agents", "vibe-change-worker.md"), "utf8");
  const skill = readFileSync(path.join(plugin, "skills", "vibe", "SKILL.md"), "utf8");
  const preflight = readFileSync(path.join(plugin, "skills", "vibe", "references", "preflight.md"), "utf8");
  assert.match(writer, /After any native edit refusal,[\s\S]*return `BLOCKED`/);
  assert.match(writer, /Never retry the[\s\S]*through Bash, Python, Node, tee, redirection/);
  assert.match(skill, /`PROTECTED_PATH_HOOK_UNAVAILABLE`:[\s\S]*dispatch `vibe-setup-worker`/);
  assert.match(preflight, /`claude-protected-hook-version`[\s\S]*2\.1\.295/);
});
