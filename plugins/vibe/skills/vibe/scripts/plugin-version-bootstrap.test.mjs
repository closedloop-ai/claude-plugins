// A Codex vibe update installs no dependency, so vibe 1.1.71 can be installed with no vibe-core. These run the
// startup commands from such an install (a copy of this vibe in Codex's cache layout), not from the checkout,
// where vibe-core is always beside it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VIBE_CORE_MIN } from "../../../shared/vibe-core.mjs";

const VIBE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APPROVE = "open Codex once and approve vibe-core's hooks in /hooks";

/** vibe's scripts in a Codex cache with no vibe-core, and a fake Codex whose `plugin add vibe-core` installs one. */
function codexInstall(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-no-core-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "codex-home", "plugins", "cache", "closedloop-ai");
  const vibe = path.join(cache, "vibe", "1.1.71");
  const keep = (file) => !file.endsWith(".test.mjs") && !file.includes(`${path.sep}dist${path.sep}`) && !file.endsWith(`${path.sep}dist`);
  for (const part of [".claude-plugin", ".codex-plugin", "shared", "skills/vibe/scripts", "skills/fleet-orchestrator/scripts"]) {
    cpSync(path.join(VIBE, part), path.join(vibe, part), { recursive: true, filter: keep });
  }
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const calls = path.join(root, "codex-calls.txt");
  writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
if (a.join(" ") === "plugin add vibe-core@closedloop-ai") {
  fs.cpSync(${JSON.stringify(path.join(VIBE, "..", "vibe-core"))}, ${JSON.stringify(path.join(cache, "vibe-core", "1.0.0"))}, { recursive: true });
} else if (a[0] === "app-server") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (text) => {
    const message = JSON.parse(text);
    const reply = (value) => process.stdout.write(JSON.stringify({ id: message.id, ...value }) + "\\n");
    if (message.id === "initialize") reply({ result: {} });
    else if (message.id) reply({ result: { data: [{ hooks: [{ key: "vibe-core@closedloop-ai:hooks/hooks.json:pre_tool_use:0:0",
      pluginId: "vibe-core@closedloop-ai", trustStatus: "untrusted", enabled: true }] }] } });
  });
} else process.exit(2);
`);
  chmodSync(path.join(bin, "codex"), 0o755);
  const home = path.join(root, "home");
  mkdirSync(home);
  const run = (script, args) => spawnSync(process.execPath, [path.join(vibe, script), ...args], {
    encoding: "utf8", cwd: root, timeout: 60_000, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_THREAD_ID: "thread-1" } });
  return { root, cache, run, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []) };
}

test("without vibe-core, check and status report it missing with its add command and exit 0 with their usual JSON", (t) => {
  const f = codexInstall(t);
  const check = f.run("skills/vibe/scripts/plugin-version.mjs", ["check", "--runtime", "codex", "--closedloop", "connected", "--graph", "connected"]);
  assert.equal(check.status, 0, check.stderr);
  assert.doesNotMatch(check.stderr, /^\s+at /m);
  const result = JSON.parse(check.stdout);
  assert.equal(result.status, "outdated");
  assert.equal(result.versions, "vibe-core: not installed");
  assert.deepEqual(result.outdated, [{ harness: "codex", plugin: "vibe-core", installed: null, latest: null, missing: true }]);
  assert.match(result.fix, /\/bin\/codex plugin add vibe-core@closedloop-ai$/);
  assert.equal(result.print, true);
  assert.deepEqual(result.block.split("\n"), [
    "Setup check",
    "- Codex: vibe-core not installed",
    `- Codex: vibe-core is not installed in Codex, so vibe's guards cannot run there: run \`codex plugin add vibe-core@closedloop-ai\`, then ${APPROVE}`,
    "- ClosedLoop connection: connected",
    "- closedloop-graph connection: connected",
  ]);
  const status = f.run("skills/vibe/scripts/plugin-version.mjs", ["status", "--closedloop", "connected", "--graph", "not-connected"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(JSON.parse(status.stdout).block, /- Codex: vibe-core not installed\n(?:.*\n){2}- closedloop-graph connection: not connected$/);
  assert.deepEqual(f.calls(), [], "nothing is installed by a check");
});

test("without vibe-core, the chosen update runs codex plugin add vibe-core and names the approval its new hooks need", (t) => {
  const f = codexInstall(t);
  assert.equal(JSON.parse(f.run("skills/vibe/scripts/plugin-version.mjs", ["choose", "--choice", "update"]).stdout).ok, true);
  const refused = f.run("skills/vibe/scripts/plugin-version.mjs", ["update"]);
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout).error, /^the person has not chosen to update here; once they say update, run update --choice update/);
  assert.deepEqual(f.calls(), [], "nothing records the answer without vibe-core, so a bare update installs nothing");
  const update = f.run("skills/vibe/scripts/plugin-version.mjs", ["update", "--choice", "update"]);
  assert.equal(update.status, 0, update.stderr);
  const result = JSON.parse(update.stdout);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.restart, ["codex"]);
  assert.equal(f.calls()[0], "plugin add vibe-core@closedloop-ai");
  assert.ok(existsSync(path.join(f.cache, "vibe-core", "1.0.0", "hooks", "hooks.json")));
  assert.equal(result.hookApproval, `vibe-core's hooks are not approved in Codex (vibe-core@closedloop-ai:hooks/hooks.json:pre_tool_use:0:0 is untrusted), so vibe's guards cannot run there: ${APPROVE}`);
});

test("without vibe-core, a moved command such as fleet-home.mjs resume says what is missing instead of a stack trace", (t) => {
  const f = codexInstall(t);
  const resume = f.run("skills/fleet-orchestrator/scripts/fleet-home.mjs", ["resume", "--home", path.join(f.root, "fleet")]);
  assert.equal(resume.status, 2);
  assert.equal(resume.stdout, "");
  assert.match(resume.stderr, /^fleet-home\.mjs: vibe-core is not installed beside vibe \(codex layout\); install it with `claude plugin install vibe-core@closedloop-ai` in Claude Code or `codex plugin add vibe-core@closedloop-ai` in Codex\n$/);
});

test("with a vibe-core older than this vibe needs, check says which version is installed and which it needs", (t) => {
  const f = codexInstall(t);
  const core = path.join(f.cache, "vibe-core", "0.9.0");
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    mkdirSync(path.join(core, manifest), { recursive: true });
    writeFileSync(path.join(core, manifest, "plugin.json"), JSON.stringify({ name: "vibe-core", version: "0.9.0" }));
  }
  const check = f.run("skills/vibe/scripts/plugin-version.mjs", ["check", "--closedloop", "connected", "--graph", "connected"]);
  assert.equal(check.status, 0, check.stderr);
  const result = JSON.parse(check.stdout);
  assert.equal(result.versions, `vibe-core: you have 0.9.0, this vibe needs ${VIBE_CORE_MIN} or newer`);
  assert.deepEqual(result.block.split("\n").slice(1, 3), [
    `- Codex: vibe-core 0.9.0 is older than this vibe needs (>= ${VIBE_CORE_MIN})`,
    `- Codex: vibe's guards cannot load it: run \`${result.fix}\``,
  ]);
});
