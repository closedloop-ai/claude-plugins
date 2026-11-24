import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armMcpInitWatchdog,
  canStartWorkerAttempt,
  createTurnCap,
  remainingWorkerTurnBudget,
  runWorker,
  safeFailure,
  testAuthoringGranted,
} from "./claude-worker.js";
import { ownedSyncCheckout, syncLocation } from "./main-sync-state.js";
import { fixture, graph, PROVIDER_BINDING } from "./test-fixtures.js";
import { WorkerRefusal } from "./worker-refusal.js";

afterEach(() => vi.useRealTimers());

describe("ISS-14476 launcher and source admission", () => {
  it("classifies undeclared record actions and preserves an exact contention refusal", async () => {
    const input = {
      agentName: "vibe-setup-worker",
      mode: "record",
      recordAction: "unrecognized",
      worktree: "/unused/owned-session",
      requestId: "test",
      input: "Fixture",
      capabilities: graph,
      exclusiveRecordTurn: true,
    };
    let refused: unknown;
    try {
      await runWorker(input);
    } catch (error) {
      refused = error;
    }
    const result = safeFailure(refused, input);
    expect(result.code).toBe("RECORD_ACTION_UNDECLARED");
    expect(result.summary).toMatch(/vibe-setup-worker.*Allowed actions:.*create/);
    expect(safeFailure(new WorkerRefusal("WRITER_BUSY", "the writer owns this turn")).code).toBe("WRITER_BUSY");
    expect(safeFailure(new Error("looks WRITER_BUSY but is not a structured holder")).code).toBe("WORKER_TURN_FAILED");
  });

  it("shares the outer retry deadline while leaving the first MCP init on its normal worker deadline", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    expect(armMcpInitWatchdog(null, expired)).toBeUndefined();
    vi.advanceTimersByTime(16_000);
    expect(expired).not.toHaveBeenCalled();
    const budget = remainingWorkerTurnBudget({ turnDeadline: 60_000, readinessDeadline: 65_000, now: 57_000 });
    expect(budget).toEqual({ turnTimeoutMs: 3_000, startupTimeoutMs: 3_000 });
    expect(canStartWorkerAttempt(budget)).toBe(true);
    armMcpInitWatchdog(budget.startupTimeoutMs, expired);
    vi.advanceTimersByTime(2_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledOnce();
    expect(canStartWorkerAttempt(remainingWorkerTurnBudget({ turnDeadline: 60_000, readinessDeadline: 65_000, now: 60_000 }))).toBe(false);
  });

  it("meters model time separately from each bounded tool step and rejects tests outside authorized writer modes", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const cap = createTurnCap(100, expired);
    vi.advanceTimersByTime(40);
    cap.toolStarted("one");
    vi.advanceTimersByTime(90);
    expect(expired).not.toHaveBeenCalled();
    cap.toolFinished("one");
    vi.advanceTimersByTime(59);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenLastCalledWith("model");
    cap.stop();
    const hung = createTurnCap(100, expired);
    hung.toolStarted("hung");
    vi.advanceTimersByTime(100);
    expect(expired).toHaveBeenLastCalledWith("tool");
    hung.stop();
    expect(testAuthoringGranted({ agentName: "vibe-change-worker", mode: "pull-request" })).toBe(true);
    expect(testAuthoringGranted({ agentName: "vibe-change-worker", mode: "request" })).toBe(false);
    expect(testAuthoringGranted({ agentName: "vibe-requirements-worker", mode: "pull-request" })).toBe(false);
  });

  it("admits exact mode-less source ownership and independently rejects wrong branch and invalid hosted state", () => {
    const home = fixture();
    try {
      const baseCommit = execFileSync("git", ["-C", home.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const file = join(home.metadata, "vibe-session.json");
      const record = {
        worktree: home.worktree, branch: "vibe/test", slug: "test", status: "active",
        mode: null, baseCommit, operator: { id: "operator", email: "operator@example.invalid" }, provider: PROVIDER_BINDING,
      };
      const save = (contents: object) => {
        writeFileSync(file, JSON.stringify(contents));
        chmodSync(file, 0o600);
      };
      save(record);
      expect(ownedSyncCheckout(home.worktree).session.mode).toBeNull();
      expect(syncLocation(home.worktree).session.vercel).toBeUndefined();
      save({ ...record, vercel: { verifiedAt: "2026-11-19" } });
      expect(ownedSyncCheckout(home.worktree).session.mode).toBeNull();
      expect(() => syncLocation(home.worktree)).toThrow(/exact active owned session branch and mode/);
      save({ ...record, branch: "vibe/other" });
      expect(() => ownedSyncCheckout(home.worktree)).toThrow(/exact active owned session branch/);
    } finally {
      home.cleanup();
    }
  });
});
