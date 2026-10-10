import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncFixture } from "./main-sync-test-fixtures.js";
import { bundleDirectory, graph, recordWrite } from "./test-fixtures.js";
import { storedRecipe, validationEnvelopeMs } from "./main-sync-validation-recipe.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup() { const value = syncFixture(); fixtures.push(value); return value; }
function launch(value: ReturnType<typeof syncFixture>, input: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], {
    cwd: value.worktree, input: JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot,
      agentName: "vibe-change-worker", capabilities: [...graph, recordWrite], mode: "record", recordAction: "progress",
      exclusiveRecordTurn: true, publicationPurpose: "build", ...input }), encoding: "utf8", timeout: 20000,
    env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` },
  });
  if (result.error) throw result.error;
  return { ...result, json: JSON.parse(result.stdout) };
}

function prepared(value: ReturnType<typeof syncFixture>) {
  expect(launch(value, { requestId: "source-inputs", input: "MAIN_SYNC_INPUTS" }).status).toBe(0);
  const first = launch(value, { agentName: "vibe-environment-worker", recordAction: "redeploy", requestId: "publisher-prepare", input: "MAIN_SYNC_PREPARE" });
  expect(first.status, first.stdout).toBe(0);
  const transactionId = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).transactionId;
  const ready = launch(value, { requestId: "post-merge-inputs", input: "MAIN_SYNC_INPUTS", mainSyncTransactionId: transactionId });
  expect(ready.status, ready.stdout).toBe(0);
  return { transactionId, witness: ready.json.data.mainSyncResult.mainSync.validationWitness };
}

describe("production derived Claude validation envelope", () => {
  it("derives only an authenticated existing source recipe and resumes the same registered writer", () => {
    const value = setup();
    const { transactionId, witness } = prepared(value);
    const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(state.previous.recipe.recovery).toEqual({ owners: [], timeoutMs: 0 });
    const result = launch(value, { requestId: "canonical-validation", input: "MAIN_SYNC_VALIDATE",
      mainSyncTransactionId: transactionId, mainSyncValidation: witness });
    expect(result.status, result.stdout).toBe(0);
    expect(result.json.data.mainSyncResult.mainSync.publicationReady).toBe(true);
    const proof = readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(proof.at(-1).args).toContain("--resume");
    expect(proof.at(-1).payload.operationContext.mainSyncValidation.recipeSha256).toBe(witness.recipeSha256);
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
  }, 60000);

  it.each(["missing", "digest", "stored-budget", "stored-recovery", "recovery-owner", "wrong-role", "caller-timeout"] as const)(
    "rejects %s validation authority before spawning Claude", (failure) => {
    const value = setup();
    const { transactionId, witness } = prepared(value);
    const before = readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8");
    const input: Record<string, unknown> = { requestId: `denied-${failure}`, input: "MAIN_SYNC_VALIDATE", mainSyncTransactionId: transactionId,
      mainSyncValidation: witness };
    if (failure === "missing") {
      const file = join(value.metadata, "vibe-main-sync.json"); const state = JSON.parse(readFileSync(file, "utf8")); delete state.previous.recipe; writeFileSync(file, JSON.stringify(state));
    }
    if (failure === "digest") input.mainSyncValidation = { ...witness, recipeSha256: "0".repeat(64) };
    if (failure === "stored-budget") {
      const file = join(value.metadata, "vibe-main-sync.json"); const state = JSON.parse(readFileSync(file, "utf8")); state.previous.recipe.commands[0].timeoutMs += 1000; writeFileSync(file, JSON.stringify(state));
    }
    if (failure === "stored-recovery" || failure === "recovery-owner") {
      const file = join(value.metadata, "vibe-main-sync.json"); const state = JSON.parse(readFileSync(file, "utf8"));
      state.previous.recipe.recovery = failure === "stored-recovery"
        ? { owners: [], timeoutMs: 1000 } : { owners: ["fumadocs"], timeoutMs: 4500000 };
      writeFileSync(file, JSON.stringify(state));
    }
    if (failure === "wrong-role") input.agentName = "vibe-environment-worker";
    if (failure === "caller-timeout") input.timeoutMs = 1800000;
    const result = launch(value, input);
    expect(result.status, result.stdout).toBe(1);
    expect(readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
  }, 60000);

  it("adds only the canonical finite owner reserve and rejects inflated lifecycle arithmetic", () => {
    const recipe = storedRecipe({ headSha: "1".repeat(40), treeSha: "2".repeat(40), inputSha256: "3".repeat(64) },
      { commands: [{ argv: ["pnpm", "check:source-gates"], timeoutMs: 1000 }], e2eLimitations: [],
        recovery: { owners: ["fumadocs"], timeoutMs: 4500000 } });
    expect(validationEnvelopeMs(recipe)).toBe(15 * 60 * 1000 + 120000 + 2000 + 1000 + 4500000);
    expect(() => validationEnvelopeMs({ ...recipe, recovery: { ...recipe.recovery!, timeoutMs: 4501000 } })).toThrow(/reserve/);
  });

  it.each(["source", "recipe"] as const)("rejects %s drift after the owned Claude child starts but before any required check", (failure) => {
    const value = setup();
    const { transactionId, witness } = prepared(value);
    const before = value.calls();
    const claude = join(value.bin, "claude");
    const mutation = failure === "source"
      ? "fs.writeFileSync(path.join(process.cwd(),'apps/app/probe.ts'),'changed after owned launch\\n');"
      : "const file=path.join(process.cwd(),'.git','vibe-main-sync.json');const state=JSON.parse(fs.readFileSync(file,'utf8'));state.previous.recipe.commands[0].timeoutMs+=1000;fs.writeFileSync(file,JSON.stringify(state));";
    writeFileSync(claude, readFileSync(claude, "utf8").replace("let mainSyncResult;", `if(payload.input==='MAIN_SYNC_VALIDATE'){${mutation}}\nlet mainSyncResult;`));
    const result = launch(value, { requestId: `postlaunch-${failure}`, input: "MAIN_SYNC_VALIDATE",
      mainSyncTransactionId: transactionId, mainSyncValidation: witness });
    expect(result.status, result.stdout).toBe(1);
    expect(result.json.data.mainSyncResult.status).toBe("NEEDS_CHANGE");
    expect(result.json.data.mainSyncResult.error).toMatch(failure === "source" ? /committed validation inputs/i : /recipe\/witness identity/);
    expect(value.calls()).toBe(before);
    const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(state.previous.validation).toBeUndefined();
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
    const proof = readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(proof.at(-1).args).toContain("--resume");
  }, 60000);

  it("cancels during actual private-data derivation before Claude spawn and releases only the stopped owned turn", async () => {
    const value = setup();
    const { transactionId, witness } = prepared(value);
    const before = readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8");
    const preload = join(value.base, "cancel-derivation-fixture.mjs");
    const marker = join(value.metadata, "derivation-awaiting");
    // Test-only Node preload holds the real async read; the production CLI has no delay/override seam.
    writeFileSync(preload, `import fsp from 'node:fs/promises';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const actual=fsp.open;
