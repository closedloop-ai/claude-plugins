// The version-skew rows that are about where code lives rather than what a hook prints: rows 11 to 14 of the
// slimming plan and the Codex approval-pending row. A new vibe loads nothing from vibe-core; a vibe from before the
// slim core, loading its old modules from a slim vibe-core, reaches a stub that says how to fix it and exits 1 (the
// protected-write-guard stub, which a pre-slim launcher runs as a hook that blocks on failure, exits 0).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { comparePluginVersions } from "./plugin-roots.mjs";
import { VIBE_CORE_MIN } from "./vibe-core.mjs";
import {
  APPROVE_HOOKS, HookApproval, hookApprovalLine, runningHookApproval, vibeCoreHookApproval,
} from "../skills/vibe/scripts/vibe-core-hooks.mjs";
import { CORE_SOURCE, MARKETPLACE, VIBE_SOURCE, degradedNotice, machine, Layout, tempRoot, writePlugin } from "./vibe-core-skew-test-support.mjs";

const REPO = path.dirname(path.dirname(VIBE_SOURCE));
const FIX = degradedNotice("x").slice(degradedNotice("x").indexOf("To fix:"));
/** What every stub at an old vibe-core module path prints (operator ruling: the notice's fix sentence after this reason). */
const STUB_MESSAGE = `vibe-core is newer than your vibe. ${FIX}`;
/**
 * Every vibe-core module a released vibe (since the split, #418) loads by path: its vibeCore(), vibeCorePath() and
 * runVibeCoreMain() literals, its relative imports into vibe-core, and the protected-write guard its headless
 * launcher registers. Each must answer with the stub for as long as such a vibe can sit beside this vibe-core, so
 * this list only grows.
 */
