// Spawns a launcher child and kills it by the PID it spawned: run off a developer's primary machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { recoverValidationReservation, withCloudValidationAdmission } from "./cloud-validation-admission.mjs";
import { markerlessProvider, queueState, unreadableProvider } from "./cloud-validation-queue-test-fixture.mjs";
import { regularJson } from "./owned-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = "verified-fixture-account";
const LAUNCH = { routineId: "standing", launchToken: "5f0c1e0a-2b7d-4c8e-9a51-7d3f6b2e4c10", startedAt: "2026-11-25T00:00:00.000Z" };
// The launcher child holds request A's admission as `cloud-worker.mjs validate` does, then waits as its poll would.
const LAUNCHER = `
const [admission, owned, home, receipt, acknowledged] = process.argv.slice(1);
const { withCloudValidationAdmission } = await import(admission);
const { writeAtomic } = await import(owned);
const launch = ${JSON.stringify(LAUNCH)};
await withCloudValidationAdmission({ home, account: ${JSON.stringify(ACCOUNT)}, key: "A", receipt, metadata: { laneKeys: ["unit-1"] }, timeoutMs: 5000,
  recover: () => "terminal", report: () => {} }, async ({ launching }) => {
  await launching(launch);
  if (acknowledged === "acknowledged") {
    await launching({ ...launch, runId: "run-A", sessionId: "cse_A" });
    writeAtomic(receipt, { provider: "claude", routineId: "standing", runId: "run-A", taskId: "run-A", sessionId: "cse_A", status: "running",
      requestDigest: "A", launchToken: launch.launchToken, startedAt: launch.startedAt, laneKeys: ["unit-1"] });
  }
  process.stdout.write("HOLDING\\n");
  await new Promise(() => setInterval(() => {}, 1000));
});
`;

/** Start a launcher child, wait until it holds the admission, and end it with `signal` sent to the PID this test spawned. */
async function killedLauncher(t, signal, acknowledged) {
  const f = makeHome("vibe-cloud-validation-kill-");
  t.after(f.cleanup);
  const receipt = path.join(f.root, "receipt-A.json");
  const modules = ["cloud-validation-admission.mjs", "owned-state.mjs"].map((name) => pathToFileURL(path.join(here, name)).href);
  const child = spawn(process.execPath, ["--input-type=module", "-e", LAUNCHER, ...modules, f.home, receipt, acknowledged ? "acknowledged" : "unacknowledged"],
    { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.pid > 1 && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, ended) => resolve({ code, ended })));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("HOLDING")) resolve(); });
    exited.then(({ code }) => reject(new Error(`the launcher child exited ${code} before it held the admission: ${stderr}`)));
  });
  const held = queueState(f.home).active;
  assert.ok(child.pid > 1);
  assert.deepEqual([held.key, held.phase, held.pid], ["A", "launching", child.pid], "the live child holds request A's launch");
  child.kill(signal);
  assert.equal((await exited).ended, signal);
  return { ...f, receipt, held };
}

/** Request `key` asking for admission 15 minutes after the launch, past LAUNCH_WINDOW_MS, with `remote` as the provider. */
const admitLater = (f, key, receipt, remote, action) => withCloudValidationAdmission({ home: f.home, account: ACCOUNT, key, receipt, metadata: {}, timeoutMs: 300, sleepMs: 20,
  now: () => Date.now() + 15 * 60 * 1000, report: () => {}, recover: (entry) => recoverValidationReservation(entry, { ledger: { runs: [] }, remote }) }, action);
const BUSY = { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" };

test("ISS-14476 DT-156R a killed launcher whose launch no provider run acknowledged holds while the provider cannot be read and is reclaimed past its window once reads prove nothing", { timeout: 60_000 }, async (t) => {
  const f = await killedLauncher(t, "SIGTERM", false);
  assert.deepEqual([f.held.launch.runId, existsSync(f.receipt)], [undefined, false]);
  const other = path.join(f.root, "receipt-B.json");
  await assert.rejects(admitLater(f, "B", other, unreadableProvider, () => assert.fail("B was admitted while the provider could not be read")), BUSY);
  await assert.rejects(admitLater(f, "A", f.receipt, unreadableProvider, () => assert.fail("A launched again while the provider could not be read")), BUSY);
  assert.deepEqual([queueState(f.home).active.token, queueState(f.home).abandoned], [f.held.token, []]);
  assert.equal(await admitLater(f, "B", other, markerlessProvider, async () => "B admitted"), "B admitted");
  assert.deepEqual(queueState(f.home).abandoned, [{ key: "A", reason: "launcher exited during launch; no provider run was proven" }]);
});

test("ISS-14476 DT-156R DT-157R a launcher killed mid-poll keeps its running receipt past the window: another request holds and the identical request resumes", { timeout: 60_000 }, async (t) => {
  const f = await killedLauncher(t, "SIGKILL", true);
  assert.deepEqual([f.held.launch.runId, regularJson(f.receipt).status], ["run-A", "running"]);
  const other = path.join(f.root, "receipt-B.json");
  for (const [name, remote] of [["reports it running", () => ({ data: [{ id: "run-A", session_id: "cse_A", status: "running" }] })],
    ["does not list it", () => ({ data: [] })], ["cannot be read", unreadableProvider]]) {
    await assert.rejects(admitLater(f, "B", other, remote, () => assert.fail(`B was admitted while the provider ${name}`)), BUSY, name);
    assert.equal(regularJson(f.receipt).status, "running", `A's receipt stays running while the provider ${name}`);
    assert.equal(queueState(f.home).active.token, f.held.token, `A's reservation holds while the provider ${name}`);
  }
  assert.deepEqual(queueState(f.home).abandoned, []);
  const resumed = await admitLater(f, "A", f.receipt, unreadableProvider, async () => regularJson(f.receipt));
  assert.deepEqual([resumed.runId, resumed.sessionId, resumed.status], ["run-A", "cse_A", "running"], "the identical request resumes the run its receipt names");
});
