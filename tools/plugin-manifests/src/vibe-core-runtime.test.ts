// vibe-core's hook loader (plugins/vibe-core/hooks/vibe-runtime.mjs) run as hooks.json runs it, beside fixture vibes
// whose hooks/runtime.mjs serves, breaks or lacks the hook contract, and the stubs a vibe older than vibe-core loads.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { degradedNotice, NOTICE_EVENTS, sharedContract, SHIM_CONTRACTS } from "../../../plugins/vibe-core/hooks/vibe-runtime.mjs";
import { VibeProblem } from "../../../plugins/vibe-core/shared/vibe-install.mjs";
import { bundleVersion, HOOK_COMMAND_STUBS, STUB_FILES, VIBE_CORE_DIR } from "./vibe-core-bundle.js";

const ECHO_RUNTIME = `export const CONTRACTS = [1];
export function runHook({ event, input, core, report }) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: JSON.stringify({ input, core, report: typeof report }) } };
}
`;
const UPDATE_VIBE = "vibe-core is newer than your vibe. To fix: run `claude plugin update vibe@closedloop-ai` then start a new Claude Code session, "
  + "or run `codex plugin add vibe@closedloop-ai` then quit and reopen the Codex app.\n";
const EVENTS = Object.freeze({
  PreToolUse: "pre-tool-use", PostToolUse: "post-tool-use", PreCompact: "pre-compact", UserPromptSubmit: "user-prompt-submit", SessionStart: "session-start",
});
type HookEvent = keyof typeof EVENTS;
/** These cases start dozens of node processes each. */
const SPAWN_TIMEOUT = 60_000;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A checkout holding a copy of vibe-core and, unless `runtime` is null, a vibe whose hooks/runtime.mjs is `runtime` (undefined: none). */
function checkout(runtime: string | null | undefined, { hooksJson = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-core-runtime-")));
  roots.push(root);
  const core = join(root, "plugins", "vibe-core");
  cpSync(VIBE_CORE_DIR, core, { recursive: true });
  const vibe = join(root, "plugins", "vibe");
  if (runtime !== null) {
    mkdirSync(join(vibe, ".claude-plugin"), { recursive: true });
    writeFileSync(join(vibe, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe-generic", version: "1.1.99" }));
    mkdirSync(join(vibe, "hooks"), { recursive: true });
    if (runtime !== undefined) writeFileSync(join(vibe, "hooks", "runtime.mjs"), runtime);
    if (hooksJson) writeFileSync(join(vibe, "hooks", "hooks.json"), "{}");
  }
  return { root, core, vibe };
}

function run(core: string, event: HookEvent, input: unknown, home: string) {
  const result = spawnSync(process.execPath, [join(core, "hooks", `${EVENTS[event]}.mjs`)], {
    encoding: "utf8", input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, HOME: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const noticeOutput = (event: HookEvent, reason: string) =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: degradedNotice(reason) } })}\n`;
/** The degraded run of `event`: the notice on stdout for an event in `noticeEvents` other than PreCompact, else nothing. */
const degraded = (event: HookEvent, reason: string, noticeEvents: readonly string[]) => event !== "PreCompact" && noticeEvents.includes(event)
  ? { status: 0, stdout: noticeOutput(event, reason), stderr: "" }
  : { status: 0, stdout: "", stderr: "" };

describe("vibe-core hook loader", () => {
  it("hands every event to vibe's runtime with the shared contract and prints its result", () => {
    const f = checkout(ECHO_RUNTIME);
    for (const event of Object.keys(EVENTS) as HookEvent[]) {
      const input = { hook_event_name: event, cwd: f.root, session_id: "s" };
      const result = run(f.core, event, input, f.root);
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(output.hookSpecificOutput.hookEventName).toBe(event);
      expect(JSON.parse(output.hookSpecificOutput.additionalContext)).toEqual({ input, core: { root: f.core, version: bundleVersion(), contract: 1 }, report: "function" });
    }
  });

  it("prints a string as plain text and null as nothing", () => {
    const text = checkout("export const CONTRACTS = [1];\nexport const runHook = async () => \"compaction instructions\";\n");
    expect(run(text.core, "PreCompact", { cwd: text.root }, text.root)).toEqual({ status: 0, stdout: "compaction instructions\n", stderr: "" });
    const nothing = checkout("export const CONTRACTS = [0, 1, 2];\nexport const runHook = () => null;\n");
    expect(run(nothing.core, "PreToolUse", { cwd: nothing.root }, nothing.root), "the highest shared contract serves").toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("stands down silently with no vibe, or with one that registers its own hooks", () => {
    const none = checkout(null);
    const owns = checkout(undefined, { hooksJson: true });
    for (const f of [none, owns]) {
      for (const event of Object.keys(EVENTS) as HookEvent[]) expect(run(f.core, event, { cwd: f.root }, f.root)).toEqual({ status: 0, stdout: "", stderr: "" });
    }
  });

  it("proceeds with the degraded notice when vibe's guards cannot run, and never refuses", () => {
    const throwing = "export const CONTRACTS = [1];\nexport function runHook() { throw new Error(\"boom\"); }\n";
    const cases: Array<[string, string | undefined, string]> = [
      ["no hooks/runtime.mjs (a vibe from before the slim vibe-core)", undefined, VibeProblem.Older],
      ["contracts this vibe-core does not know yet", "export const CONTRACTS = [2, 3];\nexport const runHook = () => null;\n", VibeProblem.Newer],
      ["contracts this vibe-core no longer serves", "export const CONTRACTS = [0];\nexport const runHook = () => null;\n", VibeProblem.Older],
      ["a runtime that throws on import", "throw new Error(\"half written\");\n", VibeProblem.Incomplete],
      ["a runtime that does not parse", "export const CONTRACTS = [1\n", VibeProblem.Incomplete],
      ["a runtime with the wrong exports", "export const CONTRACTS = \"1\";\nexport const runHook = 1;\n", VibeProblem.Incomplete],
      ["a runHook that throws", throwing, VibeProblem.Failed],
      ["a runHook that rejects", "export const CONTRACTS = [1];\nexport async function runHook() { throw new Error(\"boom\"); }\n", VibeProblem.Failed],
    ];
    for (const [label, runtime, reason] of cases) {
      const f = checkout(runtime);
      const input = { cwd: f.root, tool_name: "Bash", tool_input: { command: "ls" } };
      for (const event of Object.keys(EVENTS) as HookEvent[]) {
        expect(run(f.core, event, input, f.root), `${label}: ${event}`).toEqual(degraded(event, reason, NOTICE_EVENTS));
      }
    }
  }, SPAWN_TIMEOUT);

  it("never puts the notice on PreCompact's stdout, whatever NOTICE_EVENTS names", () => {
    const f = checkout(undefined);
    const loader = join(f.core, "hooks", "vibe-runtime.mjs");
    const every = Object.keys(EVENTS) as HookEvent[];
    const source = readFileSync(loader, "utf8");
    const widened = source.replace(/^export const NOTICE_EVENTS = .*$/m, `export const NOTICE_EVENTS = Object.freeze(${JSON.stringify(every)});`);
    expect(widened).not.toBe(source);
    writeFileSync(loader, widened);
    for (const event of every) {
      expect(run(f.core, event, { cwd: f.root }, f.root), event).toEqual(degraded(event, VibeProblem.Older, every));
    }
  }, SPAWN_TIMEOUT);

  it("names an unresolvable vibe install in the notice", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-core-runtime-claude-")));
    roots.push(root);
    const cache = join(root, "claude", "plugins", "cache", "closedloop-ai");
    const core = join(cache, "vibe-core", "1.0.15");
    cpSync(VIBE_CORE_DIR, core, { recursive: true });
    writeFileSync(join(root, "claude", "plugins", "installed_plugins.json"), "{ not json");
    expect(run(core, "UserPromptSubmit", { cwd: root }, root)).toEqual({ status: 0, stdout: noticeOutput("UserPromptSubmit", VibeProblem.Unresolved), stderr: "" });
  });

  it("keeps exit 0 when vibe's code fails after runHook returns, and reports unreadable input without a notice", () => {
    const late = checkout("export const CONTRACTS = [1];\nexport function runHook() { setTimeout(() => { throw new Error(\"late\"); }); Promise.reject(new Error(\"stray\")); return null; }\n");
    const result = run(late.core, "PreToolUse", { cwd: late.root }, late.root);
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toMatch(/^vibe-core PreToolUse: stray\nvibe-core PreToolUse: late\n$/);
    const f = checkout(ECHO_RUNTIME);
    expect(run(f.core, "UserPromptSubmit", "{ not json", f.root)).toMatchObject({ status: 0, stdout: "" });
  });

  it("states the notice verbatim, and calls contract 1", () => {
    expect(degradedNotice("vibe is older than vibe-core")).toBe("vibe's safety checks couldn't load (vibe is older than vibe-core), so they're off for now. "
      + "Your work continues. To fix: run `claude plugin update vibe@closedloop-ai` then start a new Claude Code session, "
      + "or run `codex plugin add vibe@closedloop-ai` then quit and reopen the Codex app.");
    expect(NOTICE_EVENTS, "Daniel's ruling: the notice goes out only on UserPromptSubmit").toEqual(["UserPromptSubmit"]);
    expect(Object.isFrozen(NOTICE_EVENTS)).toBe(true);
    expect(SHIM_CONTRACTS).toEqual([1]);
    expect([sharedContract([1, 2], [2, 3]), sharedContract([1, 2], [1, 2]), sharedContract([1], [2])]).toEqual([2, 2, null]);
  });
});

describe("vibe-core stubs", () => {
  it("tell a vibe older than vibe-core to update it, run or imported, and exit 1 (a hook-command stub 0) without refusing", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-core-stubs-")));
    roots.push(root);
    for (const stub of STUB_FILES) {
      const file = join(VIBE_CORE_DIR, stub);
      const direct = spawnSync(process.execPath, [file], { encoding: "utf8", input: "{}" });
      expect([direct.status, direct.stdout, direct.stderr], stub).toEqual([HOOK_COMMAND_STUBS.includes(stub) ? 0 : 1, "", UPDATE_VIBE]);
    }
    const importer = join(root, "importer.mjs");
    writeFileSync(importer, `const { anything } = await import(${JSON.stringify(pathToFileURL(join(VIBE_CORE_DIR, STUB_FILES[0] as string)).href)});\nprocess.stdout.write("after");\n`);
    const imported = spawnSync(process.execPath, [importer], { encoding: "utf8" });
    expect([imported.status, imported.stdout, imported.stderr]).toEqual([1, "", UPDATE_VIBE]);
  }, SPAWN_TIMEOUT);
});
