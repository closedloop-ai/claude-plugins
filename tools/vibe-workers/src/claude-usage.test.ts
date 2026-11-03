import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mustStopForUsage, rateLimitFromEvent } from "./claude-usage.js";
import { bundleDirectory, fixture, graph, readProof } from "./test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function launch(input: Record<string, unknown>) {
  const value = fixture();
  fixtures.push(value);
  const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], {
    input: JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot, agentName: "vibe-change-worker",
      capabilities: graph, mode: "request", requestId: "first", ...input }),
    encoding: "utf8", env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` }, timeout: 15000,
  });
  return { value, status: result.status, json: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
}

describe("Claude usage awareness", () => {
  it("reads Claude's stream rate-limit event and ignores every other event", () => {
    expect(rateLimitFromEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1793044800,
      rateLimitType: "seven_day", isUsingOverage: false, overageStatus: "rejected" } }))
      .toEqual({ status: "allowed", rateLimitType: "seven_day", resetsAt: "2026-10-26T20:00:00.000Z", isUsingOverage: false });
    expect(rateLimitFromEvent({ type: "result", rate_limit_info: { status: "rejected" } })).toBeUndefined();
    expect(rateLimitFromEvent({ type: "rate_limit_event" })).toBeUndefined();
  });
  it("stops on a reached limit or paid overage unless the person allowed credits", () => {
    expect(mustStopForUsage({ status: "rejected" }, false)).toBe(true);
    expect(mustStopForUsage({ status: "allowed_warning", isUsingOverage: true }, false)).toBe(true);
    expect(mustStopForUsage({ status: "allowed_warning", isUsingOverage: false }, false)).toBe(false);
    expect(mustStopForUsage({ status: "rejected" }, true)).toBe(false);
    expect(mustStopForUsage(undefined, false)).toBe(false);
  });
  it("returns the last observed rate limit with a completed turn", () => {
    const result = launch({ input: "USAGE_ALLOWED" });
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    expect(result.json.rateLimit).toEqual({ status: "allowed", rateLimitType: "seven_day",
      resetsAt: "2026-10-26T20:00:00.000Z", isUsingOverage: false });
  }, 20000);
  it("stops a turn that started paid overage and keeps the request for the same writer", () => {
    const result = launch({ input: "USAGE_OVERAGE" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("USAGE_LIMIT_REACHED");
    expect(result.json.leaseRetained).toBe(false);
    for (const proof of readProof(result.value.metadata)) expect(() => process.kill(proof.pid, 0)).toThrow();
  }, 20000);
  it("stops a turn whose limit is reached", () => {
    const result = launch({ input: "USAGE_REJECTED" });
    expect(result.status).toBe(1);
    expect(result.json.code).toBe("USAGE_LIMIT_REACHED");
  }, 20000);
  it("lets an overage turn finish when the person explicitly allowed credits", () => {
    const result = launch({ input: "USAGE_OVERAGE", allowCredits: true });
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    expect(result.json.status).toBe("DONE");
    expect(result.json.rateLimit).toMatchObject({ isUsingOverage: true });
  }, 20000);
});
