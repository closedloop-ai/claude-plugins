// Fixtures for the vibe-core version-skew tests: a copy of the vibe-core in this checkout laid out as a repository
// checkout, a Claude Code install or a Codex install, beside fixture vibes of any age, and its hook entry files run
// the way a harness runs them (stdin event, HOME and CODEX_HOME pointed at the fixture).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ownPluginRoot, pluginManifest } from "./plugin-roots.mjs";

/** This vibe's root, and the vibe-core beside it in the checkout the tests run from. */
export const VIBE_SOURCE = ownPluginRoot(import.meta.url).root;
export const CORE_SOURCE = path.join(path.dirname(VIBE_SOURCE), "vibe-core");
export const CORE_VERSION = pluginManifest(CORE_SOURCE).version;
export const MARKETPLACE = "closedloop-ai";
export const Layout = Object.freeze({ Checkout: "checkout", Claude: "claude", Codex: "codex" });
export const LAYOUTS = Object.freeze(Object.values(Layout));

const shim = await import(pathToFileURL(path.join(CORE_SOURCE, "hooks", "vibe-runtime.mjs")).href);
/** The slim core's exports these tests drive. */
export const { degradedNotice, NOTICE_EVENTS } = shim;
/** The hook contracts the slim core speaks. */
export const CORE_CONTRACTS = shim.SHIM_CONTRACTS;
/** The slim core's tri-state lookup of the vibe a session uses. */
export const { vibeLookup } = await import(pathToFileURL(path.join(CORE_SOURCE, "shared", "vibe-install.mjs")).href);

/** Every event core's hooks.json registers, with the entry file (relative to core's root) its command runs. */
export const ENTRIES = Object.freeze(Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(CORE_SOURCE, "hooks", "hooks.json"), "utf8")).hooks)
  .map(([event, groups]) => {
    const commands = groups.flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(commands.length, 1, `${event} registers one command`);
    const entry = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(commands[0])?.[1];
    assert.ok(entry, `${event}'s command runs one file under the plugin root: ${commands[0]}`);
    return [event, entry];
  })));
export const EVENTS = Object.freeze(Object.keys(ENTRIES));

const SENTINEL = "\u0000reason\u0000";
const [NOTICE_HEAD, NOTICE_TAIL] = degradedNotice(SENTINEL).split(SENTINEL);
const MARKER = "MARKER ";

/** Fixture hooks/runtime.mjs sources: a vibe serving the contract, and the broken kinds a harness can meet. */
export const Runtime = Object.freeze({
  /** Serves `contracts`; runHook echoes what it was given under `marker`, in the output form `input.want` asks for. */
  marker: (marker, contracts = CORE_CONTRACTS) => `export const CONTRACTS = Object.freeze(${JSON.stringify(contracts)});
export function runHook({ event, input, core }) {
  const seen = ${JSON.stringify(MARKER)} + JSON.stringify({ marker: ${JSON.stringify(marker)}, event, probe: input?.probe ?? null, core });
  if (input?.want === "null") return null;
  if (input?.want === "string" || event === "PreCompact") return seen;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: seen } };
}
`,
  throwsOnImport: "throw new Error(\"half-written runtime\");\n",
  noRunHook: `export const CONTRACTS = Object.freeze(${JSON.stringify(CORE_CONTRACTS)});\n`,
  contractsNotList: "export const CONTRACTS = 1;\nexport function runHook() { return null; }\n",
  rejects: `export const CONTRACTS = Object.freeze(${JSON.stringify(CORE_CONTRACTS)});\nexport async function runHook() { throw new Error("guard failed"); }\n`,
  throws: `export const CONTRACTS = Object.freeze(${JSON.stringify(CORE_CONTRACTS)});\nexport function runHook() { throw new Error("guard failed"); }\n`,
});

/** A contract number no released vibe-core speaks. */
export function unknownContract() {
  return Math.max(...CORE_CONTRACTS) + 1;
}

