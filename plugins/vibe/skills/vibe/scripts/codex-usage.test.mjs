import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkUsage, decideUsage, STOP_EXIT, UsageStatus } from "./codex-usage.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-usage.mjs");
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "vibe-codex-usage-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

// Reset at 2026-10-26T19:23:23Z, the shape a real exhausted weekly window reports.
const WEEKLY_RESET = 1_793_042_603;
const reachedLimits = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    rateLimitReachedType: "rate_limit_reached",
    primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: WEEKLY_RESET },
    secondary: null,
    credits: { hasCredits: true, unlimited: false },
  },
};
const openLimits = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    rateLimitReachedType: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_793_000_000 },
    secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: WEEKLY_RESET },
  },
};

/** A fake Codex CLI whose `app-server` answers initialize, then the rate-limit read with `answer`, logging every request. */
function fakeCodex(name, answer) {
  const file = path.join(fixtureRoot, name);
  const log = `${file}.log`;
  writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "app-server") process.exit(9);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + "\\n");
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    if (message.method === "account/rateLimits/read") process.stdout.write(JSON.stringify({ id: message.id, ...${JSON.stringify(answer)} }) + "\\n");
  }
});
`);
  chmodSync(file, 0o755);
  return { file, log };
}

function run(codex, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, "check", "--codex", codex, "--timeout-ms", "15000", ...extra], { encoding: "utf8" });
}

test("a reached limit stops the session with exit 3 and reports when it resets", () => {
  const { file, log } = fakeCodex("reached", { result: reachedLimits });
  const result = run(file);
  assert.equal(result.status, STOP_EXIT, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "stop",
    state: "LIMIT-SPENDING-CREDITS",
    rateLimitReachedType: "rate_limit_reached",
    resetsAt: "2026-10-26T19:23:23.000Z",
    primary: { usedPercent: 100, resetsAt: "2026-10-26T19:23:23.000Z", windowDurationMins: 10_080 },
    secondary: null,
    ordinaryUsageAllowed: false,
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.deepEqual(requests[2].params, { excludeResetCreditDetails: true });
});

test("a reached limit continues only when the person allowed credits", () => {
  const { file } = fakeCodex("reached-credits", { result: reachedLimits });
  const result = run(file, ["--allow-credits"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "credits_allowed");
});

test("a limit not yet reached continues, whatever the percentages say", () => {
  const { file } = fakeCodex("open", { result: openLimits });
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.status, "ok");
  assert.equal(decision.rateLimitReachedType, null);
  assert.equal(decision.resetsAt, "2026-10-26T07:33:20.000Z");
  assert.equal(decision.secondary.usedPercent, 71);
});

test("a reached limit with no credits left stops even when credits were allowed", () => {
  const noCredits = { ...reachedLimits, rateLimits: { ...reachedLimits.rateLimits, credits: { hasCredits: false, unlimited: false } } };
  const { file } = fakeCodex("reached-no-credits", { result: noCredits });
  const result = run(file, ["--allow-credits"]);
  assert.equal(result.status, STOP_EXIT, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.status, "stop");
  assert.equal(decision.state, "LIMIT-STOPPED");
});

test("a reached limit continues while ordinary usage is still allowed", () => {
  const { file } = fakeCodex("reached-ordinary", { result: { ...reachedLimits, ordinaryUsageAllowed: true } });
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.status, "ok");
  assert.equal(decision.state, "LIMIT");
  assert.equal(decision.rateLimitReachedType, "rate_limit_reached");
});

test("an unreadable answer is unknown, never a guessed ok or stop", async () => {
  const { file } = fakeCodex("error", { error: { code: -32_000, message: "not signed in" } });
  assert.deepEqual(await checkUsage({ codex: file, timeoutMs: 15_000 }), {
    status: UsageStatus.Unknown, reason: "account/rateLimits/read failed: not signed in",
  });
  const missing = await checkUsage({ codex: path.join(fixtureRoot, "no-such-codex"), timeoutMs: 15_000 });
  assert.equal(missing.status, UsageStatus.Unknown);
  assert.match(missing.reason, /ENOENT/);
  assert.deepEqual(decideUsage({}), { status: UsageStatus.Unknown, reason: "The App Server returned no rate limits." });
});

test("every reached type stops, including depleted workspace credits", () => {
  for (const type of ["workspace_owner_credits_depleted", "workspace_member_usage_limit_reached"]) {
    const decision = decideUsage({ rateLimits: { rateLimitReachedType: type, primary: null, secondary: null } });
    assert.equal(decision.status, UsageStatus.Stop, type);
    assert.equal(decision.resetsAt, null);
  }
});

test("a missing subcommand is refused with usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
});
