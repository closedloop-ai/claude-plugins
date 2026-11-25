import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireRecordTurn, changeWriter, migrateWriter, registerWriter } from "./ledger.js";
import { runWorker } from "./claude-worker.js";
import { bundleDirectory, fixture, graph, liveReads, readProof, testsForChanges, updateDocument } from "./test-fixtures.js";
import { syncFixture } from "./main-sync-test-fixtures.js";
import type { Capability } from "./contracts.js";

const fixtures: { cleanup: () => void }[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });

const requestId = "limited-request";
const evidence = "turn failed: You've hit your usage limit";

/** A registered Codex writer, bound to `recorded`, whose turn stopped because the account reached its usage limit. */
function limitedCodexWriter(finish: "FAILED" | "BLOCKED" | false = "FAILED", recorded: Capability[] = graph) {
  const value = fixture();
  fixtures.push(value);
  writeFileSync(join(value.agentRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.0.12" }));
  const registered = registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "codex-native",
    agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: recorded });
  const owner = { worktree: value.worktree, workerId: registered.workerId, requestId };
  changeWriter("enqueue", { ...owner, input: "Original request" });
  const lease = changeWriter("claim", owner).turn!.lease!;
  if (finish) {
    changeWriter("finish", { ...owner, lease, status: finish, resultSummary: "Codex usage limit reached",
      stoppedTurn: { runtime: "codex", workerId: owner.workerId, requestId, lease, state: "failed" } });
  }
  const input = { worktree: value.worktree, runtime: "codex", agentRoot: value.agentRoot, agentName: "vibe-change-worker",
    capabilities: graph, previousWorkerId: registered.workerId, previousDigest: registered.definitionDigest,
    harnessSwitch: { to: "claude", cause: "usage-limit", evidence } };
  const ledgerFile = join(value.metadata, "vibe-writer.json");
  const read = () => JSON.parse(readFileSync(ledgerFile, "utf8"));
  return { ...value, registered, input, ledgerFile, read };
}

describe("harness switch for a writer whose runtime cannot run", () => {
  it("moves a stopped Codex writer to Claude with its definition present and keeps every record", () => {
    const value = limitedCodexWriter();
    const before = value.read();
    const migrated = migrateWriter(value.input, value.agentRoot);
    const after = value.read();
    expect(migrated.runtime).toBe("claude");
    expect(migrated.workerId).not.toBe(before.workerId);
    expect(migrated.lastMigration?.reason).toBe("harness-switch");
    expect(after.started).toBe(false);
    for (const key of ["pending", "active", "completed", "worktree", "branch"]) expect(after[key]).toEqual(before[key]);
    const { migrations: ignored, ...previous } = before;
    expect(after.migrations[0]).toMatchObject({ previous, reason: "harness-switch", workerId: after.workerId,
      harnessSwitch: { from: "codex", to: "claude", cause: "usage-limit", evidence } });
    expect(() => changeWriter("claim", { worktree: value.worktree, workerId: before.workerId, requestId,
      continuation: "Dead writer" })).toThrow(/registered/);
    const resumed = changeWriter("claim", { worktree: value.worktree, workerId: after.workerId, requestId,
      continuation: "Resume from checkpoint" });
    expect(resumed.turn?.input).toBe("Original request");
  });

  it("starts the switched writer through the owned Claude launcher, then resumes the same session", async () => {
    const value = limitedCodexWriter();
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot }), encoding: "utf8" });
    const migrated = JSON.parse(output);
    expect(migrated.runtime).toBe("claude");
    const originalPath = process.env.PATH;
    process.env.PATH = `${value.bin}:${originalPath}`;
    try {
      const launch = { worktree: value.worktree, agentRoot: currentRoot, agentName: "vibe-change-worker",
        capabilities: graph, mode: "plan", requestId, continuation: "Resume from checkpoint" };
      expect((await runWorker(launch)).workerId).toBe(migrated.workerId);
      const proof = readProof(value.metadata);
      expect(proof[0]!.args).toContain("--session-id");
      expect(proof[0]!.args).toContain(migrated.workerId);
    } finally { process.env.PATH = originalPath; }
  });

  it.each(["same-runtime", "running-source", "running-record", "refusal", "retained-record", "stale-id"])(
    "refuses an unsafe switch without changing the ledger: %s", failure => {
      const value = limitedCodexWriter(failure === "running-source" ? false : failure === "refusal" ? "BLOCKED" : "FAILED");
      const input: Record<string, unknown> = { ...value.input };
      if (failure === "same-runtime") input.harnessSwitch = { to: "codex", cause: "usage-limit", evidence };
      if (failure === "running-record") acquireRecordTurn(value.worktree);
      if (failure === "retained-record") input.retainedRecord = { lease: "00000000-0000-4000-8000-000000000000",
        stoppedTurn: { runtime: "codex", workerId: value.registered.workerId, requestId,
          lease: "00000000-0000-4000-8000-000000000000", state: "failed" } };
      if (failure === "stale-id") input.previousWorkerId = "another-writer";
      const before = readFileSync(value.ledgerFile, "utf8");
      expect(() => migrateWriter(input, value.agentRoot)).toThrow();
      expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    });
});

