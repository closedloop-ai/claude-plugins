import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBounded, TIMED_OUT_EXIT } from "./run-bounded.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-bounded.mjs");

test("a command that finishes in time keeps its own output and exit code", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "20", process.execPath, "-e",
    "process.stdout.write('done'); process.exit(3)"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.stdout, "done");
  assert.equal(result.status, 3);
});

test("a command past its limit is stopped with everything it started, exiting 124", async () => {
  // The child starts a grandchild that would outlive a plain kill of the child.
  const code = await runBounded(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(grandchild.pid));
    setInterval(() => {}, 1000);
  `], { seconds: 1, stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(code, TIMED_OUT_EXIT);
});

test("the stopped command's whole process group is gone after a time out", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "1", process.execPath, "-e", `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, TIMED_OUT_EXIT, result.stderr);
  assert.match(result.stderr, /stopped after 1s/);
  const grandchild = Number(result.stdout.trim());
  assert.ok(grandchild > 0);
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
});

test("a missing limit or command is refused instead of running unbounded", () => {
  const noLimit = spawnSync(process.execPath, [SCRIPT, "soon", "true"], { encoding: "utf8" });
  assert.equal(noLimit.status, 2);
  assert.match(noLimit.stderr, /positive number of seconds/);
  const noCommand = spawnSync(process.execPath, [SCRIPT, "5"], { encoding: "utf8" });
  assert.equal(noCommand.status, 2);
  assert.match(noCommand.stderr, /Usage/);
});
