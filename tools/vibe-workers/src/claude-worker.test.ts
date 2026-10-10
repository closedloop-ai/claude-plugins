import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundDefinition } from "./claude-worker.js";
import { readDefinition } from "./definition.js";
import { changeWriter, readWriterSummary, registerWriter } from "./ledger.js";
import { bundleDirectory, fixture, graph, readProof, recordWrite, writeAgent } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup() { const value = fixture(); fixtures.push(value); return value; }
function run(value: ReturnType<typeof fixture>, input: Record<string, unknown>, entry = join(bundleDirectory, "claude-worker.mjs")) {
  return spawnSync(process.execPath, [entry], {
    input: JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: graph, mode: "request", requestId: "first", ...input }),
    encoding: "utf8", env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` }, timeout: 10000,
  });
}

describe("production Claude CLI adapter", () => {
  it("admits only canonical existing publisher tuples through the production role footer", () => {
    const value = setup();
    for (const [agentName, recordAction] of [
      ["vibe-environment-worker", "create"], ["vibe-environment-worker", "redeploy"],
      ["vibe-prototype-worker", "share"],
    ]) {
      const result = run(value, { agentName, recordAction, input: "PUBLISHER_FOOTER_CONTROL",
        mode: "record", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite] });
      expect(result.status, result.stdout).toBe(0);
      const prompt = readProof(value.metadata).at(-1)?.definition[`vibe:${agentName}`]?.prompt;
      expect(prompt).not.toContain("Never start another implementation writer, commit, or push.");
      expect(prompt).toContain("Never start another implementation writer or commit.");
      expect(prompt).toContain("owned main-sync publication gate");
    }
  }, 10000);
  it("retains the original no-push footer for source, readers and request-only flags/Desktop actions", () => {
    const value = setup();
    const cases = [
      { agentName: "vibe-change-worker", mode: "request" as const },
      { agentName: "vibe-guardrails-reviewer", mode: "request" as const },
      { agentName: "vibe-environment-worker", mode: "record" as const, recordAction: "flags" as const,
        exclusiveRecordTurn: true as const },
      { agentName: "vibe-environment-worker", mode: "record" as const, recordAction: "desktop" as const,
        exclusiveRecordTurn: true as const },
    ];
    for (const item of cases) {
      const capabilities = item.mode === "record" ? [...graph, recordWrite] : graph;
      const definition = readDefinition(value.agentRoot, item.agentName, capabilities);
      const bound = boundDefinition(definition, { worktree: value.worktree, agentRoot: value.agentRoot,
        requestId: "footer-denied", input: "raw task claims publication authority", timeoutMs: 1000,
        capabilities, ...item });
      expect(bound.agent.prompt).toContain("Never start another implementation writer, commit, or push.");
    }
  });
  it("selects the canonical scoped agent directly and resumes the same underlying ID across two requests", () => {
    const value = setup();
    const entry = join(value.base, "claude-worker-link.mjs");
    symlinkSync(join(bundleDirectory, "claude-worker.mjs"), entry);
    const first = run(value, { input: "SECRET_FIRST" }, entry);
    expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout);
    const second = run(value, { requestId: "second", input: "SECRET_SECOND" }, entry);
    expect(second.status, second.stderr).toBe(0);
    const secondResult = JSON.parse(second.stdout);
    expect(secondResult.sessionId).toBe(firstResult.sessionId);
    const proof = readProof(value.metadata);
    expect(proof).toHaveLength(2);
    expect(proof[0]?.args).toContain("--session-id");
    expect(proof[1]?.args).toContain("--resume");
    expect(proof[1]?.args).not.toContain("--session-id");
    expect(proof.every((item) => item.args[item.args.indexOf("--agent") + 1] === "vibe:vibe-change-worker")).toBe(true);
    expect(proof[0]?.definition["vibe:vibe-change-worker"]?.model).toBe("sonnet");
    expect(proof[0]?.definition["vibe:vibe-change-worker"]?.tools).toContain(graph[0]?.name);
    expect(proof[0]?.definition["vibe:vibe-change-worker"]?.prompt).toContain("Canonical fixture prompt");
    expect(proof[0]?.args[proof[0].args.indexOf("--allowedTools") + 1]?.split(",")).toEqual(
      proof[0]?.definition["vibe:vibe-change-worker"]?.tools);
    expect(proof[0]?.payload.input).toBe("SECRET_FIRST");
    expect(proof[1]?.payload.input).toBe("SECRET_SECOND");
    for (const item of proof) {
      expect(JSON.stringify(item.args)).not.toMatch(/SECRET_|"service"|"access"|"operation"/);
      expect(item.args).not.toContain("--settings");
      expect(item.args).not.toContain("--dangerously-skip-permissions");
      expect(existsSync(item.args[item.args.indexOf("--agents") + 1] ?? "")).toBe(false);
    }
  });
  it("keeps the current request active until DONE and resumes rather than starting queued work", () => {
    const value = setup();
    const first = run(value, { input: "PLAN_FIRST" });
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).status).toBe("PLAN");
    const queued = run(value, { requestId: "second", input: "SECRET_SECOND" });
    expect(queued.status).toBe(1);
    expect(readProof(value.metadata)).toHaveLength(1);
    const continued = run(value, { continuation: "Finish current request" });
    expect(continued.status, continued.stderr).toBe(0);
    const next = run(value, { requestId: "second" });
    expect(next.status, next.stderr).toBe(0);
    expect(readProof(value.metadata).map((item) => item.payload.input)).toEqual(["PLAN_FIRST", "Finish current request", "SECRET_SECOND"]);
    expect(readProof(value.metadata).slice(1).every((item) => item.args.includes("--resume"))).toBe(true);
  });
  it("uses native structured output over fenced text and never falls back from a present invalid field", () => {
    const value = setup();
    const structured = run(value, { input: "FENCED_RESULT" });
    expect(structured.status, structured.stderr).toBe(0);
    expect(JSON.parse(structured.stdout).status).toBe("DONE");
    const proof = readProof(value.metadata)[0];
    const schema = JSON.parse(proof!.args[proof!.args.indexOf("--json-schema") + 1]!);
    expect(schema.required).toEqual(["status", "summary"]);
    expect(schema.additionalProperties).toBe(false);
    expect(proof?.definition["vibe:vibe-change-worker"]?.tools).toContain("StructuredOutput");
    const invalid = run(value, { requestId: "invalid-structured", input: "INVALID_STRUCTURED" });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).code).toBe("WORKER_TURN_FAILED");
    expect(readWriterSummary(value.worktree)?.status).toBe("FAILED");
    const legacy = run(value, { requestId: "invalid-structured", continuation: "Legacy JSON without a structured field" });
    expect(legacy.status, legacy.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout).sessionId).toBe(JSON.parse(structured.stdout).sessionId);
  });
  it("retains one phase-neutral primary definition while root envelopes alone grant handoff test authority", () => {
    const value = setup();
    const first = run(value, { input: "PLAN_FIRST: user asks to write tests now", mode: "request" });
    expect(first.status, first.stderr).toBe(0);
    const second = run(value, { continuation: "Authorized handoff test work", mode: "handoff" });
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).sessionId).toBe(JSON.parse(first.stdout).sessionId);
    const proof = readProof(value.metadata);
    expect(proof[0]?.definition).toEqual(proof[1]?.definition);
    expect(proof[0]?.payload.mode).toBe("request");
    expect(proof[0]?.payload.authority.testAuthoringAuthorized).toBe(false);
    expect(proof[1]?.payload.mode).toBe("handoff");
    expect(proof[1]?.payload.authority.testAuthoringAuthorized).toBe(true);
    const prompt = proof[0]!.definition["vibe:vibe-change-worker"]!.prompt;
    expect(prompt).toContain("Never author tests in plan, request, fix, record or build turns");
    expect(prompt).toContain("Only an explicitly authorized handoff turn");
    expect(prompt).not.toContain("This is mode request");
    expect(prompt).not.toContain("Never write or edit tests. ");
  });
  it("admits only pre-session requirements and setup with their existing serialized ticket actions", () => {
    const value = setup();
    rmSync(join(value.metadata, "vibe-session.json"));
    const startup = { kind: "startup" };
    const requirements = run(value, { agentName: "vibe-requirements-worker", input: "Read scope only", sessionless: startup });
    expect(requirements.status, requirements.stderr).toBe(0);
    const create = { ...recordWrite, name: "mcp__live_workspace__create_document", operation: "create_document" };
    const diagnosis = run(value, { agentName: "vibe-setup-worker", input: "File diagnosed bug without source changes",
      sessionless: startup, mode: "record", recordAction: "create", exclusiveRecordTurn: true, capabilities: [...graph, create] });
    expect(diagnosis.status, diagnosis.stderr).toBe(0);
    const progress = run(value, { agentName: "vibe-setup-worker", input: "Record verified sole-writer fix evidence",
      sessionless: startup, mode: "record", recordAction: "progress", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite] });
    expect(progress.status, progress.stderr).toBe(0);
    const proof = readProof(value.metadata);
    expect(proof[0]?.definition["vibe:vibe-requirements-worker"]?.tools).not.toContain("Write");
    expect(proof[1]?.definition["vibe:vibe-setup-worker"]?.tools).toContain(create.name);
    expect(proof[2]?.definition["vibe:vibe-setup-worker"]?.tools).toContain(recordWrite.name);
    expect(existsSync(join(value.metadata, "vibe-session.json"))).toBe(false);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
    mkdirSync(join(value.metadata, "vibe-record-turn.lock"));
    const busy = run(value, { agentName: "vibe-setup-worker", input: "File diagnosis", sessionless: startup,
      mode: "record", recordAction: "create", exclusiveRecordTurn: true, capabilities: [...graph, create] });
    expect(busy.status).toBe(1);
    expect(readProof(value.metadata)).toHaveLength(3);
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(true);
  }, 10000);
  it("requires parent-held discard evidence and a stable existing checkout for post-discard cancellation", () => {
    const value = setup();
    rmSync(join(value.metadata, "vibe-session.json"));
    const deleted = join(value.base, "discarded-worktree");
    execFileSync("git", ["worktree", "add", "-b", "vibe/discarded-test", deleted], { cwd: value.worktree, stdio: "ignore" });
    execFileSync("git", ["worktree", "remove", deleted], { cwd: value.worktree, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", "vibe/discarded-test"], { cwd: value.worktree, stdio: "ignore" });
    const update = { ...recordWrite, name: "mcp__live_workspace__update_document", operation: "update_document" };
    const input = { agentName: "vibe-ticket-worker", input: "Cancel the operator's discarded ticket after live ownership verification",
      mode: "record", recordAction: "cancel", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite, update] };
    expect(run(value, { ...input, sessionless: { kind: "discarded" } }).status).toBe(1);
    const evidence = { discarded: true, branch: "vibe/discarded-test", liveTicket: "ISS-1",
      operatorId: "fixture-owner", operatorEmail: "owner@example.invalid" };
    expect(run(value, { ...input, worktree: deleted, sessionless: { kind: "discarded", evidence } }).status).toBe(1);
    const result = run(value, { ...input, sessionless: { kind: "discarded", evidence } });
    expect(result.status, result.stderr).toBe(0);
    const proof = readProof(value.metadata)[0];
    expect(proof?.definition["vibe:vibe-ticket-worker"]?.tools).toContain(recordWrite.name);
    expect(proof?.definition["vibe:vibe-ticket-worker"]?.tools).toContain(update.name);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
  });
  it("keeps setup discard state in the retained checkout and verifies target ownership before deletion", () => {
    const value = setup();
    rmSync(join(value.metadata, "vibe-session.json"));
    const target = join(value.base, "owned-discard-target");
    const origin = join(value.base, "owned-empty-origin.git");
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: value.worktree });
    const branch = "vibe/discard-target";
    execFileSync("git", ["worktree", "add", "-b", branch, target], { cwd: value.worktree, stdio: "ignore" });
    const metadata = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: target, encoding: "utf8" }).trim();
    writeFileSync(join(metadata, "vibe-session.json"), JSON.stringify({ worktree: target, branch, status: "active",
      liveTicket: "ISS-2", operator: { id: "fixture-owner", email: "owner@example.invalid" } }));
    const discardTarget = { worktree: target, confirmed: true, branch, liveTicket: "ISS-2",
      operatorId: "fixture-owner", operatorEmail: "owner@example.invalid" };
    const input = { agentName: "vibe-setup-worker", input: "DISCARD_OWNED_FIXTURE", sessionless: { kind: "startup" },
      mode: "record", recordAction: "discard", exclusiveRecordTurn: true, discardTarget };
    expect(run(value, { ...input, discardTarget: { ...discardTarget, operatorId: "different-owner" } }).status).toBe(1);
    expect(run(value, { ...input, discardTarget: { ...discardTarget, liveTicket: "ISS-3" } }).status).toBe(1);
    mkdirSync(join(metadata, "vibe-record-turn.lock"));
    expect(run(value, input).status).toBe(1);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(value.metadata, "fake-proof.jsonl"))).toBe(false);
    rmSync(join(metadata, "vibe-record-turn.lock"), { recursive: true });
    const result = run(value, input);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(value.worktree)).toBe(true);
    expect(existsSync(JSON.parse(result.stdout).tracePath)).toBe(true);
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
    expect(readProof(value.metadata)[0]?.payload.input).toBe("DISCARD_OWNED_FIXTURE");
    expect(JSON.parse(result.stdout).data.discardReceipt.cancelEvidence).toEqual({ discarded: true, branch,
      liveTicket: "ISS-2", operatorId: "fixture-owner", operatorEmail: "owner@example.invalid" });
  }, 10000);
  it("uses the canonical historical ticket read from preview through confirmed discard and preserves ticket absence", () => {
    const value = setup();
    rmSync(join(value.metadata, "vibe-session.json"));
    const origin = join(value.base, "historical-empty-origin.git");
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: value.worktree });
    for (const legacyTicket of ["ISS-12", undefined]) {
      const target = join(value.base, legacyTicket ? "historical-ticket" : "historical-no-ticket");
      const branch = legacyTicket ? "vibe/historical-ticket" : "vibe/historical-no-ticket";
      execFileSync("git", ["worktree", "add", "-b", branch, target], { cwd: value.worktree, stdio: "ignore" });
      const metadata = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: target, encoding: "utf8" }).trim();
      writeFileSync(join(metadata, "vibe-session.json"), JSON.stringify({ branch, status: "active",
        ...(legacyTicket ? { handoffTicket: legacyTicket } : {}),
        operator: { id: "fixture-owner", email: "owner@example.invalid", name: null } }));
      const preview = JSON.parse(execFileSync(process.execPath, [join(bundleDirectory, "../vibe-sessions.mjs"),
        "discard", "--worktree", target], { cwd: value.worktree, encoding: "utf8" }));
      expect(preview.discarded).toBe(false);
      expect(preview.wouldLose.liveTicket).toBe(legacyTicket ?? null);
      const facts = preview.wouldLose;
      const result = run(value, { agentName: "vibe-setup-worker", input: "DISCARD_OWNED_FIXTURE",
        sessionless: { kind: "startup" }, mode: "record", recordAction: "discard", exclusiveRecordTurn: true,
        discardTarget: { worktree: facts.worktree, branch: facts.branch, confirmed: true,
          operatorId: facts.operator.id, operatorEmail: facts.operator.email,
          ...(facts.liveTicket ? { liveTicket: facts.liveTicket } : {}) } });
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout).data.discardReceipt;
      expect(receipt.discarded).toBe(true);
      expect(receipt.wouldLose.liveTicket).toBe(legacyTicket ?? null);
      expect(Boolean(receipt.cancelEvidence)).toBe(Boolean(legacyTicket));
      expect(existsSync(target)).toBe(false);
      expect(existsSync(value.worktree)).toBe(true);
    }
  }, 10000);
  it("never turns a sessionless exception into a writer or publication ownership fallback", () => {
    const value = setup();
    rmSync(join(value.metadata, "vibe-session.json"));
    for (const agentName of ["vibe-change-worker", "vibe-prototype-worker", "vibe-environment-worker", "vibe-ticket-worker"]) {
      expect(run(value, { agentName, input: "Inspect", sessionless: { kind: "startup" } }).status).toBe(1);
    }
    expect(run(value, { input: "No private writer session" }).status).toBe(1);
    expect(run(value, { agentName: "vibe-setup-worker", input: "Wrong startup action", sessionless: { kind: "startup" },
      mode: "record", recordAction: "cancel", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite] }).status).toBe(1);
    expect(existsSync(join(value.metadata, "fake-proof.jsonl"))).toBe(false);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
  });
  it("rejects separate seed-refresh source roles before launching a nonpersistent writer", () => {
    const value = setup();
    writeAgent(value.agentRoot, "vibe-seed-fix-worker", "Read, Write, Edit, Grep, Glob, Bash");
    const denied = run(value, { agentName: "vibe-seed-fix-worker", input: "Unrelated source work" });
    expect(denied.status).toBe(1);
    expect(existsSync(join(value.metadata, "fake-proof.jsonl"))).toBe(false);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
  });
  it("retains identity after startup failure and rejects changed definitions and unexpected session IDs", () => {
    const value = setup();
    expect(run(value, { input: "STARTUP_FAILURE" }).status).toBe(1);
    const failed = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    expect(failed.active.status).toBe("FAILED");
    expect(failed.active.lease).toBeUndefined();
    expect(run(value, { continuation: "Continue same context" }).status).toBe(0);
    expect(readProof(value.metadata)[1]?.args).toContain("--resume");
    const changed = run(value, { requestId: "third", input: "Anything", capabilities: [...graph, recordWrite] });
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout).code).toBe("WRITER_BINDING_CHANGED");
    expect(run(value, { requestId: "third", input: "WRONG_ID" }).status).toBe(1);
    expect(JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8")).active.status).toBe("FAILED");
  });
  it("retains reader built-ins but excludes writes, record mutators and nested writer tools", () => {
    const value = setup();
    const reader = run(value, { agentName: "vibe-guardrails-reviewer", input: "inspect" });
    expect(reader.status, reader.stderr).toBe(0);
    const proof = readProof(value.metadata)[0];
    expect(proof?.args[proof.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(proof?.args[proof.args.indexOf("--disallowedTools") + 1]).toMatch(/Write,Edit/);
    expect(proof?.definition["vibe:vibe-guardrails-reviewer"]?.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Skill", "ToolSearch", "StructuredOutput", graph[0]?.name]);
    expect(run(value, { agentName: "vibe-guardrails-reviewer", input: "inspect", capabilities: [...graph, recordWrite] }).status).toBe(1);
    expect(readProof(value.metadata)).toHaveLength(1);
  });
  it("permits only an exclusive declared record turn to activate record writes", () => {
    const value = setup();
    const definition = readDefinition(value.agentRoot, "vibe-change-worker", [...graph, recordWrite]);
    const base = { worktree: value.worktree, agentRoot: value.agentRoot, agentName: "vibe-change-worker",
      requestId: "one", capabilities: [...graph, recordWrite], input: "test", timeoutMs: 1000 };
    expect(boundDefinition(definition, { ...base, mode: "request" }).tools).not.toContain(recordWrite.name);
    expect(() => boundDefinition(definition, { ...base, mode: "record" })).toThrow(/exclusive record turn/);
    expect(boundDefinition(definition, { ...base, mode: "record", recordAction: "progress", exclusiveRecordTurn: true }).tools).toContain(recordWrite.name);
    expect(() => boundDefinition(definition, { ...base, mode: "record", recordAction: "assign", exclusiveRecordTurn: true })).toThrow(/canonical action/);
  });
  it("bounds prototype advice to a reader while retaining serialized operational share capabilities", () => {
    const value = setup();
    const advice = run(value, { agentName: "vibe-prototype-worker", input: "inspect" });
    expect(advice.status, advice.stderr).toBe(0);
    const proof = readProof(value.metadata)[0];
    expect(proof?.args[proof.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(proof?.definition["vibe:vibe-prototype-worker"]?.tools).not.toContain("Write");
    expect(proof?.definition["vibe:vibe-prototype-worker"]?.tools).toContain("Skill");
    expect(run(value, { agentName: "vibe-prototype-worker", input: "inspect", capabilities: [...graph, recordWrite] }).status).toBe(1);
    const publication = run(value, { agentName: "vibe-prototype-worker", input: "publish reviewed commit", mode: "record",
      recordAction: "share", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite] });
    expect(publication.status, publication.stderr).toBe(0);
    const shared = readProof(value.metadata)[1];
    expect(shared?.args[shared.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(shared?.definition["vibe:vibe-prototype-worker"]?.tools).toContain("Write");
    expect(shared?.definition["vibe:vibe-prototype-worker"]?.tools).toContain(recordWrite.name);
    expect(shared?.definition["vibe:vibe-prototype-worker"]?.prompt).toContain("canonical share mode");
  });
  it("kills its owned timed-out child and releases the turn without changing the persistent identity", () => {
    const value = setup();
    const result = run(value, { input: "WAIT_FOR_CANCEL", timeoutMs: 1000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("TURN_TIMEOUT");
    expect(JSON.parse(result.stdout).leaseRetained).toBe(false);
    const proof = readProof(value.metadata)[0];
    expect(proof?.pid).toBeTruthy();
    expect(() => process.kill(proof!.pid, 0)).toThrow();
    const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    expect(ledger.active.status).toBe("FAILED");
    expect(ledger.active.lease).toBeUndefined();
    expect(run(value, { continuation: "Continue after interruption" }).status).toBe(0);
    expect(readProof(value.metadata)[1]?.args).toContain("--resume");
  });
  it("serializes truly concurrent helper publication and native writer claims through the production CLIs", async () => {
    const value = setup();
    const registered = registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "native-record-race",
      agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
    const writerInput = { worktree: value.worktree, workerId: registered.workerId, requestId: "source-race" };
    changeWriter("enqueue", { ...writerInput, input: "Source request" });
    const invoke = (entry: string, args: string[], input: unknown) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(bundleDirectory, entry), ...args], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` },
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
      child.stdin.end(JSON.stringify(input));
    });
    const [helper, writer] = await Promise.all([
      invoke("claude-worker.mjs", [], { worktree: value.worktree, agentRoot: value.agentRoot,
        agentName: "vibe-prototype-worker", requestId: "share-race", input: "WAIT_FOR_CANCEL", mode: "record",
        recordAction: "share", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite], timeoutMs: 1000 }),
      invoke("writer-state.mjs", ["claim"], writerInput),
    ]);
    const helperResult = JSON.parse(helper.output);
    if (writer.code === 0) {
      expect(helperResult.code).toBe("WRITER_BUSY");
      expect(readWriterSummary(value.worktree)?.running).toBe(true);
    } else {
      expect(helperResult.code).toBe("TURN_TIMEOUT");
      expect(helperResult.recordLeaseRetained).toBe(false);
      expect(readWriterSummary(value.worktree)?.running).toBe(false);
      expect(readWriterSummary(value.worktree)?.queuedRequestIds).toEqual([writerInput.requestId]);
    }
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
    expect(readWriterSummary(value.worktree)?.workerId).toBe(registered.workerId);
  }, 10000);
});
