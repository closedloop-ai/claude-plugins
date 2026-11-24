import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordCloudCheck, recordCloudSlotRefusal } from "../../../lib/fleet-orchestrator/scripts/cloud-slot-routing.mjs";
import { recordUsageReading } from "../../codex-fleet-monitor/scripts/usage-state.mjs";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { classify } from "../../vibe/scripts/vibe-triage.mjs";
import { Runtime } from "./dispatch-route.mjs";
import { runtimeMixLine } from "./fleet-capacity.mjs";

const NOW = Date.parse("2026-11-19T21:25:00Z");
const AT = new Date(NOW).toISOString();
const CLAUDE = { first: { runtime: "claude", status: "building" }, second: { runtime: "claude" } };
const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const READING = { runtime: "codex", machine: "laptop2", source: "app-server", status: "ok", readAt: AT };

test("prevention runtime mix signals only a live all-Claude fleet with proven Codex room", () => {
  const signal = (writers, bands, moveAt = 80) => runtimeMixLine(writers, bands.map((line) =>
    typeof line === "string" ? { ...READING, line: `codex-usage laptop2 ${line} resets=0` } : { ...READING, ...line }),
  { now: NOW, staleSeconds: 600, moveAt });
  assert.match(signal(CLAUDE, ["under80% ok"]), /^RUNTIME-MIX all 2 live writers are Claude/);
  assert.match(signal({ ...CLAUDE, done: { runtime: "codex", status: "DONE" }, retired: { runtime: "codex", retiredAt: AT } },
    ["under80% ok"]), /^RUNTIME-MIX/);
  assert.match(signal(CLAUDE, ["HIGH(50%) ok"], 60), /^RUNTIME-MIX/);
  assert.equal(signal(CLAUDE, ["HIGH(80%) ok"]), null, "the equal threshold cannot claim spare room");
  assert.equal(signal(CLAUDE, ["HIGH(90%) ok"]), null);
  assert.equal(signal(CLAUDE, ["under80% ok"], 65), null, "an imprecise band alone cannot prove a narrower threshold");
  assert.equal(signal(CLAUDE, ["?% unknown", "under80% LIMIT"]), null);
  assert.equal(signal(CLAUDE, [{ line: "codex-usage laptop2 under80% ok resets=0", status: "readfail" }]), null);
  assert.equal(signal(CLAUDE, [{ line: "codex-usage laptop2 under80% ok resets=0", readAt: "2026-11-19T20:00:00Z" }]), null);
  assert.equal(signal({ ...CLAUDE, active: { runtime: "codex" } }, ["under80% ok"]), null);
  assert.equal(signal({ old: { runtime: "claude", status: "DONE" } }, ["under80% ok"]), null);
  assert.equal(signal({}, ["under80% ok"]), null);
});

test("prevention watch-lines and status share fresh load refusal and cloud-check signals", (t) => {
  const fixture = makeHome("vibe-capacity-signals-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "repo");
  mkdirSync(worktree);
  const writer = { ...CLAUDE.first, worktree, head: "a".repeat(40), tickets: [] };
  writeFileSync(path.join(fixture.root, "board.json"), JSON.stringify({ writers: { first: writer } }));
  writeFileSync(path.join(fixture.root, "config.env"), "MOVE_AT_PERCENT=80\nUSAGE_STALE_SECONDS=600\n");
  recordUsageReading(fixture.root, { ...READING, line: "codex-usage laptop2 under80% ok resets=0" });
  const flags = (action) => spawnSync(process.execPath, [BOARD, fixture.root, action, "--now", AT], { encoding: "utf8" }).stdout;
  const refused = (status) => recordCloudSlotRefusal({ orchDir: fixture.root, owner: "first", worktree, where: "remote",
    status, at: NOW, cloudCommand: "/fixture/cloud-worker.mjs", argv: ["node", "--test", "selected.test.mjs"] });
  recordCloudCheck(fixture.root, { ok: true }, NOW);
  refused(78);
  assert.doesNotMatch(flags("status"), /CLOUD-IDLE/, "host unavailability alone is not a load refusal");
  refused(4);
  for (const action of ["status", "watch-lines"]) {
    assert.match(flags(action), /RUNTIME-MIX all 1 live writers are Claude/);
    assert.match(flags(action), /CLOUD-IDLE first aaaaaaaaaaaa: heavy slots refused load/);
  }
  assert.match(flags("status"), /CLOUD-VALIDATE-MISSING first aaaaaaaaaaaa/);
  recordCloudCheck(fixture.root, { ok: false }, NOW);
  assert.doesNotMatch(flags("watch-lines"), /CLOUD-IDLE/, "a failed check replaces a previously good one");
  recordCloudCheck(fixture.root, { ok: true }, NOW - 601_000);
  assert.doesNotMatch(flags("watch-lines"), /CLOUD-IDLE/, "a stale passing setup does not route work");
  assert.match(flags("status"), /CLOUD-VALIDATE-MISSING/, "the missing receipt remains visible without a fresh check");
});


test("prevention the routing CLI defaults on and honors explicit opt-out", (t) => {
  const fixture = makeHome("vibe-route-default-");
  t.after(fixture.cleanup);
  const file = path.join(fixture.root, "triage.json");
  const paths = ["apps/app/pricing.tsx"];
  writeFileSync(file, JSON.stringify(classify({
    request: "fix the copy on the pricing page", paths, pathSources: paths.map((name) => ({ path: name, source: "brief" })),
  })));
  const script = fileURLToPath(new URL("./dispatch-route.mjs", import.meta.url));
  const run = (switchValue) => JSON.parse(spawnSync(process.execPath, [script, "--manifest", file], {
    encoding: "utf8", env: { ...process.env, FLEET_CLASS_ROUTING: switchValue },
  }).stdout);
  const defaults = run("");
  assert.deepEqual([defaults.routed, defaults.runtime], [true, Runtime.Codex]);
  assert.equal(run("0").routed, false);
});
