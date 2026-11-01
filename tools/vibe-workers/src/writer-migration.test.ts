import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireRecordTurn, changeWriter, markClaudeStarted, migrateWriter, readWriterSummary, registerWriter } from "./ledger.js";
import { runWorker } from "./claude-worker.js";
import { acquireNativeRecord, releaseNativeRecord, verifyStrandedRecordGrant } from "./native-record.js";
import { bundleDirectory, fixture, graph, readProof, writeAgent } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });
function setup(runtime: "codex" | "claude" = "codex") {
  const value = fixture();
  fixtures.push(value);
  const oldRoot = join(value.base, "cache", "vibe", "1.0.10");
  const currentRoot = join(value.base, "cache", "vibe", "1.0.12");
  mkdirSync(oldRoot, { recursive: true });
  cpSync(value.agentRoot, oldRoot, { recursive: true });
  cpSync(value.agentRoot, currentRoot, { recursive: true });
  for (const [root, version] of [[oldRoot, "1.0.10"], [currentRoot, "1.0.12"]]) {
    writeFileSync(join(root!, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version }));
  }
  const registered = registerWriter({ worktree: value.worktree, runtime, agentRoot: oldRoot,
    agentName: "vibe-change-worker", capabilities: graph, ...(runtime === "codex" ? { workerId: "old-native" } : {}) });
  const input = { worktree: value.worktree, runtime, agentRoot: currentRoot, agentName: "vibe-change-worker",
    capabilities: graph, previousWorkerId: registered.workerId, previousDigest: registered.definitionDigest,
    ...(runtime === "codex" ? { workerId: "new-native" } : {}) };
  const ledgerFile = join(value.metadata, "vibe-writer.json");
  const read = () => JSON.parse(readFileSync(ledgerFile, "utf8"));
  return { ...value, oldRoot, currentRoot, registered, input, ledgerFile, read };
}

/** Keeps release N on disk while the real bundled CLI and launcher supply installed release N+1. */
function setupInstalledUpgrade(changed: boolean, runtime: "claude" | "codex" = "claude", track = true) {
  const value = fixture();
  if (track) fixtures.push(value);
  const installedRoot = resolve(bundleDirectory, "../../../..");
  const installedVersion = JSON.parse(readFileSync(join(installedRoot, ".claude-plugin", "plugin.json"), "utf8")).version as string;
  const [major, minor, patch] = installedVersion.split(".").map(Number);
  if (patch === undefined || patch < 1) throw new Error("Upgrade fixture needs a preceding patch release");
  const priorVersion = `${major}.${minor}.${patch - 1}`;
  const oldRoot = join(value.base, "cache", "vibe", priorVersion);
  cpSync(value.agentRoot, oldRoot, { recursive: true });
  writeFileSync(join(oldRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: priorVersion }));
  const installedAgent = readFileSync(join(installedRoot, "agents", "vibe-change-worker.md"), "utf8");
  writeFileSync(join(oldRoot, "agents", "vibe-change-worker.md"),
    changed ? `${installedAgent}\nLegacy release writer procedure applies to this prompt.\n` : installedAgent);
  const registered = registerWriter({ worktree: value.worktree, runtime, agentRoot: oldRoot,
    agentName: "vibe-change-worker", capabilities: graph, ...(runtime === "codex" ? { workerId: "old-native" } : {}) });
  const migrationInput = { worktree: value.worktree, runtime, agentRoot: installedRoot,
    agentName: "vibe-change-worker", capabilities: graph, previousWorkerId: registered.workerId,
    previousDigest: registered.definitionDigest, ...(runtime === "codex" ? { workerId: "new-native" } : {}) };
  const launch = { worktree: value.worktree, agentName: "vibe-change-worker", capabilities: graph,
    mode: "plan" as const, requestId: "upgrade-request", input: "PLAN_FIRST" };
  const ledgerFile = join(value.metadata, "vibe-writer.json");
  return { ...value, oldRoot, installedRoot, registered, migrationInput, launch, ledgerFile };
}

function bundledStatus(worktree: string) {
  return JSON.parse(execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "status"], {
    input: JSON.stringify({ worktree }), encoding: "utf8" }));
}

