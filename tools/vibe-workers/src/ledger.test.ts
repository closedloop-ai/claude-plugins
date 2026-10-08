import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesSchema } from "./contracts.js";
import { readDefinition } from "./definition.js";
import { acquireRecordTurn, attachClaudeProcess, changeWriter, readWriterSummary, registerWriter } from "./ledger.js";
import { bundleDirectory, fixture, graph, recordWrite, writeAgent } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });
function setup() { const value = fixture(); fixtures.push(value); return value; }
function registered() {
  const value = setup();
  const registration = { worktree: value.worktree, runtime: "codex", workerId: "native-worker-23",
    agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph };
  registerWriter(registration);
  return { ...value, registration, workerId: registration.workerId };
}
function nativeFinish(input: { worktree: string; workerId: string; requestId: string; lease: string; status: string }) {
  return changeWriter("finish", { ...input, stoppedTurn: { runtime: "codex", workerId: input.workerId,
    requestId: input.requestId, lease: input.lease, state: "completed" } });
}

describe("persistent writer ledger", () => {
  it("registers one native writer with canonical binding and no copied resources", () => {
    const value = registered();
    expect(registerWriter(value.registration).workerId).toBe(value.workerId);
    expect(() => registerWriter({ ...value.registration, workerId: "another-worker" })).toThrow(/identity/);
    writeAgent(value.agentRoot, "vibe-change-worker", "Read, Write, Edit");
    expect(() => registerWriter(value.registration)).toThrow(/binding/);
    expect(statSync(join(value.metadata, "vibe-writer.json")).mode & 0o777).toBe(0o600);
  });
  it("accepts canonical existing session records without a redundant worktree field", () => {
    const value = setup();
    writeFileSync(join(value.metadata, "vibe-session.json"), JSON.stringify({ branch: "vibe/test" }));
    const registered = registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "native-existing-record",
      agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
    expect(registered.worktree).toBe(value.worktree);
    expect(registered.branch).toBe("vibe/test");
    expect(readWriterSummary(value.worktree)?.workerId).toBe(registered.workerId);
  });
  it("serializes original requests and retains them through review, person and commit continuations", () => {
    const value = registered();
    const input = { worktree: value.worktree, workerId: value.workerId };
    changeWriter("enqueue", { ...input, requestId: "first", input: "First private request" });
    changeWriter("enqueue", { ...input, requestId: "second", input: "Second private request" });
    const first = changeWriter("claim", { ...input, requestId: "first" });
    expect(() => changeWriter("claim", { ...input, requestId: "first", continuation: "race" })).toThrow(/running/);
    expect(() => changeWriter("finish", { ...input, requestId: "first", lease: "11111111-1111-4111-8111-111111111111", status: "DONE" })).toThrow(/ownership/);
    for (const status of ["PLAN", "NEEDS_REVIEW", "NEEDS_PERSON", "NEEDS_COMMIT"] as const) {
      const state = readWriterSummary(value.worktree);
      const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
      nativeFinish({ ...input, requestId: "first", lease: ledger.active.lease, status });
      expect(readWriterSummary(value.worktree)?.activeRequestId).toBe("first");
      expect(() => changeWriter("claim", { ...input, requestId: "second" })).toThrow(/Continue/);
      const resumed = changeWriter("claim", { ...input, requestId: "first", continuation: `Continue ${status}` });
      expect(resumed.turn?.input).toBe("First private request");
      expect(state?.workerId).toBe(value.workerId);
    }
    const latest = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    nativeFinish({ ...input, requestId: "first", lease: latest.active.lease, status: "DONE" });
    const next = changeWriter("claim", { ...input, requestId: "second" });
    expect(next.turn?.input).toBe("Second private request");
    expect(next.workerId).toBe(first.workerId);
  });
  it("bounds the queue, validates identity and branch, and never exposes inputs in summary", () => {
    const value = registered();
    const input = { worktree: value.worktree, workerId: value.workerId };
    for (let index = 0; index < 32; index++) changeWriter("enqueue", { ...input, requestId: `r${index}`, input: "PRIVATE_REQUEST_TEXT" });
    expect(() => changeWriter("enqueue", { ...input, requestId: "overflow", input: "PRIVATE_REQUEST_TEXT" })).toThrow(/full/);
    expect(() => changeWriter("claim", { ...input, requestId: "r0", workerId: "wrong" })).toThrow(/registered/);
    expect(JSON.stringify(readWriterSummary(value.worktree))).not.toContain("PRIVATE_REQUEST_TEXT");
    writeFileSync(join(value.metadata, "vibe-session.json"), JSON.stringify({ worktree: value.worktree, branch: "vibe/different" }));
    expect(() => readWriterSummary(value.worktree)).toThrow(/branch/);
  });
  it("executes the production writer-state CLI and exports its summary API without private inputs", () => {
    const value = setup();
    const entry = join(value.base, "writer-state-link.mjs");
    symlinkSync(join(bundleDirectory, "writer-state.mjs"), entry);
    const cli = (action: string, input: unknown) => JSON.parse(execFileSync(process.execPath,
      [entry, action], { input: JSON.stringify(input), encoding: "utf8" }));
    const registration = cli("register", { worktree: value.worktree, runtime: "codex", workerId: "native-actual-cli",
      agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
    const input = { worktree: value.worktree, workerId: registration.workerId, requestId: "cli-request" };
    cli("enqueue", { ...input, input: "SECRET_REQUEST" });
    const claimed = cli("claim", input);
    expect(JSON.stringify(claimed)).not.toContain("SECRET_REQUEST");
    expect(claimed.turn.lease).toBeTruthy();
    expect(cli("take-input", { ...input, lease: claimed.turn.lease }).originalInput).toBe("SECRET_REQUEST");
    cli("finish", { ...input, lease: claimed.turn.lease, status: "PLAN", stoppedTurn: {
      runtime: "codex", workerId: input.workerId, requestId: input.requestId, lease: claimed.turn.lease, state: "completed",
    } });
    expect(cli("status", { worktree: value.worktree }).activeRequestId).toBe("cli-request");
  });
  it("admits only one simultaneous production CLI claim for the same writer", async () => {
    const value = registered();
    const input = { worktree: value.worktree, workerId: value.workerId, requestId: "race" };
    changeWriter("enqueue", { ...input, input: "A bounded queued request" });
    const claim = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "claim"], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(JSON.stringify(input));
    });
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code !== 0)).toHaveLength(1);
    expect(readWriterSummary(value.worktree)?.running).toBe(true);
    expect(JSON.parse(results.find((result) => result.code === 0)!.output).turn.lease).toBeTruthy();
  });
  it("never mistakes the short-lived native CLI PID for a stopped worker turn", () => {
    const value = registered();
    const input = { worktree: value.worktree, workerId: value.workerId, requestId: "native-live" };
    changeWriter("enqueue", { ...input, input: "A native request" });
    const claimed = changeWriter("claim", input);
    expect(() => changeWriter("finish", { ...input, lease: claimed.turn?.lease, status: "DONE" })).toThrow(/completion evidence/);
    expect(() => changeWriter("finish", { ...input, lease: claimed.turn?.lease, status: "DONE", stoppedTurn: {
      runtime: "codex", workerId: "other-worker", requestId: input.requestId, lease: claimed.turn?.lease, state: "completed",
    } })).toThrow(/completion evidence/);
    expect(readWriterSummary(value.worktree)?.running).toBe(true);
  });
  it("excludes helper record turns and writer claims in both acquisition orders but admits its own record continuation", () => {
    const value = registered();
    const input = { worktree: value.worktree, workerId: value.workerId, requestId: "record-race" };
    changeWriter("enqueue", { ...input, input: "A queued request" });
    acquireRecordTurn(value.worktree);
    expect(() => changeWriter("claim", input)).toThrow(/record turn/);
    expect(readWriterSummary(value.worktree)?.queuedRequestIds).toEqual([input.requestId]);
    const lock = join(value.metadata, "vibe-record-turn.lock");
    rmSync(lock, { recursive: true });
    const claim = changeWriter("claim", input);
    expect(() => acquireRecordTurn(value.worktree)).toThrow(/running turn/);
    expect(existsSync(lock)).toBe(false);
    expect(() => acquireRecordTurn(value.worktree, { workerId: "wrong-writer", lease: claim.turn!.lease! })).toThrow(/running turn/);
    expect(acquireRecordTurn(value.worktree, { workerId: value.workerId, lease: claim.turn!.lease! })).toBe(lock);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    nativeFinish({ ...input, lease: claim.turn!.lease!, status: "DONE" });
    expect(() => acquireRecordTurn(value.worktree, { workerId: value.workerId, lease: claim.turn!.lease! })).toThrow(/current source lease/);
    expect(existsSync(lock)).toBe(false);
  });
  it("retains an unsafe Claude lease until its exact owned group is proven stopped", async () => {
    const value = setup();
    const registered = registerWriter({ worktree: value.worktree, runtime: "claude",
      agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
    const input = { worktree: value.worktree, workerId: registered.workerId, requestId: "owned-group" };
    changeWriter("enqueue", { ...input, input: "An owned runtime request" });
    const claimed = changeWriter("claim", input);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
    try {
      attachClaudeProcess(value.worktree, registered.workerId, claimed.turn!.lease!, child.pid!);
      expect(() => changeWriter("finish", { ...input, lease: claimed.turn?.lease, status: "FAILED" })).toThrow(/still running/);
      expect(readWriterSummary(value.worktree)?.processGroupId).toBe(child.pid);
      expect(readWriterSummary(value.worktree)?.running).toBe(true);
    } finally { process.kill(-child.pid!, "SIGTERM"); await closed; }
    changeWriter("finish", { ...input, lease: claimed.turn?.lease, status: "FAILED" });
    expect(readWriterSummary(value.worktree)?.running).toBe(false);
    expect(readWriterSummary(value.worktree)?.workerId).toBe(registered.workerId);
  });
});

describe("canonical capability boundaries", () => {
  it("retains body/model/skills and exact dynamic names while refusing arbitrary capabilities", () => {
    const value = setup();
    const result = readDefinition(value.agentRoot, "vibe-change-worker", graph);
    expect(result.metadata.model).toBe("sonnet");
    expect(result.skills).toEqual(["closedloop-core:plan-structure"]);
    expect(result.prompt).toContain("Canonical fixture prompt");
    expect(result.binding.capabilities).toEqual(graph);
    expect(capabilitiesSchema.safeParse([{ ...graph[0], access: "write" }]).success).toBe(false);
    expect(capabilitiesSchema.safeParse([{ ...recordWrite, operation: "delete_document" }]).success).toBe(false);
    expect(capabilitiesSchema.safeParse([{ ...graph[0], name: "mcp__*__sync_status" }]).success).toBe(false);
    expect(capabilitiesSchema.safeParse([graph[0], graph[0]]).success).toBe(false);
  });
});
