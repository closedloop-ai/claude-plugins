import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changeWriter, readWriterSummary, registerWriter } from "./ledger.js";
import { bundleDirectory, fixture, graph } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
const entry = join(bundleDirectory, "writer-state.mjs");
function setup() {
  const value = fixture(); fixtures.push(value);
  registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "native-primary",
    agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
  return value;
}
function run(action: string, input: unknown) {
  return spawnSync(process.execPath, [entry, action], { input: JSON.stringify(input), encoding: "utf8" });
}
function concurrent(action: string, input: unknown) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, action], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.resume();
    child.once("error", reject); child.once("close", (code) => resolve({ code, output }));
    child.stdin.end(JSON.stringify(input));
  });
}
function grant(value: ReturnType<typeof fixture>) {
  return { worktree: value.worktree, agentRoot: value.agentRoot, agentName: "vibe-ticket-worker",
    workerId: "native-helper", requestId: "ticket-create", mode: "record", recordAction: "create", exclusiveRecordTurn: true };
}
function release(input: ReturnType<typeof grant>, lease: string) {
  return { ...input, lease, stoppedTurn: { runtime: "codex", workerId: input.workerId,
    requestId: input.requestId, lease, state: "completed" } };
}

describe("native helper record CLI", () => {
  it("retains the exact helper grant after the coordinator exits and refuses absent or wrong completion evidence", () => {
    const value = setup(); const input = grant(value);
    const acquired = run("acquire-record", input);
    expect(acquired.status, acquired.stderr).toBe(0);
    const { lease } = JSON.parse(acquired.stdout);
    const lock = join(value.metadata, "vibe-record-turn.lock");
    expect(existsSync(lock)).toBe(true);
    expect(run("release-record", { ...input, lease }).status).toBe(1);
    expect(run("release-record", release({ ...input, workerId: "other-helper" }, lease)).status).toBe(1);
    expect(run("release-record", release({ ...input, recordAction: "cancel" }, lease)).status).toBe(1);
    expect(run("release-record", { ...release(input, lease), stoppedTurn: {
      runtime: "codex", workerId: input.workerId, requestId: "different-request", lease, state: "completed" } }).status).toBe(1);
    expect(existsSync(lock)).toBe(true);
    expect(run("release-record", release(input, lease)).status).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(run("acquire-record", { ...input, agentName: "vibe-requirements-worker" }).status).toBe(1);
    expect(run("acquire-record", { ...input, agentName: "vibe-change-worker", recordAction: "progress",
      workerId: "different-primary" }).status).toBe(1);
    expect(run("acquire-record", { ...input, recordAction: "cancel" }).status).toBe(0);
  }, 10000);
  it("admits only one native helper acquisition or primary claim in a simultaneous production CLI race", async () => {
    const value = setup(); const helper = grant(value);
    const primary = { worktree: value.worktree, workerId: "native-primary", requestId: "primary-request" };
    changeWriter("enqueue", { ...primary, input: "Queued primary work" });
    const [record, claim] = await Promise.all([concurrent("acquire-record", helper), concurrent("claim", primary)]);
    expect([record, claim].filter((result) => result.code === 0)).toHaveLength(1);
    if (record.code === 0) {
      expect(readWriterSummary(value.worktree)?.running).toBe(false);
      expect(run("claim", primary).status).toBe(1);
      const { lease } = JSON.parse(record.output);
      expect(run("release-record", release(helper, lease)).status).toBe(0);
      expect(run("claim", primary).status).toBe(0);
    } else {
      expect(readWriterSummary(value.worktree)?.running).toBe(true);
      expect(run("acquire-record", helper).status).toBe(1);
      const { lease } = JSON.parse(claim.output).turn;
      expect(run("acquire-record", { ...helper, primaryOwner: { workerId: primary.workerId, lease } }).status).toBe(1);
      expect(run("finish", { ...primary, lease, status: "DONE", stoppedTurn: {
        runtime: "codex", workerId: primary.workerId, requestId: primary.requestId, lease, state: "completed" } }).status).toBe(0);
      expect(run("acquire-record", helper).status).toBe(0);
    }
  }, 10000);
  it("permits only the registered primary's exact active record continuation and bounded startup helpers", () => {
    const value = setup();
    const input = { worktree: value.worktree, workerId: "native-primary", requestId: "active-record" };
    changeWriter("enqueue", { ...input, input: "Primary owns the current request" });
    const claim = changeWriter("claim", input);
    const own = { ...grant(value), ...input, agentName: "vibe-change-worker", recordAction: "progress" };
    expect(run("acquire-record", own).status).toBe(1);
    expect(run("acquire-record", { ...own, primaryOwner: { workerId: input.workerId,
      lease: "11111111-1111-4111-8111-111111111111" } }).status).toBe(1);
    expect(run("acquire-record", { ...own, requestId: "unrelated-request", primaryOwner: {
      workerId: input.workerId, lease: claim.turn!.lease! } }).status).toBe(1);
    const exact = { ...own, primaryOwner: { workerId: input.workerId, lease: claim.turn!.lease! } };
    const acquired = run("acquire-record", exact);
    expect(acquired.status, acquired.stderr).toBe(0);
    expect(run("release-record", release(exact, JSON.parse(acquired.stdout).lease)).status).toBe(0);
    const startup = fixture(); fixtures.push(startup);
    rmSync(join(startup.metadata, "vibe-session.json"));
    const setupGrant = { ...grant(startup), agentName: "vibe-setup-worker", sessionless: { kind: "startup" } };
    expect(run("acquire-record", { ...setupGrant, agentName: "vibe-environment-worker" }).status).toBe(1);
    const setupLock = run("acquire-record", setupGrant);
    expect(setupLock.status, setupLock.stderr).toBe(0);
    expect(run("release-record", release(setupGrant, JSON.parse(setupLock.stdout).lease)).status).toBe(0);
    expect(existsSync(join(startup.metadata, "vibe-writer.json"))).toBe(false);
  }, 10000);
});