/** A temporary root (a real path under the OS temp folder, which the state-isolation guard accepts), removed after `t`. */
export function tempRoot(t, label) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `vibe-skew-${label}-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Writes a plugin root at `dir`: both manifests, and `files` ({ relative: text }). */
export function writePlugin(dir, { name, version }, files = {}) {
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    mkdirSync(path.join(dir, manifest), { recursive: true });
    writeFileSync(path.join(dir, manifest, "plugin.json"), JSON.stringify({ name, version }));
  }
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), text);
  }
  return dir;
}

/**
 * A fixture vibe's files: `runtime` is hooks/runtime.mjs's source (null for a vibe from before the slim core, which
 * has none) and `ownHooks` adds the hooks/hooks.json a vibe of 1.1.70 or older registers its own hooks with.
 */
function vibeFiles({ runtime = null, ownHooks = false } = {}) {
  return { ...(runtime === null ? {} : { "hooks/runtime.mjs": runtime }), ...(ownHooks ? { "hooks/hooks.json": "{}\n" } : {}) };
}

/** Copies this checkout's vibe-core (no tests) to `dest`. */
export function copyCore(dest) {
  cpSync(CORE_SOURCE, dest, { recursive: true, filter: (file) => !file.endsWith(".test.mjs") && !file.includes(`${path.sep}node_modules`) });
  return dest;
}

/**
 * A machine with the slim vibe-core installed in `layout`, a project folder, and helpers to add vibes, enable or
 * disable them, and run a hook event. Vibes are `{ name, version, runtime?, ownHooks? }`.
 */
export function machine(t, layout, vibes = []) {
  const root = tempRoot(t, layout);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(project, { recursive: true });
  const claudeHome = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const harnessHome = layout === Layout.Codex ? codexHome : claudeHome;
  const cache = path.join(harnessHome, "plugins", "cache", MARKETPLACE);
  const plugins = path.join(root, "repo", "plugins");
  const core = layout === Layout.Checkout ? path.join(plugins, "vibe-core") : path.join(cache, "vibe-core", CORE_VERSION);
  copyCore(core);
  const registry = path.join(claudeHome, "plugins", "installed_plugins.json");
  const entries = { [`vibe-core@${MARKETPLACE}`]: [{ scope: "user", installPath: core }] };
  const writeRegistry = () => writeFileSync(registry, JSON.stringify({ version: 2, plugins: entries }));
  if (layout === Layout.Claude) writeRegistry();
  const roots = {};
  const codexEnabled = {};
  const m = {
    root, home, project, core, cache, registry, roots, layout,
    /** Installs `vibe`; in Claude Code it becomes the user install of its name unless `register` is false. */
    add(vibe, { register = true } = {}) {
      const dir = layout === Layout.Checkout ? path.join(plugins, vibe.folder ?? (vibe.name === "vibe-generic" ? "vibe" : "vibe-built"))
        : path.join(cache, vibe.name, vibe.version);
      writePlugin(dir, vibe, vibeFiles(vibe));
      roots[`${vibe.name}@${vibe.version}`] = realpathSync(dir);
      if (layout === Layout.Claude && register) m.register(vibe.name, [{ scope: "user", installPath: dir }]);
      return realpathSync(dir);
    },
    /** Replaces the Claude Code registry entries of plugin `name`. */
    register(name, list) {
      entries[`${name}@${MARKETPLACE}`] = list;
      writeRegistry();
    },
    /** Turns plugin `name` on or off where the harness keeps that setting (Claude Code user settings, Codex config.toml). */
    enable(name, enabled) {
      if (layout === Layout.Codex) {
        codexEnabled[name] = enabled;
        mkdirSync(codexHome, { recursive: true });
        writeFileSync(path.join(codexHome, "config.toml"), Object.entries(codexEnabled)
          .map(([plugin, on]) => `[plugins."${plugin}@${MARKETPLACE}"]\nenabled = ${on}\n`).join("\n"));
      } else {
        const file = path.join(claudeHome, "settings.json");
        let settings = {};
        try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { settings = {}; }
        mkdirSync(claudeHome, { recursive: true });
        writeFileSync(file, JSON.stringify({ ...settings, enabledPlugins: { ...settings.enabledPlugins, [`${name}@${MARKETPLACE}`]: enabled } }));
      }
    },
    /** Runs `event`'s hook entry file of the core at `coreRoot` with `input` merged into a minimal event. */
    run(event, input = {}, coreRoot = core) {
      return runEntry(path.join(coreRoot, ENTRIES[event]), { session_id: "skew-session", hook_event_name: event, cwd: project, ...input },
        { cwd: project, home });
    },
  };
  for (const vibe of vibes) m.add(vibe);
  return m;
}

/** Runs hook file `file` as a harness does: `event` as JSON on stdin, from `cwd`, with HOME at `home`. */
export function runEntry(file, event, { cwd, home }) {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  for (const key of ["CLAUDE_PLUGIN_ROOT", "CLAUDE_CONFIG_DIR", "CODEX_THREAD_ID"]) Reflect.deleteProperty(env, key);
  // The bound is for a hung child only; nothing asserts on time.
  return spawnSync(process.execPath, [file], { cwd, env, input: JSON.stringify(event), encoding: "utf8", timeout: 60_000 });
}

/**
 * Asserts the output never blocks the harness: exit 0 and no signal, and stdout empty, one plain-text block (a
 * string the runtime returned), or exactly one JSON object with no permission decision anywhere in it.
 */
export function assertNeverBlocks(result, label = "") {
  assert.equal(result.error, undefined, `${label}: ${result.error}`);
  assert.equal(result.signal, null, label);
  assert.equal(result.status, 0, `${label}: exit ${result.status}; stderr: ${result.stderr}`);
  const text = result.stdout.trim();
  if (!text.startsWith("{")) return;
  const output = JSON.parse(text);
  assert.equal(typeof output, "object", label);
  const json = JSON.stringify(output);
  assert.doesNotMatch(json, /"(?:permissionDecision|decision)"\s*:\s*"(?:deny|block)"/, `${label}: no refusal`);
}

/** Asserts a silent stand-down: exit 0, nothing on stdout, no degraded notice anywhere. */
export function assertSilent(result, label = "") {
  assertNeverBlocks(result, label);
  assert.equal(result.stdout, "", `${label}: stdout`);
  assert.ok(!mentionsNotice(result.stderr), `${label}: no notice on stderr: ${result.stderr}`);
}

/** Whether `text` carries the degraded notice anywhere. */
export function mentionsNotice(text) {
  return text.includes(NOTICE_HEAD);
}

/** The reason in `text` when it is the degraded notice (the ruled sentence around a non-empty reason), else null. */
function noticeReason(text) {
  const at = text.indexOf(NOTICE_HEAD);
  if (at < 0 || !text.endsWith(NOTICE_TAIL)) return null;
  const reason = text.slice(at + NOTICE_HEAD.length, text.length - NOTICE_TAIL.length);
  return reason.trim() === "" ? null : reason;
}

/**
 * Asserts the degraded state for `event`: exit 0 and, on a NOTICE_EVENTS event, exactly
 * `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<notice>}}` on stdout, returning the reason
 * the notice names; on any other event the action proceeds silently (nothing on stdout, no notice on stderr) and
 * this returns null.
 */
export function assertDegraded(result, event, label = "") {
  assertNeverBlocks(result, `${label} ${event}`);
  if (!NOTICE_EVENTS.includes(event)) {
    assertSilent(result, `${label} ${event}`);
    return null;
  }
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"], `${label} ${event}: only hookSpecificOutput`);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"], `${label} ${event}`);
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  const reason = noticeReason(output.hookSpecificOutput.additionalContext);
  assert.ok(reason, `${label} ${event}: the notice: ${output.hookSpecificOutput.additionalContext}`);
  return reason;
}

/** Asserts the fixture runtime served `event` and returns what it saw ({ marker, event, probe, core }). */
export function assertServed(result, event, marker, label = "") {
  assertNeverBlocks(result, `${label} ${event}`);
  const text = result.stdout.trim();
  const seenText = text.startsWith("{") ? JSON.parse(text).hookSpecificOutput.additionalContext : text;
  assert.ok(seenText.startsWith(MARKER), `${label} ${event}: served by a fixture runtime: ${result.stdout}${result.stderr}`);
  const seen = JSON.parse(seenText.slice(MARKER.length));
  assert.equal(seen.marker, marker, `${label} ${event}: served by the expected vibe`);
  assert.equal(seen.event, event, `${label}: the event name reaches runHook`);
  return seen;
}