fsp.open=async function(file,...args) {if(file===${JSON.stringify(join(value.metadata, "vibe-main-sync.json"))}) {
 writeFileSync(${JSON.stringify(marker)},'actual derivation reached');const keepalive=setInterval(()=>{},1000);
 await new Promise(resolve=>process.once('SIGTERM',()=>{clearInterval(keepalive);resolve();}));
} return actual.call(this,file,...args);};syncBuiltinESMExports();\n`);
    const watcher = watch(value.metadata);
    const child = spawn(process.execPath, ["--import", preload, join(bundleDirectory, "claude-worker.mjs")], {
      cwd: value.worktree, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` },
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    let canceled = false;
    watcher.on("change", () => { if (!canceled && existsSync(marker)) { canceled = true; child.kill("SIGTERM"); } });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot, agentName: "vibe-change-worker",
      capabilities: [...graph, recordWrite], mode: "record", recordAction: "progress", exclusiveRecordTurn: true,
      publicationPurpose: "build", requestId: "cancel-derivation", input: "MAIN_SYNC_VALIDATE",
      mainSyncTransactionId: transactionId, mainSyncValidation: witness }));
    try {
      const exit = await closed;
      expect(exit, output).toBe(1);
      expect(output).toContain("TURN_CANCELED");
      expect(readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8")).toBe(before);
      expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
      const ledger = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
      expect(ledger.active?.lease).toBeUndefined();
    } finally { watcher.close(); if (child.exitCode === null) child.kill("SIGKILL"); }
  }, 60000);
});
