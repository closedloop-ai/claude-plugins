import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changeWriter, readWriterSummary } from "./ledger.js";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";
import { acquireNativeRecord, releaseNativeRecord } from "./native-record.js";
import { bundleDirectory, graph } from "./test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("stranded handoff writer recovery", () => {
  it("recovers a canceled handoff continuation whose root vanished, then validates, publishes and records with fresh grants", () => {
    const value = syncFixture(); fixtures.push(value);
    const prepare = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const ledgerFile = join(value.metadata, "vibe-writer.json");
    const old = value.sourceTurn("handoff");
    expect(invokeSync(value, "validate", old.context).status).toBe(0);
    const { lease: sourceLease, id: requestId } = JSON.parse(readFileSync(ledgerFile, "utf8")).active;
    const grant = { worktree: value.worktree, agentRoot: value.agentRoot, agentName: "vibe-change-worker", workerId: "fixture-source",
      requestId, mode: "record", recordAction: "progress", exclusiveRecordTurn: true, publicationPurpose: "handoff",
      mainSyncTransactionId: old.context.mainSyncTransactionId, primaryOwner: { workerId: "fixture-source", lease: sourceLease } };
    const stoppedTurn = { runtime: "codex" as const, workerId: "fixture-source", requestId, state: "canceled" as const };
    rmSync(value.agentRoot, { recursive: true });
    expect(() => releaseNativeRecord({ ...grant, lease: old.context.lease, stoppedTurn: { ...stoppedTurn, lease: old.context.lease } }))
      .toThrow(/ENOENT/);
    changeWriter("finish", { worktree: value.worktree, workerId: "fixture-source", requestId, lease: sourceLease, status: "BLOCKED",
      stoppedTurn: { ...stoppedTurn, lease: sourceLease } });
    const legacy = JSON.parse(readFileSync(ledgerFile, "utf8"));
    delete legacy.active.blockReason;
    writeFileSync(ledgerFile, JSON.stringify(legacy));

    const currentRoot = resolve(bundleDirectory, "../../../..");
    const migrated = JSON.parse(execFileSync(process.execPath, [join(bundleDirectory, "writer-state.mjs"), "migrate"], {
      input: JSON.stringify({ worktree: value.worktree, runtime: "codex", workerId: "recovered-native", agentRoot: currentRoot,
        agentName: "vibe-change-worker", capabilities: graph, previousWorkerId: "fixture-source", previousDigest: legacy.binding.digest,
        retainedRecord: { lease: old.context.lease, stoppedTurn: { ...stoppedTurn, lease: old.context.lease } } }), encoding: "utf8" }));
    expect(migrated).toMatchObject({ workerId: "recovered-native", activeRequestId: requestId, running: false });
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);

    const source = { worktree: value.worktree, workerId: "recovered-native", requestId };
    const lease = changeWriter("claim", { ...source, continuation: "Resume handoff from the checkpoint" }).turn!.lease!;
    const fresh = { ...grant, agentRoot: currentRoot, workerId: "recovered-native", primaryOwner: { workerId: "recovered-native", lease } };
    const record = acquireNativeRecord(fresh);
    try {
      const validated = invokeSync(value, "validate", { runtime: "codex", worktree: value.worktree, agentName: "vibe-change-worker",
        mode: "record", recordAction: "progress", workerId: "recovered-native", requestId, lease: record.lease,
        publicationPurpose: "handoff", mainSyncTransactionId: fresh.mainSyncTransactionId });
      expect(validated.status, validated.stdout).toBe(0);
    } finally {
      releaseNativeRecord({ ...fresh, lease: record.lease, stoppedTurn: { ...stoppedTurn, workerId: "recovered-native",
        lease: record.lease, state: "completed" } });
    }
    changeWriter("finish", { ...source, lease, status: "NEEDS_REVIEW",
      stoppedTurn: { ...stoppedTurn, workerId: "recovered-native", lease, state: "completed" } });
    expect(readWriterSummary(value.worktree)).toMatchObject({ workerId: "recovered-native", status: "NEEDS_REVIEW", running: false });

    const publisher = value.start("redeploy", "handoff", currentRoot);
    try { expect(invokeSync(value, "push", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    for (const recordAction of ["handoff", "assign"]) {
      const ticket = { worktree: value.worktree, agentRoot: currentRoot, agentName: "vibe-ticket-worker", workerId: `ticket-${recordAction}`,
        requestId: `ticket-${recordAction}`, mode: "record", recordAction, exclusiveRecordTurn: true };
      const acquired = acquireNativeRecord(ticket);
      releaseNativeRecord({ ...ticket, lease: acquired.lease, stoppedTurn: { runtime: "codex", workerId: ticket.workerId,
        requestId: ticket.requestId, lease: acquired.lease, state: "completed" } });
    }
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(value.git(["rev-parse", "HEAD"]));
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
  }, 60000);
});
