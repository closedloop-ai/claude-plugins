import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookApprovalWatch } from "./hook-approval.mjs";
import { APPROVE_HOOKS, HookApproval, hookApprovalFromClient } from "../../vibe/scripts/vibe-core-hooks.mjs";

const SCRIPT = fileURLToPath(new URL("./hook-approval.mjs", import.meta.url));
const KEY = "vibe-core@market:hooks/hooks.json:pre_tool_use:0:0";

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "hook-approval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A hooks/list answer counter: each call returns `approval` and is counted. */
function approvals(approval) {
  const asked = { count: 0 };
  return { asked, approval: async () => { asked.count += 1; return approval; } };
}

test("a version change with every vibe-core hook trusted says nothing", async (t) => {
  const dir = stateDir(t);
  const { asked, approval } = approvals({ state: HookApproval.Approved });
  const first = await hookApprovalWatch("local", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.0" }, approval });
  assert.deepEqual(first, { line: null, checked: true });
  const updated = await hookApprovalWatch("local", dir, { versions: { vibe: "1.1.72", "vibe-core": "1.0.0" }, approval });
  assert.deepEqual(updated, { line: null, checked: true });
  assert.equal(asked.count, 2);
});

test("a version change that leaves a vibe-core hook modified raises one alert, keeps it unchanged while it is needed, and clears it once approved", async (t) => {
  const dir = stateDir(t);
  const trusted = approvals({ state: HookApproval.Approved });
  await hookApprovalWatch("remote", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.0" }, approval: trusted.approval });
  const modified = approvals({ state: HookApproval.Needed, blocked: [`${KEY} is modified`] });
  const alert = await hookApprovalWatch("remote", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.1" }, approval: modified.approval });
  assert.equal(alert.checked, true);
  assert.equal(alert.line, `HOOK-APPROVAL remote vibe 1.1.71 vibe-core 1.0.1: vibe-core's hooks are not approved in Codex (${KEY} is modified), so vibe's guards cannot run there: ${APPROVE_HOOKS}`);
  // The watcher diffs whole passes: the same line on the next pass is no new event. While it is needed, hooks/list
  // is asked again so the line goes away once the person approves.
  const next = await hookApprovalWatch("remote", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.1" }, approval: modified.approval });
  assert.deepEqual(next, { line: alert.line, checked: true });
  assert.equal(modified.asked.count, 2);
  const approved = await hookApprovalWatch("remote", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.1" }, approval: trusted.approval });
  assert.deepEqual(approved, { line: null, checked: true });
  const settled = await hookApprovalWatch("remote", dir, { versions: { vibe: "1.1.71", "vibe-core": "1.0.1" }, approval: modified.approval });
  assert.deepEqual(settled, { line: null, checked: false }, "an approved answer is final for that version: no re-ask, no re-alert");
  assert.equal(modified.asked.count, 2);
});

test("an answer that could not be read is retried, and its alert still comes once the check succeeds", async (t) => {
  const dir = stateDir(t);
  const versions = { vibe: "1.1.71", "vibe-core": "1.0.0" };
  const unchecked = approvals({ state: HookApproval.Unchecked, reason: "Codex hook listing timed out" });
  const first = await hookApprovalWatch("local", dir, { versions, approval: unchecked.approval });
  assert.equal(first.line, "HOOK-APPROVAL local vibe 1.1.71 vibe-core 1.0.0: couldn't check whether vibe-core's hooks are approved in Codex (Codex hook listing timed out)");
  assert.deepEqual(await hookApprovalWatch("local", dir, { versions, approval: unchecked.approval }), { line: first.line, checked: true });
  const needed = approvals({ state: HookApproval.Needed, blocked: [`${KEY} is untrusted`] });
  const alert = await hookApprovalWatch("local", dir, { versions, approval: needed.approval });
  assert.match(alert.line, /is untrusted\), so vibe's guards cannot run there: open Codex once and approve vibe-core's hooks in \/hooks$/);
  assert.equal(unchecked.asked.count, 2);
});

test("a missing vibe-core names its add command; an older vibe, an unreadable listing or no hooks/list are handled plainly", async (t) => {
  const dir = stateDir(t);
  const never = approvals({ state: HookApproval.Approved });
  const missing = await hookApprovalWatch("local", dir, { versions: { vibe: "1.1.71", "vibe-core": null }, approval: never.approval });
  assert.match(missing.line, /^HOOK-APPROVAL local vibe 1\.1\.71 vibe-core none: vibe-core is not installed in Codex, .*run `codex plugin add vibe-core@closedloop-ai`, then open Codex once and approve vibe-core's hooks in \/hooks$/);
  assert.equal(never.asked.count, 0, "nothing to list without vibe-core");
  const older = await hookApprovalWatch("local", stateDir(t), { versions: { vibe: "1.1.70", "vibe-core": null }, approval: never.approval });
  assert.deepEqual(older, { line: null, checked: true }, "a vibe that still runs its own hooks needs no vibe-core");
  assert.deepEqual(await hookApprovalWatch("local", dir, { versions: null, approval: never.approval }), { line: missing.line, checked: false });
  const unchecked = approvals({ state: HookApproval.Unchecked, reason: "this Codex App Server has no hooks/list" });
  const old = await hookApprovalWatch("local", stateDir(t), { versions: { vibe: "1.1.71", "vibe-core": "1.0.0" }, approval: unchecked.approval });
  assert.equal(old.line, "HOOK-APPROVAL local vibe 1.1.71 vibe-core 1.0.0: couldn't check whether vibe-core's hooks are approved in Codex (this Codex App Server has no hooks/list)");
});

test("the command reads the installed Codex plugins and the App Server's hooks/list", (t) => {
  const dir = stateDir(t);
  const bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a.join(" ") === "plugin list --json") {
  const plugin = (name, version) => ({ pluginId: name + "@market", name, marketplaceName: "closedloop-ai", version, installed: true, enabled: true });
  process.stdout.write(JSON.stringify({ installed: [plugin("vibe", "1.1.71"), plugin("vibe-core", "1.0.0")] }));
} else if (a[0] === "app-server") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (text) => {
    const message = JSON.parse(text);
    if (message.id === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    else if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ hooks: [
      { key: ${JSON.stringify(KEY)}, pluginId: "vibe-core@market", trustStatus: "untrusted", enabled: true }] }] } }) + "\\n");
  });
}
`);
  chmodSync(join(bin, "codex"), 0o755);
  const run = () => spawnSync(process.execPath, [SCRIPT, "local", join(dir, "state")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, timeout: 30_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `HOOK-APPROVAL local vibe 1.1.71 vibe-core 1.0.0: vibe-core's hooks are not approved in Codex (${KEY} is untrusted), so vibe's guards cannot run there: ${APPROVE_HOOKS}\n`);
  assert.equal(run().stdout, first.stdout, "a stable line, so the watcher raises no second event");
});

test("an App Server without hooks/list is final for that version, so no App Server is started on every pass", async (t) => {
  const dir = stateDir(t);
  const versions = { vibe: "1.1.71", "vibe-core": "1.0.0" };
  const old = approvals({ state: HookApproval.Unchecked, reason: "this Codex App Server has no hooks/list", final: true });
  const first = await hookApprovalWatch("local", dir, { versions, approval: old.approval });
  assert.match(first.line, /couldn't check whether vibe-core's hooks are approved in Codex \(this Codex App Server has no hooks\/list\)$/);
  assert.deepEqual(await hookApprovalWatch("local", dir, { versions, approval: old.approval }), { line: first.line, checked: false });
  assert.equal(old.asked.count, 1);
  const updated = await hookApprovalWatch("local", dir, { versions: { ...versions, "vibe-core": "1.0.1" }, approval: old.approval });
  assert.equal(updated.checked, true, "a new version asks again");
});

test("only a missing hooks/list method is final; a timeout or a closed connection is retried", async () => {
  const failing = (message) => ({ request: async () => { throw new Error(message); } });
  assert.deepEqual(await hookApprovalFromClient(failing("Codex hook listing request failed: unknown variant `hooks/list`"), "/x"),
    { state: HookApproval.Unchecked, reason: "this Codex App Server has no hooks/list", final: true });
  for (const message of ["Codex hook listing timed out", "Codex hook listing closed before answering"]) {
    assert.deepEqual(await hookApprovalFromClient(failing(message), "/x"), { state: HookApproval.Unchecked, reason: message });
  }
});
