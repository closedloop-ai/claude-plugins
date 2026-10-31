import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyVibeChangeScope,
  classifyVibeChangeScopeBetween,
  classifyVibeWorkingTreeScope,
} from "./vibe-change-scope.ts";

const REPO = join(import.meta.dirname, "../../..");
const VIBE = join(REPO, "plugins/vibe");

test("documentation, changelog, eval, test and benchmark-only changes skip nightly", () => {
  const pathSets = [
    ["plugins/vibe/README.md"],
    ["plugins/vibe/CHANGELOG.md"],
    ["plugins/vibe/docs/architecture.md"],
    ["docs/vibe-benchmark.md"],
    ["plugins/vibe/evals/pm-reference-card/prompt.md"],
    ["plugins/vibe/hooks/shell-safety-guard.test.mjs"],
    ["plugins/vibe/tools/python/test_vibe_contract.py"],
    ["tools/vibe-bench/src/cli.ts"],
  ];
  for (const changedFiles of pathSets) {
    assert.deepEqual(classifyVibeChangeScope(changedFiles, VIBE).behaviorFiles, [],
      `${changedFiles.join(", ")} should not schedule paid evaluation`);
  }
});

test("every runtime behavior category schedules nightly evaluation", () => {
  const behaviorPaths = [
    "plugins/vibe/.claude-plugin/plugin.json",
    "plugins/vibe/.codex-plugin/plugin.json",
    "plugins/vibe/plugin.json",
    "plugins/vibe/mcp.json",
    "plugins/vibe/.mcp.json",
    "plugins/vibe/.lsp.json",
    "plugins/vibe/skills/vibe/SKILL.md",
    "plugins/vibe/agents/vibe-change-worker.md",
    "plugins/vibe/commands/start.md",
    "plugins/vibe/hooks/hooks.json",
    "plugins/vibe/shared/process-identity.mjs",
    "plugins/vibe/scripts/install.mjs",
    "plugins/vibe/monitors/fleet.md",
    "plugins/vibe/output-styles/plain.md",
    "plugins/vibe/themes/default.json",
    "plugins/vibe/workflows/nightly.yml",
  ];
  for (const path of behaviorPaths) {
    assert.deepEqual(classifyVibeChangeScope([path], VIBE).behaviorFiles, [path],
      `${path} should schedule paid evaluation`);
  }
});

test("unknown plugin paths fail closed and mixed diffs schedule nightly evaluation", () => {
  const unknown = ["plugins/vibe/new-runtime-format.bin",
    "plugins/vibe/tools/python/runtime_helper.py"];
  assert.deepEqual(classifyVibeChangeScope(unknown, VIBE).behaviorFiles, unknown);
  assert.deepEqual(classifyVibeChangeScope([
    "plugins/vibe/README.md",
    "plugins/vibe/skills/vibe/SKILL.md",
  ], VIBE).behaviorFiles, ["plugins/vibe/skills/vibe/SKILL.md"]);
});

test("a README plus required version-only manifests remains non-behavioral", () => {
  const repo = mkdtempSync(join(tmpdir(), "vibe-scope-version-only-"));
  try {
    for (const directory of [".claude-plugin", ".codex-plugin"]) {
      mkdirSync(join(repo, "plugins/vibe", directory), { recursive: true });
      writeFileSync(join(repo, "plugins/vibe", directory, "plugin.json"),
        `${JSON.stringify({ name: "vibe", version: "1.0.0", description: "fixture" }, null, 2)}\n`);
    }
    writeFileSync(join(repo, "plugins/vibe/README.md"), "# Vibe\n");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    const files = ["plugins/vibe/.claude-plugin/plugin.json",
      "plugins/vibe/.codex-plugin/plugin.json", "plugins/vibe/README.md"];
    for (const directory of [".claude-plugin", ".codex-plugin"]) {
      writeFileSync(join(repo, "plugins/vibe", directory, "plugin.json"),
        `${JSON.stringify({ name: "vibe", version: "1.0.1", description: "fixture" }, null, 2)}\n`);
    }
    writeFileSync(join(repo, "plugins/vibe/README.md"), "# Vibe docs only\n");
    assert.deepEqual(classifyVibeWorkingTreeScope(repo, "HEAD", files).behaviorFiles, []);
    writeFileSync(join(repo, "plugins/vibe/.claude-plugin/plugin.json"),
      `${JSON.stringify({ name: "vibe", version: "1.0.1", description: "changed" }, null, 2)}\n`);
    assert.deepEqual(classifyVibeWorkingTreeScope(repo, "HEAD", files).behaviorFiles,
      ["plugins/vibe/.claude-plugin/plugin.json"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a runtime-referenced document and its deletion are behavior changes", () => {
  const repo = mkdtempSync(join(tmpdir(), "vibe-scope-referenced-doc-"));
  const document = "plugins/vibe/docs/runtime.md";
  try {
    mkdirSync(join(repo, "plugins/vibe/skills/vibe"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/docs"), { recursive: true });
    writeFileSync(join(repo, "plugins/vibe/skills/vibe/SKILL.md"),
      "Read ../../docs/runtime.md before launch.\n");
    writeFileSync(join(repo, document), "# Runtime contract\n");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    assert.deepEqual(classifyVibeChangeScope([document], join(repo, "plugins/vibe")).behaviorFiles,
      [document]);
    unlinkSync(join(repo, document));
    assert.deepEqual(classifyVibeWorkingTreeScope(repo, base, [document]).behaviorFiles, [document]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "delete runtime doc"],
    { stdio: "ignore" });
    assert.deepEqual(classifyVibeChangeScopeBetween(repo, base, "HEAD").behaviorFiles, [document]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