/** The old prompt is the exact 1.1.23 content before PR #373 added its protected-write instructions. */
function setupLiveUpgrade(track = true) {
  const value = fixture();
  if (track) fixtures.push(value);
  const installedRoot = resolve(bundleDirectory, "../../../..");
  const manifest = JSON.parse(readFileSync(join(installedRoot, ".claude-plugin", "plugin.json"), "utf8"));
  if (manifest.version !== "1.1.25") throw new Error("The live upgrade case belongs to the 1.1.25 release");
  const added = `Use native Edit or Write for files under the worktree's \`.claude/skills/\` and
\`.claude/commands/\`. A Bash redirect or tee into either directory is still a
protected write and is not the approved route. After any native edit refusal,
stop this request and return \`BLOCKED\` with the denial reason. Never retry the
file through Bash, Python, Node, tee, redirection, copy, move, or another tool.

`;
  const installedAgent = readFileSync(join(installedRoot, "agents", "vibe-change-worker.md"), "utf8");
  if (!installedAgent.includes(added)) throw new Error("The merged protected-write definition is missing");
  const oldAgent = installedAgent.replace(added, "");
  if (createHash("sha256").update(oldAgent).digest("hex")
    !== "616389b7f933ee492990e807ae7b45a55fbdabafb1dd4e50742334ac6d4de34a") {
    throw new Error("The reconstructed 1.1.23 definition differs from the shipped agent");
  }
  const oldRoot = join(value.base, "cache", "vibe", "1.1.23");
  cpSync(value.agentRoot, oldRoot, { recursive: true });
  writeFileSync(join(oldRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.1.23" }));
  writeFileSync(join(oldRoot, "agents", "vibe-change-worker.md"), oldAgent);
  const registered = registerWriter({ worktree: value.worktree, runtime: "claude", agentRoot: oldRoot,
    agentName: "vibe-change-worker", capabilities: graph });
  const requestId = "live-upgrade-request";
  const owner = { worktree: value.worktree, workerId: registered.workerId, requestId };
  changeWriter("enqueue", { ...owner, input: "Request started under vibe 1.1.23" });
  const previous = changeWriter("claim", owner).turn!;
  markClaudeStarted(value.worktree, owner.workerId, previous.lease!);
  changeWriter("finish", { ...owner, lease: previous.lease, status: "NEEDS_REVIEW" });
  return { ...value, oldRoot, installedRoot, registered, requestId,
    migrationInput: { worktree: value.worktree, runtime: "claude", agentRoot: installedRoot,
      agentName: "vibe-change-worker", capabilities: graph, previousWorkerId: registered.workerId,
      previousDigest: registered.definitionDigest },
    ledgerFile: join(value.metadata, "vibe-writer.json") };
}

describe("ISS-13506 installed release upgrade", () => {
  it("status detects a changed installed definition before launching a retained writer", () => {
    const value = setupInstalledUpgrade(true);
    const before = readFileSync(value.ledgerFile, "utf8");
    expect(bundledStatus(value.worktree).recordedDefinition).toBe("changed");
    expect(existsSync(value.oldRoot)).toBe(true);
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
  });

  it("status keeps a matching installed definition present and an unproven cache release unreadable", () => {
    const matching = setupInstalledUpgrade(false);
    expect(bundledStatus(matching.worktree).recordedDefinition).toBe("present");
    const unproven = setupInstalledUpgrade(true);
    const installedVersion = JSON.parse(readFileSync(join(unproven.installedRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
    writeFileSync(join(unproven.oldRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "vibe", version: installedVersion }));
    const before = readFileSync(unproven.ledgerFile, "utf8");
    expect(bundledStatus(unproven.worktree).recordedDefinition).toBe("unreadable");
    expect(() => migrateWriter(unproven.migrationInput, unproven.installedRoot)).toThrow(/no proven plugin version upgrade/);
    expect(readFileSync(unproven.ledgerFile, "utf8")).toBe(before);
  });

  describe("unchanged recorded Claude writer", () => {
    let value: ReturnType<typeof setupInstalledUpgrade>;
    beforeAll(() => {
      value = setupInstalledUpgrade(false, "claude", false);
      const owner = { worktree: value.worktree, workerId: value.registered.workerId, requestId: value.launch.requestId };
      changeWriter("enqueue", { ...owner, input: "Request started under the older release" });
      const previous = changeWriter("claim", owner).turn!;
      markClaudeStarted(value.worktree, owner.workerId, previous.lease!);
      changeWriter("finish", { ...owner, lease: previous.lease, status: "NEEDS_REVIEW" });
    });
    afterAll(() => value.cleanup());
    it("AC1 and AC4 resume the same Claude writer when the installed definition is unchanged and N remains", async () => {
      const previousPath = process.env.PATH;
      process.env.PATH = `${value.bin}:${previousPath}`;
      try {
        const resumed = await runWorker({ ...value.launch, input: undefined, continuation: "Continue under installed release" });
        expect(resumed.workerId).toBe(value.registered.workerId);
        const proof = readProof(value.metadata);
        expect(proof).toHaveLength(1);
        expect(proof[0]!.args).toContain("--resume");
        expect(proof[0]!.args).toContain(value.registered.workerId);
        expect(existsSync(value.oldRoot)).toBe(true);
        expect(JSON.parse(readFileSync(value.ledgerFile, "utf8")).migrations).toHaveLength(0);
      } finally { process.env.PATH = previousPath; }
    });
  });

  it("AC2 and AC4 migrate a changed installed definition through the bundled command while N remains", async () => {
    const value = setupInstalledUpgrade(true);
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify(value.migrationInput), encoding: "utf8" });
    const migrated = JSON.parse(output);
    expect(migrated.lastMigration?.reason).toBe("definition-upgraded");
    expect(existsSync(value.oldRoot)).toBe(true);
    const previousPath = process.env.PATH;
    process.env.PATH = `${value.bin}:${previousPath}`;
    try {
      const started = await runWorker(value.launch);
      expect(started.workerId).toBe(migrated.workerId);
      const proof = readProof(value.metadata);
      expect(proof).toHaveLength(1);
      expect(proof[0]!.args).toContain("--session-id");
      expect(proof[0]!.args).toContain(migrated.workerId);
    } finally { process.env.PATH = previousPath; }
  });
  describe("live 1.1.23 to 1.1.25 writer upgrade", () => {
    let value: ReturnType<typeof setupLiveUpgrade>;
    let migratedId: string;
    beforeAll(() => { value = setupLiveUpgrade(false); });
    afterAll(() => value.cleanup());
    it("AC3 status detects the changed definition and AC2 migrates the same active request", async () => {
      const before = readFileSync(value.ledgerFile, "utf8");
      expect(bundledStatus(value.worktree).recordedDefinition).toBe("changed");
      await expect(runWorker({ worktree: value.worktree, agentName: "vibe-change-worker", capabilities: graph,
        mode: "plan", requestId: value.requestId, continuation: "Continue after the upgrade" }))
        .rejects.toThrow(/writer-state\.mjs migrate/);
      expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
      expect(existsSync(join(value.metadata, "fake-proof.jsonl"))).toBe(false);
      const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
        input: JSON.stringify(value.migrationInput), encoding: "utf8" });
      const migrated = JSON.parse(output);
      migratedId = migrated.workerId;
      expect(migrated.lastMigration?.reason).toBe("definition-upgraded");
      const ledger = JSON.parse(readFileSync(value.ledgerFile, "utf8"));
      expect(ledger.binding.capabilities).toEqual(graph);
      expect(ledger.active).toMatchObject({ id: value.requestId, input: "Request started under vibe 1.1.23" });
      expect(ledger.migrations).toHaveLength(1);
      expect(ledger.migrations[0]).toMatchObject({ reason: "definition-upgraded",
        observedDigest: value.registered.definitionDigest,
        previous: { workerId: value.registered.workerId, active: { id: value.requestId } } });
      expect(bundledStatus(value.worktree).recordedDefinition).toBe("present");
      expect(existsSync(value.oldRoot)).toBe(true);
    });
    it("AC2 launcher continues the migrated writer's active request", async () => {
      const previousPath = process.env.PATH;
      process.env.PATH = `${value.bin}:${previousPath}`;
      try {
        const continued = await runWorker({ worktree: value.worktree, agentName: "vibe-change-worker",
          capabilities: graph, mode: "plan", requestId: value.requestId, continuation: "Continue after migration" });
        expect(continued.workerId).toBe(migratedId);
        expect(continued.sessionId).toBe(migratedId);
        expect(readProof(value.metadata)).toHaveLength(1);
        expect(readProof(value.metadata)[0]!.args).toContain(migratedId);
      } finally { process.env.PATH = previousPath; }
    });
  });

  it("AC2 preserves the Codex writer migration path with N still installed", () => {
    const value = setupInstalledUpgrade(true, "codex");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify(value.migrationInput), encoding: "utf8" });
    const migrated = JSON.parse(output);
    expect(migrated.workerId).toBe("new-native");
    expect(migrated.lastMigration?.reason).toBe("definition-upgraded");
    expect(existsSync(value.oldRoot)).toBe(true);
    changeWriter("enqueue", { worktree: value.worktree, workerId: migrated.workerId,
      requestId: "upgrade-request", input: "Continue under installed release" });
    expect(changeWriter("claim", { worktree: value.worktree, workerId: migrated.workerId,
      requestId: "upgrade-request" }).turn?.input).toBe("Continue under installed release");
  });

  it("AC3 refuses a changed unmigrated dispatch before spawn and names only the documented migrate command", () => {
    const value = setupInstalledUpgrade(true);
    const before = readFileSync(value.ledgerFile, "utf8");
    const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], {
      input: JSON.stringify(value.launch), encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` },
    });
    const outcome = JSON.parse(result.stdout || "{}");
    expect(result.status).toBe(1);
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.summary).toContain(`node ${join(value.installedRoot, "skills/vibe/scripts/dist/writer-state.mjs")} migrate`);
    expect(outcome.summary.match(/writer-state\.mjs migrate/g)).toHaveLength(1);
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    expect(existsSync(join(value.metadata, "fake-proof.jsonl"))).toBe(false);
  });
});

describe("recorded writer migration", () => {
  it("status says the recorded definition was removed, so the migration runs before any launch (ISS-13321)", () => {
    const value = setupInstalledUpgrade(false, "codex");
    expect(readWriterSummary(value.worktree)?.recordedDefinition).toBe("present");
    rmSync(value.oldRoot, { recursive: true });
    expect(readWriterSummary(value.worktree)?.recordedDefinition).toBe("removed");
    migrateWriter(value.migrationInput, value.installedRoot);
    expect(readWriterSummary(value.worktree)?.recordedDefinition).toBe("present");
  });
  it.each(["codex", "claude"] as const)("migrates a missing %s definition and preserves state and history", runtime => {
    const value = setup(runtime);
    const owner = { worktree: value.worktree, workerId: value.registered.workerId };
    changeWriter("enqueue", { ...owner, requestId: "earlier", input: "Completed request" });
    const earlier = changeWriter("claim", { ...owner, requestId: "earlier" }).turn!;
    changeWriter("finish", { ...owner, requestId: "earlier", lease: earlier.lease, status: "DONE",
      ...(runtime === "codex" ? { stoppedTurn: { runtime, workerId: owner.workerId,
        requestId: "earlier", lease: earlier.lease, state: "completed" } } : {}) });
    changeWriter("enqueue", { ...owner, requestId: "first", input: "Original request" });
    changeWriter("enqueue", { ...owner, requestId: "second", input: "Queued request" });
    const claim = changeWriter("claim", { ...owner, requestId: "first" });
    if (runtime === "claude") markClaudeStarted(value.worktree, owner.workerId, claim.turn!.lease!);
    changeWriter("finish", { ...owner, requestId: "first", lease: claim.turn!.lease, status: "NEEDS_REVIEW",
      resultSummary: "Keep the checkpoint", ...(runtime === "codex" ? { stoppedTurn: { runtime,
        workerId: owner.workerId, requestId: "first", lease: claim.turn!.lease, state: "completed" } } : {}) });
    const recordPaths = ["plan.md", "decision-table.md", "checkpoint.md", "change-log.md"];
    for (const name of recordPaths) writeFileSync(join(value.worktree, name), name);
    const before = value.read();
    rmSync(value.oldRoot, { recursive: true });
    const migrated = migrateWriter(value.input, value.currentRoot);
    const after = value.read();
    expect(migrated.workerId).not.toBe(owner.workerId);
    expect(migrated.migrationCount).toBe(1);
    expect(migrated).not.toHaveProperty("carriedBlock");
    expect(after.started).toBe(false);
    for (const key of ["pending", "active", "completed", "worktree", "branch"]) expect(after[key]).toEqual(before[key]);
    const { migrations: ignored, ...previous } = before;
    expect(after.migrations[0]).toMatchObject({ previous, binding: after.binding,
      workerId: after.workerId, reason: "definition-missing", observedDigest: null });
    expect(Date.parse(after.migrations[0].at)).toBeGreaterThan(0);
    for (const name of recordPaths) expect(readFileSync(join(value.worktree, name), "utf8")).toBe(name);
    const firstHistory = after.migrations[0];
    rmSync(value.currentRoot, { recursive: true });
    const nextRoot = join(value.base, "cache", "vibe", "1.0.13");
    cpSync(value.agentRoot, nextRoot, { recursive: true });
    writeFileSync(join(nextRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.0.13" }));
    migrateWriter({ ...value.input, agentRoot: nextRoot, workerId: runtime === "codex" ? "third-native" : undefined,
      previousWorkerId: after.workerId, previousDigest: after.binding.digest }, nextRoot);
    expect(value.read().migrations).toHaveLength(2);
    expect(value.read().migrations[0]).toEqual(firstHistory);
    expect(() => changeWriter("claim", { ...owner, requestId: "first", continuation: "Stale writer" })).toThrow(/registered/);
    const latest = readWriterSummary(value.worktree)!;
    const resumed = changeWriter("claim", { ...owner, workerId: latest.workerId, requestId: "first", continuation: "Resume from checkpoint" });
    expect(resumed.turn?.input).toBe("Original request");
  });

  it("records the observed and recorded digests for a proven upgrade", () => {
    const value = setup();
    writeAgent(value.oldRoot, "vibe-change-worker", "Read, Write, Edit");
    const result = migrateWriter(value.input, value.currentRoot);
    const event = value.read().migrations[0];
    expect(event.reason).toBe("definition-upgraded");
    expect(event.observedDigest).not.toBe(event.previous.binding.digest);
    expect(event.previous.binding.digest).toBe(value.registered.definitionDigest);
    expect(event.binding.digest).toBe(result.definitionDigest);
    expect(event.binding.agentRoot).toBe(value.currentRoot);
  });

  it("migrates after an upgrade deleted the recorded version dir once a stopped helper's grant there is released", () => {
    const value = setup();
    const helper = { worktree: value.worktree, agentRoot: value.oldRoot, agentName: "vibe-ticket-worker", workerId: "native-helper",
      requestId: "ticket-publish", mode: "record", recordAction: "create", exclusiveRecordTurn: true };
    const { lease } = acquireNativeRecord(helper);
    rmSync(value.oldRoot, { recursive: true });
    expect(() => migrateWriter(value.input, value.currentRoot)).toThrow(/Wait for owned source and record turns/);
    releaseNativeRecord({ ...helper, lease, stoppedTurn: { runtime: "codex", workerId: helper.workerId,
      requestId: helper.requestId, lease, state: "completed" } });
    expect(migrateWriter(value.input, value.currentRoot).lastMigration?.reason).toBe("definition-missing");
  });
  it("keeps the recorded capabilities when migrate is sent none (ISS-13291)", () => {
    const value = setup();
    rmSync(value.oldRoot, { recursive: true });
    const { capabilities: ignored, ...input } = value.input;
    migrateWriter(input, value.currentRoot);
    expect(value.read().binding.capabilities).toEqual(value.read().migrations[0].previous.binding.capabilities);
    expect(value.read().binding.capabilities.length).toBeGreaterThan(0);
  });
  it("migrates when the recorded agent file alone is missing", () => {
    const value = setup();
    rmSync(join(value.oldRoot, "agents", "vibe-change-worker.md"));
    expect(migrateWriter(value.input, value.currentRoot).lastMigration?.reason).toBe("definition-missing");
  });

  it("uses the shipped command for a held Codex writer", () => {
    const value = setup();
    rmSync(value.oldRoot, { recursive: true });
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot }), encoding: "utf8" });
    expect(JSON.parse(output).workerId).toBe("new-native");
    expect(value.read().binding.agentRoot).toBe(currentRoot);
  });

  it("refuses a present matching definition without changing the ledger", () => {
    const value = setup();
    const before = readFileSync(value.ledgerFile, "utf8");
    expect(() => migrateWriter(value.input, value.currentRoot)).toThrow(/present and matching/);
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    expect(() => registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "new-native",
      agentRoot: value.currentRoot, agentName: "vibe-change-worker", capabilities: graph })).toThrow(/identity/);
  });

  it.each(["same-release", "downgrade", "unknown-release", "invalid-definition", "wrong-root", "stale-id", "stale-digest"])(
    "refuses unproven or invalid migration: %s", failure => {
      const value = setup();
      writeAgent(value.oldRoot, "vibe-change-worker", "Read, Write, Edit");
      if (failure === "same-release" || failure === "downgrade") writeFileSync(join(value.currentRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "vibe", version: failure === "same-release" ? "1.0.10" : "1.0.9" }));
      if (failure === "unknown-release") {
        const ledger = value.read();
        ledger.binding.agentRoot = value.agentRoot;
        writeFileSync(value.ledgerFile, JSON.stringify(ledger));
        writeAgent(value.agentRoot, "vibe-change-worker", "Read, Write, Edit");
      }
      if (failure === "invalid-definition") writeFileSync(join(value.oldRoot, "agents", "vibe-change-worker.md"), "Not an agent");
      if (failure === "wrong-root") value.input.agentRoot = value.oldRoot;
      if (failure === "stale-id") value.input.previousWorkerId = "wrong-writer";
      if (failure === "stale-digest") value.input.previousDigest = "0".repeat(64);
      const before = readFileSync(value.ledgerFile, "utf8");
      expect(() => migrateWriter(value.input, value.currentRoot)).toThrow();
      expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    });

  it.each(["running-source", "running-record", "reused-id"])("retains ownership protections: %s", failure => {
    const value = setup();
    rmSync(value.oldRoot, { recursive: true });
    const owner = { worktree: value.worktree, workerId: value.registered.workerId, requestId: "held" };
    if (failure === "running-source") {
      changeWriter("enqueue", { ...owner, input: "Keep this request" });
      changeWriter("claim", owner);
    }
    if (failure === "running-record") acquireRecordTurn(value.worktree);
    if (failure === "reused-id") value.input.workerId = value.registered.workerId;
    const before = readFileSync(value.ledgerFile, "utf8");
    expect(() => migrateWriter(value.input, value.currentRoot)).toThrow();
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
  });

  it("uses the shipped command and launches a fresh Claude session, then resumes it", async () => {
    const value = setup("claude");
    rmSync(value.oldRoot, { recursive: true });
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot }), encoding: "utf8" });
    const migrated = JSON.parse(output);
    expect(migrated.migrationCount).toBe(1);
    const originalPath = process.env.PATH;
    process.env.PATH = `${value.bin}:${originalPath}`;
    try {
      const launch = { worktree: value.worktree, agentRoot: currentRoot, agentName: "vibe-change-worker",
        capabilities: graph, mode: "plan", requestId: "migrated-request", input: "PLAN_FIRST" };
      expect((await runWorker(launch)).workerId).toBe(migrated.workerId);
      expect((await runWorker({ ...launch, input: undefined, continuation: "Finish it" })).workerId).toBe(migrated.workerId);
      const proof = readProof(value.metadata);
      expect(proof[0]!.args).toContain("--session-id");
      expect(proof[0]!.args).toContain(migrated.workerId);
      expect(proof[1]!.args).toContain("--resume");
      expect(proof[1]!.args).toContain(migrated.workerId);
      expect(value.read().migrations).toHaveLength(1);
    } finally { process.env.PATH = originalPath; }
  });
});

type Setup = ReturnType<typeof setup>;
const requestId = "stranded-request";

/** A Codex writer whose record continuation completed and stopped while its pinned plugin cache was removed. */
function strand(value: Setup, options: { finish?: "BLOCKED" | "NEEDS_REVIEW" | false; blockReason?: "recorded-definition-removed";
  legacy?: boolean; helperGrant?: boolean; foreignRoot?: boolean } = {}) {
  const owner = { worktree: value.worktree, workerId: value.registered.workerId, requestId };
  changeWriter("enqueue", { ...owner, input: "Restore the section" });
  const sourceLease = changeWriter("claim", owner).turn!.lease!;
  const foreignRoot = join(value.base, "cache", "vibe", "1.0.11");
  if (options.foreignRoot) cpSync(value.oldRoot, foreignRoot, { recursive: true });
  const grant = options.helperGrant
    ? { worktree: value.worktree, agentRoot: value.oldRoot, agentName: "vibe-ticket-worker", workerId: "native-helper",
      requestId: "ticket-progress", mode: "record", recordAction: "create", exclusiveRecordTurn: true }
    : { worktree: value.worktree, agentRoot: options.foreignRoot ? foreignRoot : value.oldRoot, agentName: "vibe-change-worker", workerId: owner.workerId,
      requestId, mode: "record", recordAction: "progress", exclusiveRecordTurn: true,
      primaryOwner: { workerId: owner.workerId, lease: sourceLease } };
  if (options.helperGrant) {
    changeWriter("finish", { ...owner, lease: sourceLease, status: "NEEDS_REVIEW", stoppedTurn: { runtime: "codex",
      workerId: owner.workerId, requestId, lease: sourceLease, state: "completed" } });
  }
  const { lease } = acquireNativeRecord(grant);
  rmSync(value.oldRoot, { recursive: true });
  rmSync(foreignRoot, { recursive: true, force: true });
  if (!options.helperGrant && options.finish !== false) {
    changeWriter("finish", { ...owner, lease: sourceLease, status: options.finish ?? "BLOCKED", stoppedTurn: { runtime: "codex",
      workerId: owner.workerId, requestId, lease: sourceLease, state: "completed" },
      resultSummary: "Recorded definition removed", ...(options.blockReason ? { blockReason: options.blockReason } : {}) });
  }
  if (options.legacy) {
    const ledger = value.read();
    delete ledger.active.blockReason;
    writeFileSync(value.ledgerFile, JSON.stringify(ledger));
  }
  const stoppedTurn = { runtime: "codex" as const, workerId: grant.workerId, requestId: grant.requestId, lease, state: "completed" as const };
  const lock = join(value.metadata, "vibe-record-turn.lock");
  return { owner, lease, lock, retainedRecord: { lease, stoppedTurn } };
}
function snapshot(value: Setup, lock: string) {
  return { ledger: readFileSync(value.ledgerFile, "utf8"),
    grant: existsSync(lock) ? readFileSync(join(lock, "native-owner.json"), "utf8") : undefined };
}

describe("stranded writer recovery", () => {
  it("releases a pre-reason BLOCKED writer's own stranded grant and migrates it through the shipped command", () => {
    const value = setup();
    const stranded = strand(value, { legacy: true });
    const before = value.read();
    expect(before.active).toMatchObject({ id: requestId, status: "BLOCKED" });
    expect(before.active.blockReason).toBeUndefined();
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot, retainedRecord: stranded.retainedRecord }), encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ workerId: "new-native", activeRequestId: requestId, running: false, migrationCount: 1 });
    expect(existsSync(stranded.lock)).toBe(false);
    const after = value.read();
    const { migrations: ignored, ...previous } = before;
    expect(after.migrations[0]).toMatchObject({ reason: "definition-missing", observedDigest: null,
      workerId: "new-native", releasedRecord: { requestId, recordAction: "progress", state: "completed" } });
    expect(after.migrations[0].previous).toEqual(previous);
    expect(JSON.stringify(after.migrations[0])).not.toContain(stranded.lease);
    for (const key of ["pending", "completed", "worktree", "branch"]) expect(after[key]).toEqual(before[key]);
    expect(after.active).toEqual({ ...before.active, blockReason: "recorded-definition-removed" });
    const resumed = changeWriter("claim", { ...stranded.owner, workerId: "new-native", continuation: "Resume from checkpoint" });
    expect(resumed.turn?.input).toBe("Restore the section");
  });

  it("migrates a writer that finished BLOCKED with the machine-readable removed-definition reason", () => {
    const value = setup();
    const stranded = strand(value, { blockReason: "recorded-definition-removed" });
    expect(value.read().active.blockReason).toBe("recorded-definition-removed");
    const result = migrateWriter({ ...value.input, retainedRecord: stranded.retainedRecord }, value.currentRoot, verifyStrandedRecordGrant);
    expect(result.status).toBe("BLOCKED");
    expect(result).not.toHaveProperty("carriedBlock");
    expect(existsSync(stranded.lock)).toBe(false);
  });

  it("migrates a removed-definition BLOCKED writer that holds no record grant", () => {
    const value = setup();
    const owner = { worktree: value.worktree, workerId: value.registered.workerId, requestId };
    changeWriter("enqueue", { ...owner, input: "Restore the section" });
    const lease = changeWriter("claim", owner).turn!.lease!;
    rmSync(value.oldRoot, { recursive: true });
    changeWriter("finish", { ...owner, lease, status: "BLOCKED", blockReason: "recorded-definition-removed",
      stoppedTurn: { runtime: "codex", workerId: owner.workerId, requestId, lease, state: "completed" } });
    expect(migrateWriter(value.input, value.currentRoot).lastMigration?.reason).toBe("definition-missing");
  });

  it("releases a stranded grant left behind by an otherwise finished turn", () => {
    const value = setup();
    const stranded = strand(value, { finish: "NEEDS_REVIEW" });
    const result = migrateWriter({ ...value.input, retainedRecord: stranded.retainedRecord }, value.currentRoot, verifyStrandedRecordGrant);
    expect(result).toMatchObject({ status: "NEEDS_REVIEW", workerId: "new-native" });
    expect(value.read().active.blockReason).toBeUndefined();
    expect(existsSync(stranded.lock)).toBe(false);
  });

  it("records a removed-definition block reason only for a BLOCKED finish whose recorded definition is absent", () => {
    const value = setup();
    const owner = { worktree: value.worktree, workerId: value.registered.workerId, requestId };
    changeWriter("enqueue", { ...owner, input: "Restore the section" });
    const lease = changeWriter("claim", owner).turn!.lease!;
    const finish = { ...owner, lease, status: "BLOCKED", blockReason: "recorded-definition-removed",
      stoppedTurn: { runtime: "codex", workerId: owner.workerId, requestId, lease, state: "completed" } };
    const before = readFileSync(value.ledgerFile, "utf8");
    expect(() => changeWriter("finish", finish)).toThrow(/present/);
    rmSync(value.oldRoot, { recursive: true });
    expect(() => changeWriter("finish", { ...finish, status: "NEEDS_REVIEW" })).toThrow(/Only a BLOCKED/);
    expect(readFileSync(value.ledgerFile, "utf8")).toBe(before);
    changeWriter("finish", { ...finish, blockReason: undefined });
    expect(value.read().active.blockReason).toBe("other");
  });

  const refusal = /bypass a writer refusal/;
  const stopped = /Wait for owned source and record turns/;
  const evidence = /own record grant and its exact stopped-turn evidence/;
  it.each([["upgraded-other-block", refusal], ["running-lease", stopped], ["no-evidence", stopped],
    ["wrong-lease", evidence], ["wrong-request", evidence], ["wrong-worker", evidence], ["helper-grant", evidence], ["foreign-root", evidence],
    ["matching-definition", /present and matching/], ["grant-definition-present", /release it with release-record/],
    ["stale-id", /exact recorded writer/], ["stale-digest", /exact recorded writer/], ["no-verifier", stopped]] as const)(
    "refuses stranded recovery without changing the ledger or grant: %s", (failure, expected) => {
      const value = setup();
      const options: Parameters<typeof strand>[1] = { legacy: true };
      if (failure === "upgraded-other-block") options.legacy = false;
      if (failure === "running-lease") options.finish = false;
      if (failure === "helper-grant") options.helperGrant = true;
      if (failure === "foreign-root") options.foreignRoot = true;
      const preserved = join(value.base, "preserved-old-root");
      if (failure === "matching-definition" || failure === "grant-definition-present" || failure === "upgraded-other-block") {
        cpSync(value.oldRoot, preserved, { recursive: true });
      }
      const stranded = strand(value, options);
      if (failure === "upgraded-other-block") {
        // The recorded root is back with a newer definition, so the recorded writer can still run and settle its refusal.
        rmSync(stranded.lock, { recursive: true });
        cpSync(preserved, value.oldRoot, { recursive: true });
        writeAgent(value.oldRoot, "vibe-change-worker", "Read, Write, Edit");
      }
      if (failure === "matching-definition") cpSync(preserved, value.oldRoot, { recursive: true });
      if (failure === "grant-definition-present") {
        cpSync(preserved, value.oldRoot, { recursive: true });
        writeAgent(value.oldRoot, "vibe-change-worker", "Read, Write, Edit");
      }
      let retainedRecord: unknown = stranded.retainedRecord;
      const stoppedTurn = stranded.retainedRecord.stoppedTurn;
      if (failure === "no-evidence") retainedRecord = undefined;
      if (failure === "wrong-lease") retainedRecord = { lease: stranded.lease,
        stoppedTurn: { ...stoppedTurn, lease: "11111111-1111-4111-8111-111111111111" } };
      if (failure === "wrong-request") retainedRecord = { lease: stranded.lease, stoppedTurn: { ...stoppedTurn, requestId: "other-request" } };
      if (failure === "wrong-worker") retainedRecord = { lease: stranded.lease, stoppedTurn: { ...stoppedTurn, workerId: "other-writer" } };
      if (failure === "upgraded-other-block") retainedRecord = undefined;
      const input = { ...value.input, ...(retainedRecord ? { retainedRecord } : {}) };
      if (failure === "stale-id") input.previousWorkerId = "wrong-writer";
      if (failure === "stale-digest") input.previousDigest = "0".repeat(64);
      const before = snapshot(value, stranded.lock);
      expect(() => migrateWriter(input, value.currentRoot, failure === "no-verifier" ? undefined : verifyStrandedRecordGrant)).toThrow(expected);
      expect(snapshot(value, stranded.lock)).toEqual(before);
    });
});

/** A writer whose last turn ended BLOCKED for its own reason, then lost its definition to a plugin update (ISS-13291). */
function blockedThenUpdated(runtime: "codex" | "claude") {
  const value = setup(runtime);
  const owner = { worktree: value.worktree, workerId: value.registered.workerId };
  changeWriter("enqueue", { ...owner, requestId: "record-01", input: "Record the build on the ticket" });
  changeWriter("enqueue", { ...owner, requestId: "next-01", input: "Queued after the record" });
  const lease = changeWriter("claim", { ...owner, requestId: "record-01" }).turn!.lease!;
  changeWriter("finish", { ...owner, requestId: "record-01", lease, status: "BLOCKED", resultSummary: "Ticket write refused",
    ...(runtime === "codex" ? { stoppedTurn: { runtime, workerId: owner.workerId, requestId: "record-01", lease,
      state: "completed" } } : {}) });
  expect(value.read().active).toMatchObject({ id: "record-01", status: "BLOCKED", blockReason: "other" });
  rmSync(value.oldRoot, { recursive: true });
  return { ...value, owner };
}

describe("a BLOCKED writer stranded by a plugin update (ISS-13291)", () => {
  it.each(["codex", "claude"] as const)("carries a %s writer's BLOCKED request over unchanged; the new writer settles it first", runtime => {
    const value = blockedThenUpdated(runtime);
    const before = value.read();
    const migrated = migrateWriter(value.input, value.currentRoot);
    expect(migrated).toMatchObject({ activeRequestId: "record-01", status: "BLOCKED", running: false, migrationCount: 1,
      carriedBlock: { requestId: "record-01", blockReason: "other", resultSummary: "Ticket write refused" } });
    const after = value.read();
    expect(after.active).toEqual(before.active);
    for (const key of ["pending", "completed"]) expect(after[key]).toEqual(before[key]);
    expect(after.migrations[0]).toMatchObject({ reason: "definition-missing", observedDigest: null });
    const writer = { worktree: value.worktree, workerId: migrated.workerId };
    expect(() => changeWriter("claim", { ...writer, requestId: "next-01" })).toThrow(/Continue the active request/);
    const settled = changeWriter("claim", { ...writer, requestId: "record-01", continuation: "Settle the refusal first" });
    expect(settled.turn).toMatchObject({ id: "record-01", input: "Record the build on the ticket", continuation: "Settle the refusal first" });
  });

  it("carries a pre-reason BLOCKED request with no retained grant", () => {
    const value = blockedThenUpdated("codex");
    const ledger = value.read();
    delete ledger.active.blockReason;
    writeFileSync(value.ledgerFile, JSON.stringify(ledger));
    expect(migrateWriter(value.input, value.currentRoot)).toMatchObject({ activeRequestId: "record-01", status: "BLOCKED" });
    expect(value.read().active.blockReason).toBeUndefined();
  });

  it("releases the writer's own stranded grant and carries its BLOCKED other request", () => {
    const value = setup();
    const stranded = strand(value);
    expect(value.read().active).toMatchObject({ status: "BLOCKED", blockReason: "other" });
    const result = migrateWriter({ ...value.input, retainedRecord: stranded.retainedRecord }, value.currentRoot, verifyStrandedRecordGrant);
    expect(result).toMatchObject({ status: "BLOCKED", activeRequestId: requestId, workerId: "new-native" });
    expect(value.read().active.blockReason).toBe("other");
    expect(existsSync(stranded.lock)).toBe(false);
  });

  it("recovers through the shipped command for a held Codex writer", () => {
    const value = blockedThenUpdated("codex");
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const output = execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot }), encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ workerId: "new-native", activeRequestId: "record-01", status: "BLOCKED" });
    const settled = changeWriter("claim", { worktree: value.worktree, workerId: "new-native", requestId: "record-01",
      continuation: "Settle the refusal first" });
    expect(settled.turn?.input).toBe("Record the build on the ticket");
  });

  it("recovers through the shipped command and resumes the request in a fresh Claude session", async () => {
    const value = blockedThenUpdated("claude");
    const currentRoot = resolve(bundleDirectory, "../../../..");
    const migrated = JSON.parse(execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ ...value.input, agentRoot: currentRoot }), encoding: "utf8" }));
    expect(migrated).toMatchObject({ activeRequestId: "record-01", status: "BLOCKED", migrationCount: 1 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${value.bin}:${originalPath}`;
    try {
      const result = await runWorker({ worktree: value.worktree, agentRoot: currentRoot, agentName: "vibe-change-worker",
        capabilities: graph, mode: "plan", requestId: "record-01", continuation: "Settle the refusal first" });
      expect(result.workerId).toBe(migrated.workerId);
      const proof = readProof(value.metadata);
      expect(proof[0]!.args).toContain("--session-id");
      expect(proof[0]!.args).toContain(migrated.workerId);
    } finally { process.env.PATH = originalPath; }
  });
});
