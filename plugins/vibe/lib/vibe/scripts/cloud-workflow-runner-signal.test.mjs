// The stale-entry sweep against a runner that was really killed (ADV-R11-4). The test starts its own child process and
// signals only that child; it runs on the isolated Linux test host and in CI, never on the development machine. A
// runner killed mid-lane never reaches its release (team-lead, 2026-11-25): the next grant's sweep removes its entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { makeHome } from "../../../skills/vibe/scripts/test-fixtures.mjs";
import { grantActorSudo } from "./cloud-workflow-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VISUDO_PASSES = () => ({ exitCode: 0, detail: "" });

/** A child that takes one grant in `directory`, as a root runner's lane does, says so, and then waits to be stopped. */
function startHolder(directory) {
  const holder = `import { grantActorSudo } from ${JSON.stringify(pathToFileURL(path.join(here, "cloud-workflow-runner.mjs")).href)};
grantActorSudo({ actor: { uid: 65534, gid: 65534 }, run: () => ({ exitCode: 0 }), cwd: process.cwd(), env: {}, directory: ${JSON.stringify(directory)},
  check: () => ({ exitCode: 0, detail: "" }) });
process.stdout.write("granted\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holder], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const granted = new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { if (String(data).includes("granted")) resolve(); });
    exited.then(({ code, signal }) => reject(new Error(`the holder exited ${code ?? signal} before its grant`)));
  });
  return { child, granted, exited };
}

test("AC-68 the next grant removes the entry of a runner killed mid-lane (ADV-R11-4)", async (t) => {
  const f = makeHome("sudoers-signal-");
  t.after(f.cleanup);
  const directory = path.join(f.root, "sudoers.d");
  mkdirSync(directory);
  const { child, granted, exited } = startHolder(directory);
  await granted;
  child.kill("SIGKILL");
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  const [stale] = readdirSync(directory);
  assert.match(stale, new RegExp(`^vibe-workflow-lane-${child.pid}-[0-9a-f]{8}$`), "a killed runner's entry stays until the next grant");
  const release = grantActorSudo({ actor: { uid: 65534, gid: 65534 }, run: () => ({ exitCode: 0 }), cwd: directory, env: {}, directory,
    check: VISUDO_PASSES });
  try {
    assert.deepEqual(readdirSync(directory).filter((name) => name === stale), [], "the dead runner's entry is gone");
    assert.equal(readdirSync(directory).length, 1, "only this lane's own entry remains");
  } finally { release(); }
});
