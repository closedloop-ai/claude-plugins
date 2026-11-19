import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("./fleet-atomic-install.sh", import.meta.url));
const RELATIVES = [
  "plugins/vibe/skills/vibe/scripts/owned-state.mjs",
  "plugins/vibe/lib/vibe/scripts/owned-state-helper.mjs",
];

function staged(root, token) {
  const stage = path.join(root, `stage-${Math.random().toString(16).slice(2)}`);
  for (const [index, relative] of RELATIVES.entries()) {
    mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
    writeFileSync(path.join(stage, relative), `${token}:${index}:${token.repeat(100_000)}\n`);
  }
  writeFileSync(path.join(stage, "files"), `${RELATIVES.join("\n")}\n`);
  return stage;
}

function install(stage, target) {
  const result = spawnSync("bash", [INSTALL, stage, target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const generation = result.stdout.trim();
  assert.equal(realpathSync(`${target}.current`), realpathSync(generation));
  return generation;
}

function pair(generation) {
  return RELATIVES.map((relative) => readFileSync(path.join(generation, relative), "utf8").slice(0, 3));
}

test("atomic fleet install publishes one pinned multi-file generation and skips identical trees", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-atomic-install-"));
  try {
    const target = path.join(root, "target");
    const firstGeneration = install(staged(root, "A"), target);
    const before = RELATIVES.map((relative) => statSync(path.join(firstGeneration, relative)));

    const sameGeneration = install(staged(root, "A"), target);
    assert.equal(sameGeneration, firstGeneration, "an identical shipment keeps the same generation pointer");
    const after = RELATIVES.map((relative) => statSync(path.join(sameGeneration, relative)));
    assert.deepEqual(after.map(({ ino, mtimeMs }) => [ino, mtimeMs]), before.map(({ ino, mtimeMs }) => [ino, mtimeMs]));

    const pinnedReaders = [];
    for (const token of ["B", "C", "D", "E"]) {
      const pinned = realpathSync(`${target}.current`);
      const nextGeneration = install(staged(root, token), target);
      pinnedReaders.push(pair(pinned));
      assert.deepEqual(pair(nextGeneration), [`${token}:0`, `${token}:1`]);
    }
    assert.deepEqual(pinnedReaders, [["A:0", "A:1"], ["B:0", "B:1"], ["C:0", "C:1"], ["D:0", "D:1"]],
      "a reader pinned before each switch sees one complete old generation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an incomplete staged generation cannot replace the current pointer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-atomic-install-incomplete-"));
  try {
    const target = path.join(root, "target");
    const generation = install(staged(root, "A"), target);
    const pointer = readlinkSync(`${target}.current`);
    const incomplete = staged(root, "B");
    rmSync(path.join(incomplete, RELATIVES[1]));
    const result = spawnSync("bash", [INSTALL, incomplete, target], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /staged file is missing/);
    assert.equal(readlinkSync(`${target}.current`), pointer);
    assert.deepEqual(pair(generation), ["A:0", "A:1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("simultaneous remote shipments never fail with File exists or publish a mixed tree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-atomic-install-concurrent-"));
  try {
    const target = path.join(root, "target");
    install(staged(root, "A"), target);
    const run = (token) => new Promise((resolve) => {
      const child = spawn("bash", [INSTALL, staged(root, token), target]);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => resolve({ code, stderr }));
    });
    const results = await Promise.all([run("B"), run("C")]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0]);
    assert.ok(results.every(({ stderr }) => !/File exists/i.test(stderr)), JSON.stringify(results));
    const current = pair(realpathSync(`${target}.current`));
    assert.ok(JSON.stringify(current) === JSON.stringify(["B:0", "B:1"])
      || JSON.stringify(current) === JSON.stringify(["C:0", "C:1"]), `complete generation: ${current}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted lock waiter leaves no ownerless ship lock", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-atomic-install-lock-"));
  let holder;
  try {
    const target = path.join(root, "target");
    const initial = install(staged(root, "A"), target);
    const lock = `${target}.ship-lock`;
    const hasFlock = spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;
    holder = hasFlock
      ? spawn("flock", ["-x", lock, "sleep", "30"], { detached: true })
      : spawn("lockf", ["-k", "-t", "0", lock, "sleep", "30"], { detached: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const child = spawn("bash", [INSTALL, staged(root, "B"), target]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "the live owner's lock keeps the waiter queued");
    assert.deepEqual(pair(initial), ["A:0", "A:1"]);
    assert.equal(realpathSync(`${target}.current`), realpathSync(initial));
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    assert.ok(holder.pid > 1, "only the test-owned lock process group is signalled");
    process.kill(-holder.pid, "SIGTERM");
    await new Promise((resolve) => holder.once("close", resolve));
    install(staged(root, "C"), target);
  } finally {
    if (holder?.pid > 1 && holder.exitCode === null) {
      try { process.kill(-holder.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
