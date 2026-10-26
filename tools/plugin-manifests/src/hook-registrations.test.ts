import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findHookRegistrationProblems, formatHookProblem } from "./hook-registrations.js";
import { CLAUDE_MANIFEST, CODEX_MANIFEST } from "./manifest-versions.js";

const REPO_PLUGINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "plugin-hooks-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

function writeJson(plugin: string, file: string, body: unknown): void {
  const path = join(pluginsDir, plugin, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

const command = (script: string) => ({ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"` });

describe("findHookRegistrationProblems", () => {
  it("reports vibe 1.0.81's layout: six PreToolUse commands across three matchers", () => {
    writeJson("vibe", "hooks/hooks.json", {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: ["kill-guard.mjs", "foreground-guard.mjs", "merge-guard.mjs", "shell-safety-guard.mjs"].map(command) },
          { matcher: "Agent", hooks: [command("agent-guard.mjs")] },
          { matcher: "SendMessage", hooks: [command("pause-guard.mjs")] },
        ],
        UserPromptSubmit: [{ hooks: [command("away-protocol.mjs")] }],
      },
    });

    expect(findHookRegistrationProblems(pluginsDir, {})).toEqual([
      { plugin: "vibe", event: "PreToolUse", count: 6, allowed: 1, sources: ["hooks/hooks.json"] },
    ]);
  });

  it("passes one command per event", () => {
    writeJson("vibe", "hooks/hooks.json", {
      hooks: {
        PreToolUse: [{ matcher: "Bash|Agent|SendMessage", hooks: [command("pre-tool-use.mjs")] }],
        UserPromptSubmit: [{ hooks: [command("user-prompt-submit.mjs")] }],
      },
    });

    expect(findHookRegistrationProblems(pluginsDir, {})).toEqual([]);
  });

  it("counts every plugin and every hook source, Codex and manifest hooks included", () => {
    writeJson("alpha", "hooks/hooks.json", { hooks: { Stop: [{ hooks: [command("a.mjs")] }] } });
    writeJson("alpha", ".codex/hooks.json", { hooks: { Stop: [{ hooks: [command("b.mjs")] }] } });
    writeJson("beta", CLAUDE_MANIFEST, { version: "1.0.0", hooks: "./extra/hooks-config.json" });
    writeJson("beta", "extra/hooks-config.json", { hooks: { SessionStart: [{ hooks: [command("a.mjs")] }] } });
    writeJson("beta", CODEX_MANIFEST, { version: "1.0.0", hooks: { SessionStart: [{ hooks: [command("b.mjs")] }] } });

    expect(findHookRegistrationProblems(pluginsDir, {})).toEqual([
      { plugin: "alpha", event: "Stop", count: 2, allowed: 1, sources: [".codex/hooks.json", "hooks/hooks.json"] },
      { plugin: "beta", event: "SessionStart", count: 2, allowed: 1, sources: [".codex-plugin/plugin.json (inline hooks)", "extra/hooks-config.json"] },
    ]);
  });

  it("counts a hooks.json named by a manifest once", () => {
    writeJson("alpha", CLAUDE_MANIFEST, { version: "1.0.0", hooks: ["./hooks/hooks.json"] });
    writeJson("alpha", "hooks/hooks.json", { hooks: { Stop: [{ hooks: [command("a.mjs")] }] } });

    expect(findHookRegistrationProblems(pluginsDir, {})).toEqual([]);
  });

  it("holds a grandfathered count exactly: more fails, and fewer fails until the entry shrinks", () => {
    const twoStops = (scripts: string[]) => writeJson("code", "hooks/hooks.json", { hooks: { Stop: scripts.map((script) => ({ hooks: [command(script)] })) } });

    twoStops(["a.sh", "b.sh"]);
    expect(findHookRegistrationProblems(pluginsDir, { code: { Stop: 2 } })).toEqual([]);

    twoStops(["a.sh", "b.sh", "c.sh"]);
    expect(findHookRegistrationProblems(pluginsDir, { code: { Stop: 2 } }).map(formatHookProblem)).toEqual([
      "plugins/code: Stop registers 3 hook handlers (hooks/hooks.json), allowed 2; register one script for the event and route to each guard inside it",
    ]);

    twoStops(["a.sh"]);
    expect(findHookRegistrationProblems(pluginsDir, { code: { Stop: 2 } }).map(formatHookProblem)).toEqual([
      "plugins/code: Stop now registers 1 hook handlers but GRANDFATHERED_HOOK_COUNTS allows 2; lower or delete the entry (it only shrinks)",
    ]);
  });

  it("reports a grandfathered entry for a plugin that no longer exists", () => {
    expect(findHookRegistrationProblems(pluginsDir, { gone: { Stop: 2 } })).toEqual([
      { plugin: "gone", event: "Stop", count: 0, allowed: 2, sources: [] },
    ]);
  });
});

describe("repository plugins", () => {
  it("register at most one hook handler per event", () => {
    const problems = findHookRegistrationProblems(REPO_PLUGINS_DIR).map(formatHookProblem);

    expect(problems, "one script per hook event; see AGENTS.md").toEqual([]);
  });
});
