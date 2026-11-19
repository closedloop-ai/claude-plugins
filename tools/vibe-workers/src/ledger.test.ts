import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesSchema } from "./contracts.js";
import { readDefinition } from "./definition.js";
import { acquireRecordTurn, attachClaudeProcess, changeWriter, dropPendingWriter, readWriterSummary, registerWriter } from "./ledger.js";
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
  it("AC-020 queue refusals name the next claim and a parent can drop only its evidenced pending input", () => {
    const value = registered();
    const owner = { worktree: value.worktree, workerId: value.workerId };
    const file = join(value.metadata, "vibe-writer.json");
    const cli = (action: string, requestId: string, extra = {}) => spawnSync(process.execPath,
      [join(bundleDirectory, "writer-state.mjs"), action], { input: JSON.stringify({ ...owner, requestId, ...extra }), encoding: "utf8", timeout: 8000 });
    changeWriter("enqueue", { ...owner, requestId: "oldest", input: "PRIVATE_OLD" });
    changeWriter("enqueue", { ...owner, requestId: "next", input: "PRIVATE_NEXT" });
    const prior = readFileSync(file, "utf8");
    for (const [action, code, extra] of [
      ["claim", "REQUEST_ORDER_INVALID", {}], ["start", "REQUEST_ID_EXISTS", { input: "A duplicate request" }],
    ] as const) {
      const attempted = cli(action, "next", extra);
      expect(attempted.status).toBe(1);
      const refusal = JSON.parse(attempted.stdout);
      expect(refusal.code).toBe(code);
      expect(refusal.summary).toMatch(/oldest pending requestId "oldest".*without input or continuation/);
      expect(attempted.stdout).not.toContain("PRIVATE_");
      expect(readFileSync(file, "utf8")).toBe(prior);
    }
    const inputSha256 = createHash("sha256").update("PRIVATE_OLD").digest("hex");
    const evidence = { source: "Parent triage record R-7", reason: "The operator superseded this request", inputSha256 };
    expect(cli("drop-pending", "oldest").status).toBe(1);
    const mismatch = cli("drop-pending", "oldest", { evidence: { ...evidence, inputSha256: "0".repeat(64) } });
    expect(JSON.parse(mismatch.stdout).code).toBe("PENDING_INPUT_MISMATCH");
    expect(readFileSync(file, "utf8")).toBe(prior);
    const dropped = cli("drop-pending", "oldest", { evidence });
    expect(dropped.status, dropped.stderr).toBe(0);
    expect(dropped.stdout).not.toContain("PRIVATE_");
    expect(JSON.parse(dropped.stdout).queuedRequestIds).toEqual(["next"]);
    expect(JSON.parse(readFileSync(file, "utf8")).dropped[0]).toMatchObject({ id: "oldest", ...evidence });
    expect(JSON.parse(cli("start", "oldest", { input: "Trying to reuse dropped ID" }).stdout).code).toBe("REQUEST_ID_EXISTS");
    const active = changeWriter("claim", { ...owner, requestId: "next" });
    expect(active.turn?.input).toBe("PRIVATE_NEXT");
    expect(JSON.parse(cli("drop-pending", "next", { evidence }).stdout).code).toBe("REQUEST_NOT_PENDING");
  });
  it("item 30(c): a request queued behind an open one is reported, relaunches with its input, and can be dropped", () => {
    const refused = (action: "start" | "claim", input: Record<string, unknown>) => {
      try { changeWriter(action, input); } catch (error) { return error as { code: string; summary: string }; }
      throw new Error(`${action} was not refused`);
    };
    for (const status of ["BLOCKED", "NEEDS_PERSON"]) {
      const value = registered();
      const owner = { worktree: value.worktree, workerId: value.workerId };
      const lease = changeWriter("start", { ...owner, requestId: "open", input: "OPEN" }).turn!.lease!;
      nativeFinish({ ...owner, requestId: "open", lease, status });
      const queued = changeWriter("enqueue", { ...owner, requestId: "later", input: "PRIVATE_LATER" });
      expect(queued.queuedBehind).toMatchObject({ requestId: "open", status });
      expect(queued.queuedBehind?.next).toMatch(/requestId "later" stays queued.*drop-pending/);
      expect(JSON.stringify(queued)).not.toContain("PRIVATE_");
      for (const [action, extra] of [["start", { input: "PRIVATE_LATER" }], ["claim", {}]] as const) {
        const refusal = refused(action, { ...owner, requestId: "later", ...extra });
        expect(refusal.code, `${status} ${action}`).toBe("ACTIVE_REQUEST_PENDING");
        expect(refusal.summary).toMatch(/Continue active requestId "open".*requestId "later" stays queued/);
        expect(refusal.summary).not.toContain("was not queued");
      }
      const dropped = dropPendingWriter({ ...owner, requestId: "later", evidence: { source: "Parent record", reason: "Superseded",
        inputSha256: createHash("sha256").update("PRIVATE_LATER").digest("hex") } });
      expect(dropped.queuedRequestIds).toEqual([]);
      expect(dropped.status).toBe(status);
    }
    const idle = registered();
    const idleOwner = { worktree: idle.worktree, workerId: idle.workerId };
    changeWriter("enqueue", { ...idleOwner, requestId: "queued", input: "QUEUED INPUT" });
    expect(refused("start", { ...idleOwner, requestId: "queued", input: "Other input" }).code).toBe("REQUEST_ID_EXISTS");
    const relaunched = changeWriter("start", { ...idleOwner, requestId: "queued", input: "QUEUED INPUT" });
    expect(relaunched.turn).toMatchObject({ id: "queued", input: "QUEUED INPUT" });
    expect(relaunched.queuedRequestIds).toEqual([]);
    const failed = registered();
    const failedOwner = { worktree: failed.worktree, workerId: failed.workerId };
    const failedLease = changeWriter("start", { ...failedOwner, requestId: "broken", input: "BROKEN" }).turn!.lease!;
    nativeFinish({ ...failedOwner, requestId: "broken", lease: failedLease, status: "FAILED" });
    expect(changeWriter("enqueue", { ...failedOwner, requestId: "next", input: "NEXT" }).queuedBehind).toBeUndefined();
    const running = registered();
    const runningOwner = { worktree: running.worktree, workerId: running.workerId };
    changeWriter("start", { ...runningOwner, requestId: "running", input: "RUNNING" });
    expect(changeWriter("enqueue", { ...runningOwner, requestId: "after", input: "AFTER" }).queuedBehind,
      "a running turn is not a request to continue").toBeUndefined();
    expect(changeWriter("start", { ...failedOwner, requestId: "next", input: "NEXT" }).turn?.id).toBe("next");
  });
  it("reopens the request that just returned DONE for its follow-up step instead of refusing it (ISS-13321)", () => {
    const value = registered();
    const owner = { worktree: value.worktree, workerId: value.workerId };
    changeWriter("enqueue", { ...owner, requestId: "inputs", input: "Run main-sync-inputs" });
    const first = changeWriter("claim", { ...owner, requestId: "inputs" }).turn!;
    nativeFinish({ ...owner, requestId: "inputs", lease: first.lease!, status: "DONE" });
    const next = changeWriter("claim", { ...owner, requestId: "inputs", continuation: "Run main-sync-validate" }).turn!;
    expect(next.id).toBe("inputs");
    expect(next.continuation).toBe("Run main-sync-validate");
    nativeFinish({ ...owner, requestId: "inputs", lease: next.lease!, status: "DONE" });
    changeWriter("enqueue", { ...owner, requestId: "later", input: "Another request" });
    const later = changeWriter("claim", { ...owner, requestId: "later" }).turn!;
    nativeFinish({ ...owner, requestId: "later", lease: later.lease!, status: "DONE" });
    expect(() => changeWriter("claim", { ...owner, requestId: "inputs", continuation: "Too late" })).toThrow(/oldest pending/);
  });
  it("registers one native writer with canonical binding and no copied resources", () => {
    const value = registered();
    expect(registerWriter(value.registration).workerId).toBe(value.workerId);
    expect(() => registerWriter({ ...value.registration, workerId: "another-worker" })).toThrow(/identity/);
    writeAgent(value.agentRoot, "vibe-change-worker", "Read, Write, Edit");
    expect(() => registerWriter(value.registration)).toThrow(/binding/);
    expect(statSync(join(value.metadata, "vibe-writer.json")).mode & 0o777).toBe(0o600);
  });
  // Codex spawn_agent returns only an agent path such as /root/setup, which the identifier schema once refused,
  // so a session abandoned its native writer (2026-10-26).
  it("registers a Codex writer by the agent path spawn_agent returns, and finishes its turn under it", () => {
    const value = setup();
    const workerId = "/root/vibe_writer";
    const registration = { worktree: value.worktree, runtime: "codex", workerId, agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: graph };
    expect(registerWriter(registration).workerId).toBe(workerId);
    const input = { worktree: value.worktree, workerId };
    changeWriter("enqueue", { ...input, requestId: "first", input: "First private request" });
    changeWriter("claim", { ...input, requestId: "first" });
    const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    nativeFinish({ ...input, requestId: "first", lease: ledger.active.lease, status: "DONE" });
    expect(readWriterSummary(value.worktree)?.workerId).toBe(workerId);
    for (const bad of ["/root/../setup", "/root//setup", "root/setup", "/root/setup/", "/"]) {
      expect(() => registerWriter({ ...registration, worktree: setup().worktree, workerId: bad }), bad).toThrow();
    }
    expect(() => registerWriter({ ...registration, worktree: setup().worktree, runtime: "claude", workerId }))
      .toThrow(/agent path/);
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
    } finally { const group = child.pid ?? 0; if (group > 1) process.kill(-group, "SIGTERM"); await closed; }
    changeWriter("finish", { ...input, lease: claimed.turn?.lease, status: "FAILED" });
    expect(readWriterSummary(value.worktree)?.running).toBe(false);
    expect(readWriterSummary(value.worktree)?.workerId).toBe(registered.workerId);
  });
});

