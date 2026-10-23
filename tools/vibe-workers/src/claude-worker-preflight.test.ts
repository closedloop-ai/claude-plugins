import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRoot } from "./plugin-root.js";
import { bundleDirectory, fixture, graph, liveReads, readProof } from "./test-fixtures.js";

const installedRoot = resolve(bundleDirectory, "../../../..");
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup() { const value = fixture(); fixtures.push(value); return value; }
function launch(value: ReturnType<typeof fixture>, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], {
    input: JSON.stringify({ worktree: value.worktree, agentName: "vibe-change-worker", capabilities: graph,
      mode: "request", requestId: "first", ...input }),
    encoding: "utf8", env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ...env }, timeout: 15000,
  });
  return { status: result.status, json: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
}
function writeState(value: ReturnType<typeof fixture>, action: string, input: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), action], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function proofCount(value: ReturnType<typeof fixture>) {
  return existsSync(join(value.metadata, "fake-proof.jsonl")) ? readProof(value.metadata).length : 0;
}
function staleCopy(value: ReturnType<typeof fixture>) {
  const stale = join(value.base, "vibe-old");
  cpSync(value.agentRoot, stale, { recursive: true });
  writeFileSync(join(stale, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "0.0.1" }));
  return stale;
}

describe("launcher agent root (operator ruling, 2026-10-15)", () => {
  it("binds the installed plugin's own definition when the caller omits agentRoot", () => {
    const value = setup();
    const result = launch(value, { agentName: "vibe-guardrails-reviewer", input: "inspect" });
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    const canonical = readFileSync(join(installedRoot, "agents", "vibe-guardrails-reviewer.md"), "utf8");
    const prompt = readProof(value.metadata)[0]?.definition["vibe:vibe-guardrails-reviewer"]?.prompt ?? "";
    expect(prompt.length).toBeGreaterThan(0);
    expect(canonical).toContain(prompt.split("\n\nRuntime binding:")[0]?.trim().slice(0, 200));
  }, 20000);
  it("reads a supplied <root>/agents as the plugin root instead of failing every launch", () => {
    const value = setup();
    const result = launch(value, { agentRoot: join(value.agentRoot, "agents"), agentName: "vibe-guardrails-reviewer",
      input: "inspect" });
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    expect(readProof(value.metadata)[0]?.definition["vibe:vibe-guardrails-reviewer"]?.prompt)
      .toContain("Canonical fixture prompt for vibe-guardrails-reviewer");
  }, 20000);
  it("refuses another release's plugin root before starting anything", () => {
    const value = setup();
    const result = launch(value, { agentRoot: staleCopy(value), agentName: "vibe-guardrails-reviewer", input: "inspect" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("STALE_PLUGIN_ROOT");
    expect(proofCount(value)).toBe(0);
  }, 20000);
  it("keeps a resumed writer on its recorded root when agentRoot is omitted", () => {
    const value = setup();
    expect(launch(value, { agentRoot: value.agentRoot, input: "PLAN_FIRST" }).status).toBe(0);
    const resumed = launch(value, { continuation: "Continue the same request" });
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(0);
    const proof = readProof(value.metadata);
    expect(proof[1]?.args).toContain("--resume");
    expect(proof[1]?.definition["vibe:vibe-change-worker"]?.prompt).toContain("Canonical fixture prompt for vibe-change-worker");
  }, 20000);
  it("resolves the same way for the Codex writer registration (writer-state)", () => {
    const value = setup();
    const registration = { worktree: value.worktree, runtime: "codex", workerId: "native-installed-root",
      agentName: "vibe-change-worker", capabilities: graph };
    const registered = writeState(value, "register", registration);
    expect(registered.status, registered.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    expect(ledger.binding.agentRoot).toBe(installedRoot);
    const other = setup();
    const stale = writeState(other, "register", { ...registration, worktree: other.worktree, agentRoot: staleCopy(other) });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/omit agentRoot/);
    expect(existsSync(join(other.metadata, "vibe-writer.json"))).toBe(false);
  }, 20000);
  it("never resolves to a root that is not a vibe plugin", () => {
    const value = setup();
    expect(() => resolveAgentRoot(value.worktree, installedRoot)).toThrow(/not a vibe plugin root/);
    expect(() => resolveAgentRoot(join(value.base, "missing"), installedRoot)).toThrow(/does not exist/);
  });
});

describe("launcher sign-in and connection prechecks (operator ruling, 2026-10-15)", () => {
  it("stops before any worker or writer state when the Claude CLI is signed out, with one plain step", () => {
    const value = setup();
    const result = launch(value, { agentRoot: value.agentRoot, input: "Build it" }, { FAKE_CLAUDE_SIGNED_OUT: "1" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("CLAUDE_SIGN_IN_NEEDED");
    expect(String(result.json.personAction)).toContain("claude auth login");
    expect(String(result.json.personAction)).not.toMatch(/\/login|MCP|OAuth/);
    expect(proofCount(value)).toBe(0);
    expect(existsSync(join(value.metadata, "vibe-writer.json"))).toBe(false);
  }, 20000);
  it("classifies an expired sign-in the CLI only reports at start and keeps the request for a retry", () => {
    const value = setup();
    const result = launch(value, { agentRoot: value.agentRoot, input: "AUTH_EXPIRED" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("CLAUDE_SIGN_IN_NEEDED");
    expect(String(result.json.personAction)).toContain("claude auth login");
    const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    expect(ledger.active.id).toBe("first");
    expect(ledger.active.status).toBe("FAILED");
    const retried = launch(value, { agentRoot: value.agentRoot, continuation: "Continue after sign-in" });
    expect(retried.status, JSON.stringify(retried.json)).toBe(0);
  }, 20000);
  it("stops a worker at its start event when a granted connection did not load", () => {
    const value = setup();
    const result = launch(value, { agentRoot: value.agentRoot, agentName: "vibe-guardrails-reviewer", input: "WAIT_FOR_CANCEL" },
      { FAKE_CLAUDE_DROP_SERVER: "custom_graph" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("MCP_TOOLS_MISSING");
    expect(String(result.json.summary)).toContain("custom_graph");
    // The brief is already piped at spawn, so the fixture may have recorded it; the process itself must be gone.
    for (const proof of proofCount(value) ? readProof(value.metadata) : []) expect(() => process.kill(proof.pid, 0)).toThrow();
  }, 20000);
  it("launches when Claude reports the granted MCP operations with hyphens", () => {
    const value = setup();
    const result = launch(value, { agentRoot: value.agentRoot, agentName: "vibe-requirements-worker",
      input: "Read scope", capabilities: [...graph, ...liveReads] }, { FAKE_CLAUDE_HYPHENATE_MCP: "1" });
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    const proof = readProof(value.metadata)[0];
    expect(proof?.definition["vibe:vibe-requirements-worker"]?.tools).toContain("mcp__live_workspace__get-document");
  }, 20000);
  it("refuses a requirements or ticket launch without the ClosedLoop reads it needs", () => {
    const value = setup();
    const startup = { kind: "startup" };
    const requirements = launch(value, { agentRoot: value.agentRoot, agentName: "vibe-requirements-worker",
      input: "Read scope", sessionless: startup });
    expect(requirements.json.code).toBe("MISSING_CAPABILITIES");
    expect(String(requirements.json.summary)).toContain("get_document");
    const ticket = launch(value, { agentRoot: value.agentRoot, agentName: "vibe-ticket-worker", input: "Create",
      mode: "record", recordAction: "create", exclusiveRecordTurn: true,
      capabilities: [...graph, { name: "mcp__live_workspace__create_document", service: "closedloop",
        operation: "create_document", access: "write" }] });
    expect(ticket.json.code).toBe("MISSING_CAPABILITIES");
    expect(proofCount(value)).toBe(0);
    const granted = launch(value, { agentRoot: value.agentRoot, agentName: "vibe-requirements-worker",
      input: "Read scope", capabilities: [...graph, ...liveReads] });
    expect(granted.status, JSON.stringify(granted.json)).toBe(0);
  }, 20000);
});
