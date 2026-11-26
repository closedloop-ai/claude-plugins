/** Shared fixtures for the plugin-version suites: a bundled vibe copy, fake CLIs and a local marketplace. */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyVibe, makeHome } from "./test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
const { LoadBasis, loadedSkillEvidence } = await vibeCore("lib/vibe/scripts/loaded-skill.mjs");

export const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-version.mjs");
export const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..", "..", "..");
export const loaded = (actor = CONVERSATION, runtime = "claude") => loadedSkillEvidence(actor, runtime, PLUGIN_ROOT, "vibe", LoadBasis.HookObserved);
/** The plugin-version script of `copyVibe(root, options)`. */
export function copiedVibe(root, options) {
  return path.join(copyVibe(root, options), "skills", "vibe", "scripts", "plugin-version.mjs");
}

// The check as a vibe release built with the ClosedLoop provider runs it; this checkout's own vibe carries no provider.
const bundled = makeHome("vibe-plugin-version-bundled-");
export const BUNDLED_ROOT = bundled.root;
process.on("exit", bundled.cleanup);
const BUNDLED_SCRIPT = copiedVibe(BUNDLED_ROOT, { provider: true });
// Nothing listens here, so the check can never reach a real marketplace.
export const UNREACHABLE = "http://127.0.0.1:9";
export const CONVERSATION = "conversation-1";
// Only system tools: a real claude or codex on the developer's PATH must never be found.
export const SYSTEM_PATH = ["/usr/bin", "/bin"].join(path.delimiter);

/** A main branch whose marketplace files list `plugins` ({name: version}) under ./plugins/<name>. */
export function mainFiles(plugins) {
  const files = {
    "/.claude-plugin/marketplace.json": JSON.stringify({ name: "closedloop-ai", plugins: Object.keys(plugins).map((name) => ({ name, source: `./plugins/${name}` })) }),
    "/.agents/plugins/marketplace.json": JSON.stringify({ name: "closedloop-ai", plugins: Object.keys(plugins).map((name) => ({ name, source: { source: "local", path: `./plugins/${name}` } })) }),
  };
  for (const [name, version] of Object.entries(plugins)) {
    for (const dir of [".claude-plugin", ".codex-plugin"]) files[`/plugins/${name}/${dir}/plugin.json`] = JSON.stringify({ name, version });
  }
  return files;
}

/** A local stand-in for main that answers from `files`, or with `status`, or never. */
export async function marketplace(t, { files = {}, status, hang = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (hang) return;
    const body = files[request.url];
    response.writeHead(status ?? (body === undefined ? 404 : 200), { "content-type": "application/json" });
    response.end(body ?? "Not Found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/**
 * A fake `claude` or `codex` CLI backed by a JSON state file: `installed` ({name, version}),
 * `main` (the versions a refreshed marketplace offers), `fail` (an argv prefix that exits 1)
 * and `stuck` (an update that changes nothing). Every call is appended to `calls`.
 */
export function fakeCli(dir, kind, state) {
  const stateFile = path.join(dir, `${kind}-state.json`);
  writeFileSync(stateFile, JSON.stringify({ calls: [], refreshed: false, ...state }));
  const file = path.join(dir, kind);
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const a = process.argv.slice(2);
const line = a.join(" ");
s.calls.push(line);
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s));
if (s.fail && line.startsWith(s.fail)) { save(); process.stderr.write("boom: " + line + "\\n"); process.exit(1); }
// A Codex App Server that answers hooks/list from the installed plugins: one vibe-core hook, \`hookTrust\` (default trusted),
// or an App Server without hooks/list when \`noHooksList\` is set.
if (a[0] === "app-server") {
  save();
  require("node:readline").createInterface({ input: process.stdin }).on("line", (text) => {
    const message = JSON.parse(text);
    const reply = (value) => process.stdout.write(JSON.stringify({ id: message.id, ...value }) + "\\n");
    if (message.id === "initialize") reply({ result: {} });
    else if (message.id && message.method === "hooks/list") {
      if (s.noHooksList) return reply({ error: { message: "unknown variant \`hooks/list\`" } });
      const core = s.installed.some((p) => p.name === "vibe-core");
      reply({ result: { data: [{ cwd: process.cwd(), hooks: core ? [{ key: "vibe-core@closedloop-ai:hooks/hooks.json:pre_tool_use:0:0",
        pluginId: "vibe-core@closedloop-ai", trustStatus: s.hookTrust ?? "trusted", enabled: true }] : [] }] } });
    }
  });
  return;
}
const kind = ${JSON.stringify(kind)};
const refresh = (name) => {
  const p = s.installed.find((x) => x.name === name);
  if (p && s.refreshed && !s.stuck) p.version = s.main[name];
  else if (!p && s.refreshed && !s.stuck && s.main[name]) s.installed.push({ name, version: s.main[name] });
};
const localVersion = (name) => JSON.parse(fs.readFileSync(s.root + "/plugins/" + name + "/.codex-plugin/plugin.json", "utf8")).version;
if (line === "plugin list --json") {
  if (kind === "claude") process.stdout.write(JSON.stringify(s.installed.map((p) => ({ id: p.name + "@" + (p.market ?? "closedloop-ai"), version: p.version, scope: "user", enabled: p.enabled !== false }))));
  else process.stdout.write(JSON.stringify({ installed: s.installed.map((p) => ({ pluginId: p.name + "@" + (p.market ?? "closedloop-ai"), name: p.name, marketplaceName: p.market ?? "closedloop-ai", version: p.version, installed: true, enabled: p.enabled !== false, marketplaceSource: s.root ? { sourceType: "local", source: s.root } : { sourceType: "git", source: "https://example.invalid/claude-plugins.git" } })), available: [] }));
} else if (line === "plugin marketplace update closedloop-ai" || line === "plugin marketplace upgrade closedloop-ai") {
  s.refreshed = true;
} else if (kind === "claude" && a[0] === "plugin" && (a[1] === "update" || a[1] === "install")) {
  refresh(a[2].split("@")[0]);
} else if (kind === "codex" && a[0] === "plugin" && a[1] === "add") {
  const name = a[2].split("@")[0];
  if (s.root) { const p = s.installed.find((x) => x.name === name); p.version = localVersion(name); } else refresh(name);
} else { save(); process.exit(2); }
save();
`);
  chmodSync(file, 0o755);
  return { file, state: () => JSON.parse(readFileSync(stateFile, "utf8")) };
}

export function sandbox(t) {
  const fixture = makeHome("vibe-plugin-version-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  return { ...fixture, bin };
}

export function run(home, args, env = {}, script = BUNDLED_SCRIPT, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd,
      env: { PATH: SYSTEM_PATH, HOME: home, CLAUDE_CODE_SESSION_ID: CONVERSATION, CODEX_THREAD_ID: "", ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, result: JSON.parse(stdout) }));
  });
}

export const startup = (home) => JSON.parse(readFileSync(path.join(home, ".codex", "vibe", "plugin-version", `${CONVERSATION}.json`), "utf8"));
export const both = (claude, codex, url) => ["--claude", claude.file, "--codex", codex.file, "--latest-base", url];