describe("closed writer turns never wedge the queue (ISS-13043, ISS-13051)", () => {
  function claudeWriter() {
    const value = setup();
    const writer = registerWriter({ worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: graph });
    const start = (requestId: string) => {
      changeWriter("enqueue", { worktree: value.worktree, workerId: writer.workerId, requestId, input: `${requestId} input` });
      return changeWriter("claim", { worktree: value.worktree, workerId: writer.workerId, requestId });
    };
    return { value, writer, start };
  }
  it("a new request supersedes a FAILED turn, while any other open status still needs its continuation", () => {
    const { value, writer, start } = claudeWriter();
    const first = start("first");
    changeWriter("finish", { worktree: value.worktree, workerId: writer.workerId, requestId: "first", lease: first.turn?.lease, status: "FAILED" });
    expect(start("second").turn?.id).toBe("second");
    changeWriter("finish", { worktree: value.worktree, workerId: writer.workerId, requestId: "second",
      lease: readLedgerActiveLease(value.metadata), status: "NEEDS_PERSON" });
    expect(() => start("third")).toThrow(/requestId "second".*"continuation"/);
  });
  it("a turn whose launcher process is gone is closed by the next claim", async () => {
    const { value, start } = claudeWriter();
    start("orphaned");
    const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => gone.once("close", () => resolve()));
    const file = join(value.metadata, "vibe-writer.json");
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    ledger.active.ownerPid = gone.pid;
    writeFileSync(file, JSON.stringify(ledger));
    expect(start("after-stop").turn?.id).toBe("after-stop");
    expect(readWriterSummary(value.worktree)?.running).toBe(true);
  });
});

function readLedgerActiveLease(metadata: string) {
  return JSON.parse(readFileSync(join(metadata, "vibe-writer.json"), "utf8")).active.lease as string;
}

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