/** The tracker write the change worker's progress action declares, as Codex and as Claude Code spell its tool. */
const codexCreate: Capability = { name: "mcp__live_workspace__create_document_version", service: "tracker", operation: "create_document_version", access: "write" };
const claudeCreate: Capability = { name: "mcp__live-workspace__create-document-version", service: "tracker", operation: "create_document_version", access: "write" };
/** Record writes no change-worker action declares, which a Codex binding can carry. */
const codexUndeclared: Capability[] = ["update_document", "upload_attachment"].map((operation) => ({
  name: `mcp__live_workspace__${operation}`, service: "tracker", operation, access: "write" }));
const claudeUndeclared: Capability[] = codexUndeclared.map((capability) => ({ ...capability,
  name: `mcp__live-workspace__${capability.operation.replaceAll("_", "-")}` }));

describe("ISS-14689 OP1 (operator item, not a ticket criterion): migration requires the target runtime's capability names", () => {
  it("refuses a harness switch that names no capabilities for the new runtime", () => {
    const value = limitedCodexWriter();
    const { capabilities: ignored, ...input } = value.input;
    const before = readFileSync(value.ledgerFile, "utf8");
    expect(() => migrateWriter(input, value.agentRoot)).toThrow(/harness switch requires the capabilities .* in the new runtime's names/);
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
  });

  // Ruling (team lead, 2026-11-24): a switched writer may gain what the current definition declares, as a definition
  // change may, so a read a newer definition mandates is never out of reach.
  it.each([["code_tests_for_changes", [testsForChanges]], ["tracker reads", liveReads]] as const)(
    "lets a harness switch gain %s, which the current definition declares", (_gained, added) => {
      const value = limitedCodexWriter();
      const migrated = migrateWriter({ ...value.input, capabilities: [...graph, ...added] }, value.agentRoot);
      expect(migrated.lastMigration?.reason).toBe("harness-switch");
      expect(migrated.capabilities).toEqual([...graph, ...added].sort((a, b) => a.name.localeCompare(b.name)));
    });

  it("refuses a harness switch that gains an operation no change-worker action declares", () => {
    // A writer switched to Codex keeps every supplied write, so an undeclared one would be added to its binding.
    const value = fixture();
    fixtures.push(value);
    const registered = registerWriter({ worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: graph });
    const ledgerFile = join(value.metadata, "vibe-writer.json");
    const before = readFileSync(ledgerFile, "utf8");
    expect(() => migrateWriter({ worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: [...graph, updateDocument], previousWorkerId: registered.workerId,
      previousDigest: registered.definitionDigest, workerId: "codex-native",
      harnessSwitch: { to: "codex", cause: "runtime-unavailable", evidence: "claude: command not found" } }, value.agentRoot))
      .toThrow("A migration may add only the capabilities the current definition declares: mcp__live_workspace__update_document");
    expect(readFileSync(ledgerFile, "utf8")).toBe(before);
  });

  it.each([["a declared record write", [...graph], "mcp__live_workspace__create_document_version"],
    ["a read", [...graph.slice(1), claudeCreate], graph[0]!.name]] as const)(
    "refuses a harness switch whose capabilities drop %s the recorded binding holds, which no rebind could restore", (_dropped, supplied, name) => {
      const value = limitedCodexWriter("FAILED", [...graph, codexCreate, ...codexUndeclared]);
      const before = readFileSync(value.ledgerFile, "utf8");
      expect(() => migrateWriter({ ...value.input, capabilities: supplied }, value.agentRoot))
        .toThrow(`A harness switch may rename capabilities and drop undeclared writes, never drop a declared one: ${name}`);
      expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    });

  it("switches when the capabilities drop only the record writes Claude does not declare", () => {
    const value = limitedCodexWriter("FAILED", [...graph, codexCreate, ...codexUndeclared]);
    const migrated = migrateWriter({ ...value.input, capabilities: [...graph, claudeCreate] }, value.agentRoot);
    expect(migrated.lastMigration?.reason).toBe("harness-switch");
    expect(migrated.capabilities).toEqual([claudeCreate, ...graph].sort((a, b) => a.name.localeCompare(b.name)));
  });

  /** A Claude writer still bound to the names its Codex runtime used, as a pre-fix harness switch left it. */
  function codexNamedClaudeWriter(recorded: Capability[]) {
    const value = fixture();
    fixtures.push(value);
    const registered = registerWriter({ worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: recorded });
    const input = { worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot, agentName: "vibe-change-worker",
      previousWorkerId: registered.workerId, previousDigest: registered.definitionDigest };
    return { value, registered, input, ledgerFile: join(value.metadata, "vibe-writer.json") };
  }

  it("rebinds a writer whose capabilities differ only in naming, dropping undeclared writes", () => {
    const { value, registered, input, ledgerFile } = codexNamedClaudeWriter([...graph, codexCreate, ...codexUndeclared]);
    const migrated = migrateWriter({ ...input, capabilities: [...graph, claudeCreate] }, value.agentRoot);
    expect(migrated.lastMigration?.reason).toBe("capability-names");
    expect(migrated.workerId).not.toBe(registered.workerId);
    expect(migrated.capabilities).toEqual([claudeCreate, ...graph].sort((a, b) => a.name.localeCompare(b.name)));
    expect(JSON.parse(readFileSync(ledgerFile, "utf8")).binding.capabilities).toEqual(migrated.capabilities);
  });

  it.each(["identical", "widened", "narrowed"] as const)("refuses a rebind whose capabilities are %s", (change) => {
    const { value, input, ledgerFile } = codexNamedClaudeWriter([...graph, codexCreate]);
    const supplied = change === "identical" ? [...graph, codexCreate]
      : change === "widened" ? [...graph, claudeCreate, ...liveReads] : [...graph];
    const before = readFileSync(ledgerFile, "utf8");
    expect(() => migrateWriter({ ...input, capabilities: supplied }, value.agentRoot))
      .toThrow(change === "identical" ? /present and matching/ : /only in naming/);
    expect(readFileSync(ledgerFile, "utf8")).toBe(before);
  });

  it("refuses a same-runtime rebind that names no capabilities, even when the record carries undeclared writes", () => {
    const { value, input, ledgerFile } = codexNamedClaudeWriter([...graph, claudeCreate, ...claudeUndeclared]);
    const before = readFileSync(ledgerFile, "utf8");
    expect(() => migrateWriter(input, value.agentRoot)).toThrow(/present and matching/);
    expect(readFileSync(ledgerFile, "utf8")).toBe(before);
  });
});

describe("ISS-14689 AC4: a writer moved from Codex to Claude completes main-sync", () => {
  // One fixture carries the switched writer through main-sync, one launcher run per step so each step fits the
  // default test budget. The steps run in order; each starts from the state the step before it left.
  describe("ISS-14689 AC5: a Codex writer switched to Claude runs inputs, validate and push", () => {
    let value: ReturnType<typeof syncFixture> | undefined;
    let migrated: ReturnType<typeof migrateWriter> | undefined;
    let inputsRun: true | undefined;
    let transactionId: string | undefined;
    let validationWitness: unknown;
    let validated: true | undefined;
    beforeAll(() => { value = syncFixture(); });
    afterAll(() => value?.cleanup());
    /** The value an earlier step left, or a failure naming the step that did not leave it. */
    function left<T>(found: T | undefined, step: string): T {
      if (found === undefined) throw new Error(`the ${step} step did not complete`);
      return found;
    }
    const run = (agentName: string, recordAction: string, input: string, requestId: string, transaction?: string,
      mainSyncValidation?: unknown) => {
      const sync = left(value, "fixture");
      const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], { cwd: sync.worktree,
        input: JSON.stringify({ worktree: sync.worktree, agentRoot: sync.agentRoot, agentName, recordAction, input, requestId,
          mode: "record", exclusiveRecordTurn: true, capabilities: left(migrated, "switch").capabilities ?? [], publicationPurpose: "build",
          ...(transaction ? { mainSyncTransactionId: transaction } : {}), ...(mainSyncValidation ? { mainSyncValidation } : {}) }),
        encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${sync.bin}:${process.env.PATH}` } });
      expect(result.error).toBeUndefined();
      return { code: result.status, output: JSON.parse(result.stdout) };
    };

    it("ISS-14689 AC5: keeps only the capabilities its Claude actions declare", () => {
      const sync = left(value, "fixture");
      const registered = registerWriter({ worktree: sync.worktree, runtime: "codex", workerId: "codex-native",
        agentRoot: sync.agentRoot, agentName: "vibe-change-worker", capabilities: [...graph, codexCreate, ...codexUndeclared] });
      const owner = { worktree: sync.worktree, workerId: registered.workerId, requestId: "codex-turn" };
      changeWriter("enqueue", { ...owner, input: "Original request" });
      const lease = changeWriter("claim", owner).turn!.lease!;
      changeWriter("finish", { ...owner, lease, status: "DONE",
        stoppedTurn: { runtime: "codex", workerId: owner.workerId, requestId: owner.requestId, lease, state: "completed" } });
      const switched = migrateWriter({ worktree: sync.worktree, runtime: "codex", agentRoot: sync.agentRoot, agentName: "vibe-change-worker",
        capabilities: [...graph, claudeCreate, ...claudeUndeclared], previousWorkerId: registered.workerId,
        previousDigest: registered.definitionDigest, harnessSwitch: { to: "claude", cause: "usage-limit", evidence } }, sync.agentRoot);
      expect(switched.runtime).toBe("claude");
      expect(switched.capabilities).toEqual([claudeCreate, ...graph].sort((a, b) => a.name.localeCompare(b.name)));
      migrated = switched;
    });

    it("ISS-14689 AC5: runs the main-sync inputs through the Claude launcher as the switched writer", () => {
      const initial = run("vibe-change-worker", "progress", "MAIN_SYNC_INPUTS", "claude-inputs");
      expect(initial.code, JSON.stringify(initial.output)).toBe(0);
      expect(initial.output.workerId).toBe(left(migrated, "switch").workerId);
      inputsRun = true;
    });

    it("ISS-14689 AC5: prepares the main-sync transaction", () => {
      left(inputsRun, "inputs");
      const prepare = run("vibe-environment-worker", "create", "MAIN_SYNC_PREPARE", "claude-prepare");
      expect(prepare.code, JSON.stringify(prepare.output)).toBe(0);
      transactionId = prepare.output.data.mainSyncResult.mainSync.transactionId;
    });

    it("ISS-14689 AC5: records the switched writer's readiness for that transaction", () => {
      const ready = run("vibe-change-worker", "progress", "MAIN_SYNC_INPUTS", "claude-ready", left(transactionId, "prepare"));
      expect(ready.code, JSON.stringify(ready.output)).toBe(0);
      validationWitness = ready.output.data.mainSyncResult.mainSync.validationWitness;
    });

    // Validation runs the production main-sync-validate command, which proves the committed inputs before and after each
    // check: about 3 s of serial git calls on this fixture. Its launcher run sits in this describe's beforeAll, under the
    // default hook budget (team lead, 2026-11-24). The case asserts that run's actual result, and a failure inside the
    // hook is kept and rethrown by the case, so it fails the case rather than only the hook.
    describe("ISS-14689 AC5: validation as the switched writer", () => {
      let checked: ReturnType<typeof run> | undefined;
      let failure: unknown;
      beforeAll(() => {
        try {
          checked = run("vibe-change-worker", "progress", "MAIN_SYNC_VALIDATE", "claude-validate", left(transactionId, "prepare"),
            left(validationWitness, "readiness"));
        } catch (error) { failure = error; }
      });

      it("ISS-14689 AC5: validates the transaction as the switched writer with the readiness witness", () => {
        if (failure !== undefined) throw failure;
        const result = left(checked, "validation hook");
        expect(result.code, JSON.stringify(result.output)).toBe(0);
        expect(result.output.status).toBe("DONE");
        expect(result.output.workerId).toBe(left(migrated, "switch").workerId);
        validated = true;
      });
    });

    it("ISS-14689 AC5: pushes the validated head", () => {
      const sync = left(value, "fixture");
      left(validated, "validate");
      const pushed = run("vibe-environment-worker", "redeploy", "MAIN_SYNC_PUSH", "claude-push", left(transactionId, "prepare"));
      expect(pushed.code, JSON.stringify(pushed.output)).toBe(0);
      expect(sync.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(sync.git(["rev-parse", "HEAD"]));
    });
  });

  // A writer an earlier harness switch left on Claude with every recorded write, which the launcher refuses
  // (RECORD_CAPABILITY_UNDECLARED): spelled as Codex spells them, or already in Claude's names. One fixture per
  // spelling carries the rebind and then the launcher run, each its own case within the default test budget.
  describe.each([["Codex", [...graph, codexCreate, ...codexUndeclared]], ["Claude", [...graph, claudeCreate, ...claudeUndeclared]]] as const)(
    "ISS-14689 AC4: a Claude writer recorded with %s names and undeclared record writes", (_spelling, recorded) => {
    let value: ReturnType<typeof syncFixture> | undefined;
    let registered: ReturnType<typeof registerWriter> | undefined;
    let migrated: ReturnType<typeof migrateWriter> | undefined;
    beforeAll(() => {
      value = syncFixture();
      registered = registerWriter({ worktree: value.worktree, runtime: "claude", agentRoot: value.agentRoot,
        agentName: "vibe-change-worker", capabilities: [...recorded] });
    });
    afterAll(() => value?.cleanup());

    it("ISS-14689 AC4: is rebound with reason capability-names, refusing an added capability and dropping only the undeclared writes", () => {
      const sync = value!;
      const input = { worktree: sync.worktree, runtime: "claude", agentRoot: sync.agentRoot, agentName: "vibe-change-worker",
        previousWorkerId: registered!.workerId, previousDigest: registered!.definitionDigest };
      const ledgerFile = join(sync.metadata, "vibe-writer.json");
      const before = readFileSync(ledgerFile, "utf8");
      // Adding a capability is never a rebind.
      expect(() => migrateWriter({ ...input, capabilities: [...graph, claudeCreate, ...liveReads] }, sync.agentRoot)).toThrow(/only in naming/);
      expect(readFileSync(ledgerFile, "utf8")).toBe(before);
      const rebound = migrateWriter({ ...input, capabilities: [...graph, claudeCreate] }, sync.agentRoot);
      expect(rebound.lastMigration?.reason).toBe("capability-names");
      expect(rebound.capabilities).toEqual([claudeCreate, ...graph].sort((a, b) => a.name.localeCompare(b.name)));
      migrated = rebound;
    });

    it("ISS-14689 AC4: the rebound writer runs main-sync inputs through the bundled Claude launcher", () => {
      const sync = value!;
      if (!migrated) throw new Error("the rebind step did not complete");
      const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], { cwd: sync.worktree,
        input: JSON.stringify({ worktree: sync.worktree, agentRoot: sync.agentRoot, agentName: "vibe-change-worker",
          recordAction: "progress", input: "MAIN_SYNC_INPUTS", requestId: "rebound-inputs", mode: "record", exclusiveRecordTurn: true,
          capabilities: migrated.capabilities ?? [], publicationPurpose: "build" }),
        encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${sync.bin}:${process.env.PATH}` } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).workerId).toBe(migrated.workerId);
    });
  });
});
