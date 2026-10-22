import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, updateCommands } from "./plugin-version.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-version.mjs");
// Nothing listens here, so the check can never reach a real marketplace.
const UNREACHABLE = "http://127.0.0.1:9/plugin.json";

/** A plugin root whose two manifests carry `version`. */
function pluginRoot(t, version) {
  const fixture = makeHome("vibe-plugin-version-");
  t.after(fixture.cleanup);
  const root = path.join(fixture.root, "vibe");
  for (const dir of [".claude-plugin", ".codex-plugin"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "plugin.json"), JSON.stringify({ name: "vibe", version }));
  }
  return { root, fixtureRoot: fixture.root };
}

/** A local marketplace that answers every request with `status` and `body`, or never answers. */
async function marketplace(t, { status = 200, body = "", hang = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (hang) {
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/plugins/vibe/plugin.json`, requests };
}

/** A fake Codex CLI whose `plugin list --json` prints `listing`. */
function fakeCodex(dir, listing) {
  const file = path.join(dir, "codex");
  writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "plugin list --json" ] && printf '%s\\n' '${JSON.stringify(listing)}' && exit 0\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, result: JSON.parse(stdout) }));
  });
}

test("versions compare numerically and anything else is not comparable", () => {
  assert.equal(compareVersions("1.0.52", "1.0.53"), -1);
  assert.equal(compareVersions("1.0.53", "1.0.53"), 0);
  assert.equal(compareVersions("1.0.100", "1.0.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
  assert.equal(compareVersions("1.0.52", undefined), null);
});

test("an older install is outdated and carries Claude Code's update commands", async (t) => {
  const { root } = pluginRoot(t, "1.0.52");
  const latest = await marketplace(t, { body: JSON.stringify({ name: "vibe", version: "1.0.53" }) });
  const { code, result } = await run(["--runtime", "claude", "--plugin-root", root, "--latest-url", latest.url]);
  assert.equal(code, 0);
  assert.deepEqual(result, {
    status: "outdated",
    installed: "1.0.52",
    latest: "1.0.53",
    update: ["claude plugin marketplace update closedloop-ai", "claude plugin update vibe@closedloop-ai"],
  });
  assert.equal(latest.requests.length, 1);
});

test("an older Codex install updates from its Git marketplace, or pulls a local one", async (t) => {
  const { root, fixtureRoot } = pluginRoot(t, "1.0.52");
  const latest = await marketplace(t, { body: JSON.stringify({ version: "1.0.53" }) });
  const git = fakeCodex(fixtureRoot, {
    installed: [{ pluginId: "vibe@closedloop-ai", marketplaceSource: { sourceType: "git", source: "closedloop-ai/claude-plugins" } }],
  });
  const fromGit = await run(["--runtime", "codex", "--codex", git, "--plugin-root", root, "--latest-url", latest.url]);
  assert.equal(fromGit.result.status, "outdated");
  assert.deepEqual(fromGit.result.update, [
    `${git} plugin marketplace upgrade closedloop-ai`,
    `${git} plugin add vibe@closedloop-ai`,
    `${git} plugin add closedloop-core@closedloop-ai`,
  ]);

  const checkout = path.join(fixtureRoot, "Closedloop work", "claude-plugins");
  const local = fakeCodex(fixtureRoot, {
    installed: [{ pluginId: "vibe@closedloop-ai", marketplaceSource: { sourceType: "local", source: checkout } }],
  });
  const fromLocal = await run(["--runtime", "codex", "--codex", local, "--plugin-root", root, "--latest-url", latest.url]);
  assert.equal(fromLocal.result.update[0], `git -C '${checkout}' pull --ff-only`);
  assert.deepEqual(fromLocal.result.update.slice(1), [
    `${local} plugin add vibe@closedloop-ai`,
    `${local} plugin add closedloop-core@closedloop-ai`,
  ]);
});

test("the same or a newer install is current and carries no update", async (t) => {
  for (const [installed, newest] of [["1.0.53", "1.0.53"], ["1.0.54", "1.0.53"]]) {
    const { root } = pluginRoot(t, installed);
    const latest = await marketplace(t, { body: JSON.stringify({ version: newest }) });
    for (const runtime of ["claude", "codex"]) {
      const { code, result } = await run(["--runtime", runtime, "--codex", "/nonexistent/codex", "--plugin-root", root, "--latest-url", latest.url]);
      assert.equal(code, 0);
      assert.deepEqual(result, { status: "current", installed, latest: newest });
    }
  }
});

test("each harness compares its own manifest", async (t) => {
  const { root } = pluginRoot(t, "1.0.53");
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "1.0.51" }));
  const latest = await marketplace(t, { body: JSON.stringify({ version: "1.0.53" }) });
  assert.equal((await run(["--runtime", "claude", "--plugin-root", root, "--latest-url", latest.url])).result.status, "current");
  const codex = await run(["--runtime", "codex", "--codex", "/nonexistent/codex", "--plugin-root", root, "--latest-url", latest.url]);
  assert.equal(codex.result.status, "outdated");
  assert.equal(codex.result.installed, "1.0.51");
});

test("an unreachable, failing, slow or garbled marketplace is unknown and never fails the session", async (t) => {
  const { root } = pluginRoot(t, "1.0.52");
  const notFound = await marketplace(t, { status: 404, body: "Not Found" });
  const garbled = await marketplace(t, { body: "<html>" });
  const unversioned = await marketplace(t, { body: JSON.stringify({ name: "vibe" }) });
  const slow = await marketplace(t, { hang: true });
  const cases = [
    [UNREACHABLE, /could not be reached/],
    [notFound.url, /answered 404/],
    [garbled.url, /not JSON/],
    [unversioned.url, /cannot compare 1\.0\.52 with undefined/],
  ];
  for (const [url, reason] of cases) {
    const { code, result } = await run(["--runtime", "claude", "--plugin-root", root, "--latest-url", url]);
    assert.equal(code, 0);
    assert.equal(result.status, "unknown");
    assert.equal(result.installed, "1.0.52");
    assert.match(result.reason, reason);
    assert.equal(result.update, undefined);
  }
  const started = await run(["--runtime", "codex", "--codex", "/nonexistent/codex", "--plugin-root", root, "--latest-url", slow.url, "--timeout-ms", "200"]);
  assert.equal(started.code, 0);
  assert.equal(started.result.status, "unknown");
  assert.match(started.result.reason, /could not be reached/);
});

test("a missing installed manifest or runtime is unknown, not a failure", async (t) => {
  const { fixtureRoot } = pluginRoot(t, "1.0.52");
  const missing = await run(["--runtime", "claude", "--plugin-root", path.join(fixtureRoot, "nowhere"), "--latest-url", UNREACHABLE]);
  assert.equal(missing.code, 0);
  assert.equal(missing.result.status, "unknown");
  assert.match(missing.result.reason, /installed manifest could not be read/);
  const noRuntime = await run([]);
  assert.equal(noRuntime.code, 0);
  assert.deepEqual(noRuntime.result, { status: "unknown", installed: null, reason: "--runtime must be codex or claude" });
});

test("update commands quote paths with spaces", () => {
  assert.deepEqual(updateCommands("codex", { codex: "/Applications/My Apps/codex" }), [
    "'/Applications/My Apps/codex' plugin marketplace upgrade closedloop-ai",
    "'/Applications/My Apps/codex' plugin add vibe@closedloop-ai",
    "'/Applications/My Apps/codex' plugin add closedloop-core@closedloop-ai",
  ]);
});
