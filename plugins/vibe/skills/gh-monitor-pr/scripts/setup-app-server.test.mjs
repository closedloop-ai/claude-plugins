import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSetupArgs, probeThread } from "./setup-app-server.mjs";

test("preserves no-argument Desktop setup behavior", () => {
  assert.deepEqual(parseSetupArgs([], null), {
    command: "setup",
    surface: "desktop",
    threadId: null,
  });
});

test("parses explicit CLI setup with an exact owner thread", () => {
  assert.deepEqual(parseSetupArgs(["cli", "--thread-id", "thread-1"], null), {
    command: "setup",
    surface: "cli",
    threadId: "thread-1",
  });
});

test("parses a non-mutating CLI probe", () => {
  assert.deepEqual(parseSetupArgs(["probe", "--surface", "cli"], "thread-env"), {
    command: "probe",
    surface: "cli",
    threadId: "thread-env",
  });
});

test("requires exact thread identity for CLI setup", () => {
  assert.throws(() => parseSetupArgs(["cli"], null), /require --thread-id/);
});

test("awaits the notifier probe child lifecycle without a shorter parent deadline", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-setup-probe-")));
  const helper = join(root, "delayed-probe.mjs");
  writeFileSync(helper, `
setTimeout(() => process.stdout.write(JSON.stringify({
  result: "probed",
  transport: "proxy",
  threadStatus: "active",
  activeTurnId: "turn-active"
}) + "\\n"), 75);
`);
  try {
    const result = await probeThread({
      codex: join(root, "unused-codex"),
      helper,
      socket: join(root, "unused.sock"),
    }, "thread-exact");
    assert.equal(result.result, "probed");
    assert.equal(result.activeTurnId, "turn-active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