const PRE_SLIM_CORE_LOADS = Object.freeze([
  "hooks/kill-guard.mjs",
  "hooks/protected-write-guard.mjs",
  "lib/codex-fleet-monitor/scripts/liveness.mjs",
  "lib/codex-fleet-monitor/scripts/work-dir.mjs",
  "lib/fleet-orchestrator/scripts/chat-binding.mjs",
  "lib/fleet-orchestrator/scripts/cloud-placement.mjs",
  "lib/fleet-orchestrator/scripts/fleet-home.mjs",
  "lib/fleet-orchestrator/scripts/helpers.mjs",
  "lib/fleet-orchestrator/scripts/skill-freshness.mjs",
  "lib/handoff/scripts/handoff-evidence.mjs",
  "lib/handoff/scripts/handoff-gate-check.mjs",
  "lib/handoff/scripts/review-receipts.mjs",
  "lib/handoff/scripts/ticket-names.mjs",
  "lib/handoff/scripts/unit-review-record.mjs",
  "lib/vibe/scripts/cloud-worker.mjs",
  "lib/vibe/scripts/e2e-lock.mjs",
  "lib/vibe/scripts/github-remote.mjs",
  "lib/vibe/scripts/harness-identity.mjs",
  "lib/vibe/scripts/image-head.mjs",
  "lib/vibe/scripts/loaded-skill.mjs",
  "lib/vibe/scripts/owned-cleanup.mjs",
  "lib/vibe/scripts/owned-state.mjs",
  "lib/vibe/scripts/plugin-script-references.mjs",
  "lib/vibe/scripts/provider-brief.mjs",
  "lib/vibe/scripts/provider.mjs",
  "lib/vibe/scripts/repository-commands.mjs",
  "lib/vibe/scripts/review-models.mjs",
  "lib/vibe/scripts/sandbox-refusal.mjs",
  "lib/vibe/scripts/session-record.mjs",
  "lib/vibe/scripts/startup-record.mjs",
  "lib/vibe/scripts/tested-head.mjs",
  "lib/vibe/scripts/worker-scope.mjs",
  "shared/process-identity.mjs",
]);
const SCANNED = /\.(?:mjs|cjs|js|ts|sh)$/;
const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts)$|(?:^|\/)test-(?:fixtures?|support)[^/]*\.(?:mjs|ts)$|-test-(?:fixtures?|support)\.(?:mjs|ts)$/;
const SPECIFIER = /(?:^|[^\w.$])(?:import|export)\s[^;]*?from\s*["'`]([^"'`]+)["'`]|(?:^|[^\w.$])import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|^\s*import\s*["'`]([^"'`]+)["'`]/gm;
const RELATIVE_INTO_CORE = /["'`](?:\.\.\/)+vibe-core\/(?:lib|hooks|shared)\//;
const SIBLING_CORE = /siblingPlugin(?:Root|RootOrNull|Install)\d*\(\s*["'`]vibe-core["'`]/;
const SETUP_CHECK = path.join(VIBE_SOURCE, "shared", "vibe-core.mjs");

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(file, found);
    else if (SCANNED.test(entry.name) && !TEST_FILE.test(path.relative(VIBE_SOURCE, file))) found.push(file);
  }
  return found;
}

/** A line with a sibling lookup, with a bundler's numeric suffix dropped so a bundled copy compares equal to its source. */
function normalized(line) {
  return line.trim().replace(/(siblingPlugin(?:Root|RootOrNull|Install))\d+\(/g, "$1(");
}

/** Runs `script` (an ES module body) and returns its result; it never starts a hook, so HOME is left alone. */
function runModule(script, cwd) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", timeout: 60_000 });
}

// A pre-slim launcher runs this one as a hook command that blocks on failure, so its stub exits 0 (nothing is refused).
const HOOK_COMMAND_STUB = "hooks/protected-write-guard.mjs";

function assertStub(result, label, status = 1) {
  assert.equal(result.status, status, `${label}: exit ${status} (never 2, which a harness reads as a refusal): ${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(output.includes(STUB_MESSAGE), `${label}: prints the stub message: ${output}`);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|\n\s+at /, `${label}: no stack trace`);
}

test("row 11: no module of this vibe loads anything from vibe-core; only the setup check looks vibe-core up", () => {
  const allowed = new Set(readFileSync(SETUP_CHECK, "utf8").split("\n").filter((line) => SIBLING_CORE.test(line)).map(normalized));
  assert.ok(allowed.size > 0, "the setup check still finds vibe-core to report its version");
  const files = sourceFiles(VIBE_SOURCE);
  assert.ok(files.length > 100, `scanned only ${files.length} files`);
  const loads = [];
  for (const file of files) {
    const relative = path.relative(VIBE_SOURCE, file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : specifier;
      const outside = path.relative(VIBE_SOURCE, target).startsWith("..");
      if (/(?:^|[\\/])vibe-core[\\/]/.test(target) && (outside || !specifier.startsWith("."))) loads.push(`${relative} imports ${specifier}`);
    }
    source.split("\n").forEach((line, index) => {
      if (RELATIVE_INTO_CORE.test(line)) loads.push(`${relative}:${index + 1} names a path into vibe-core: ${line.trim()}`);
      if (SIBLING_CORE.test(line) && file !== SETUP_CHECK && !allowed.has(normalized(line))) {
        loads.push(`${relative}:${index + 1} resolves vibe-core outside the setup check: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(loads, []);
});

test("row 11: the setup check reports a vibe-core older than VIBE_CORE_MIN (a fat core) and accepts VIBE_CORE_MIN", (t) => {
  const root = tempRoot(t, "setup-check");
  const plugins = path.join(root, "plugins");
  const vibe = writePlugin(path.join(plugins, "vibe"), { name: "vibe-generic", version: "1.2.0" });
  cpSync(path.join(VIBE_SOURCE, "shared"), path.join(vibe, "shared"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  const problem = (coreVersion) => {
    writePlugin(path.join(plugins, "vibe-core"), { name: "vibe-core", version: coreVersion });
    const url = JSON.stringify(pathToFileURL(path.join(vibe, "shared", "vibe-core.mjs")).href);
    const result = runModule(`const { vibeCoreProblem } = await import(${url}); process.stdout.write(JSON.stringify(vibeCoreProblem()));`, root);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const fat = "0.0.1";
  assert.ok(comparePluginVersions(fat, VIBE_CORE_MIN) < 0);
  const old = problem(fat);
  assert.equal(old.outdated, true);
  assert.equal(old.installed, fat);
  assert.equal(old.minimum, VIBE_CORE_MIN);
  assert.match(old.message, /plugin update vibe-core@/, "names the update command");
  assert.equal(problem(VIBE_CORE_MIN), null);
});

test("row 12: every vibe-core module a released vibe loads by path is a stub there in this vibe-core", () => {
  const missing = PRE_SLIM_CORE_LOADS.filter((relative) => !existsSync(path.join(CORE_SOURCE, relative)));
  assert.deepEqual(missing, [], "each old path holds a stub, never nothing (a missing module is a stack trace)");
});

test("row 12: a pre-slim vibe's dynamic load of each old path reaches the stub: its message, exit 1 (the hook-command stub 0), never 2", () => {
  for (const relative of PRE_SLIM_CORE_LOADS) {
    const url = JSON.stringify(pathToFileURL(path.join(CORE_SOURCE, relative)).href);
    const status = relative === HOOK_COMMAND_STUB ? 0 : 1;
    assertStub(runModule(`const loaded = await import(${url}); process.stdout.write(String(Object.keys(loaded).length));`, REPO), `import ${relative}`, status);
    // runVibeCoreMain() starts the module as node's entry.
    assertStub(spawnSync(process.execPath, [path.join(CORE_SOURCE, relative)], { encoding: "utf8", timeout: 60_000 }), `node ${relative}`, status);
  }
});

test("row 12: a pre-slim vibe's own loader, beside the slim vibe-core in a Claude Code install, ends in the stub", (t) => {
  const m = machine(t, Layout.Claude);
  const old = m.add({ name: "vibe", version: "1.1.80" });
  cpSync(path.join(VIBE_SOURCE, "shared", "plugin-roots.mjs"), path.join(old, "shared", "plugin-roots.mjs"));
  // The shape of a pre-slim vibe's shared/vibe-core.mjs loader: vibe-core's root, joined with the module's old path.
  const loader = `import path from "node:path";
import { pathToFileURL } from "node:url";
import { siblingPluginRoot } from "./plugin-roots.mjs";
export function vibeCore(relative) {
  return import(pathToFileURL(path.join(siblingPluginRoot("vibe-core", { from: import.meta.url }), relative)).href);
}
`;
  writePlugin(old, { name: "vibe", version: "1.1.80" }, {
    "shared/vibe-core.mjs": loader,
    "skills/vibe/scripts/plugin-version.mjs": `import { vibeCore } from "../../../shared/vibe-core.mjs";
const { harnessIdentity } = await vibeCore("lib/vibe/scripts/harness-identity.mjs");
process.stdout.write(String(typeof harnessIdentity));
`,
  });
  const result = spawnSync(process.execPath, [path.join(old, "skills", "vibe", "scripts", "plugin-version.mjs"), "check"],
    { cwd: m.project, encoding: "utf8", timeout: 60_000 });
  assertStub(result, "the pre-slim updater");
  assert.equal(result.stdout.includes("function"), false, "nothing ran past the stub");
  assert.match(STUB_MESSAGE, new RegExp(`plugin update vibe@${MARKETPLACE}`), "the stub names the harness command, not vibe's own updater");
});

test("row 13: a pre-slim headless launcher's protected-write hook command (vibe-core's old path) gets the stub, exit 0 (the launcher blocks on any failure)", (t) => {
  const root = tempRoot(t, "launcher");
  const hook = path.join(CORE_SOURCE, "hooks", "protected-write-guard.mjs");
  // A pre-slim launcher registers `node <vibe-core>/hooks/protected-write-guard.mjs <worktree>` for Edit, Write and Bash.
  for (const event of [
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, ".npmrc"), content: "x" } },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
  ]) {
    const result = spawnSync(process.execPath, [hook, root], { cwd: root, input: JSON.stringify({ session_id: "writer", cwd: root, ...event }),
      encoding: "utf8", timeout: 60_000 });
    assertStub(result, `${event.tool_name} through the old hook path`, 0);
  }
});

test("row 14: the new launcher resolves protected-write-guard inside its own vibe", () => {
  const guard = path.join(VIBE_SOURCE, "hooks", "protected-write-guard.mjs");
  assert.ok(existsSync(guard), "vibe ships the guard");
  assert.ok(!readFileSync(guard, "utf8").includes(STUB_MESSAGE), "vibe's copy is the guard, not a stub");
  const preflight = path.join(REPO, "tools", "vibe-workers", "src", "claude-preflight.ts");
  assert.ok(existsSync(preflight), "the launcher's preflight source is in this checkout");
  const lines = readFileSync(preflight, "utf8").split("\n").flatMap((line, index) => (line.includes("vibe-core") ? [`${index + 1}: ${line.trim()}`] : []));
  assert.deepEqual(lines, [], "the launcher's preflight no longer names vibe-core");
});

// Approval pending (Codex): until a person trusts the bundle a new vibe-core release brings, Codex runs none of its
// hooks, so no guard and no notice exists. The repo cannot run Codex's trust check; it can pin that vibe's setup check
// reads the approval of the hooks that will actually run and tells the person the step.
test("approval pending: an updated, not yet trusted vibe-core is reported with the approval step, and the slim vibe lists no hooks of its own", () => {
  assert.equal(existsSync(path.join(VIBE_SOURCE, "hooks", "hooks.json")), false, "vibe registers no hooks, so vibe-core's are the ones that run");
  const listing = (trustStatus) => ({ data: [{ hooks: ["pre_tool_use", "post_tool_use"].map((key) => ({ pluginId: `vibe-core@${MARKETPLACE}`, key, enabled: true, trustStatus })) }] });
  const pending = runningHookApproval(listing("modified"));
  assert.equal(pending.plugin, "vibe-core");
  assert.equal(pending.state, HookApproval.Needed);
  assert.deepEqual(pending.blocked, ["pre_tool_use is modified", "post_tool_use is modified"]);
  const line = hookApprovalLine(vibeCoreHookApproval(listing("modified")));
  assert.ok(line.includes(APPROVE_HOOKS), line);
  assert.equal(hookApprovalLine(vibeCoreHookApproval(listing("trusted"))), null);
  assert.equal(vibeCoreHookApproval({ data: [] }).state, HookApproval.Missing);
});
