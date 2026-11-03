import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRecordTurn, changeWriter, migrateWriter, registerWriter } from "./ledger.js";
import { runWorker } from "./claude-worker.js";
import { bundleDirectory, fixture, graph, readProof } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });

const requestId = "limited-request";
const evidence = "turn failed: You've hit your usage limit";

/** A registered Codex writer whose turn stopped because the account reached its usage limit. */
function limitedCodexWriter(finish: "FAILED" | "BLOCKED" | false = "FAILED") {
  const value = fixture();
  fixtures.push(value);
  writeFileSync(join(value.agentRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.0.12" }));
  const registered = registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "codex-native",
    agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
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
