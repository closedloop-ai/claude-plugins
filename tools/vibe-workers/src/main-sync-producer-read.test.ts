import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { readProducerMetadata, fallbackProducerMetadata, type FirstProducerHead } from "./main-sync-producer-read.js";
import { committedInputs, inspectInputInventory } from "./main-sync-checks.js";
import * as catalog from "./main-sync-input-catalog.js";
import { prepareMainSyncInputs } from "./main-sync.js";
import { buildInfoInputFixture, fumadocsInputFixture } from "./main-sync-input-test-fixtures.js";
import { syncFixture } from "./main-sync-test-fixtures.js";
import { MainSyncError } from "./main-sync-contracts.js";

const control = vi.hoisted(() => ({ calls: [] as string[][],
  reply: undefined as undefined | ((root: string, args: string[]) => string | undefined) }));
vi.mock("../../../plugins/vibe/skills/vibe/scripts/session-record.mjs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../plugins/vibe/skills/vibe/scripts/session-record.mjs")>();
  return { ...actual, git: (root: string, args: string[], options?: { timeout?: number }) => {
    control.calls.push([...args]);
    const reply = control.reply?.(root, args);
    return reply === undefined ? actual.git(root, args, options) : reply;
  } };
});

const fixtures: ReturnType<typeof syncFixture>[] = [];
const restorers: (() => void)[] = [];
const expectedA = "a".repeat(40);
const observedB = "b".repeat(40);
const pair = ["rev-parse", "HEAD", "--absolute-git-dir"];
afterEach(() => {
  control.reply = undefined; control.calls.length = 0; vi.restoreAllMocks();
  for (const restore of restorers.splice(0)) restore();
  for (const value of fixtures.splice(0)) value.cleanup();
});

describe("same-assessment producer metadata completion", () => {
  it.each(["complete", "ambiguous", "partial-native-failure"] as const)("keeps proved B sticky with %s metadata even when reread would return A", kind => {
    install((_, args) => {
      if (same(args, pair)) {
        if (kind === "partial-native-failure") throw nativeFailure(`${observedB}\n`);
        return `${observedB}\n${kind === "complete" ? "/owned/admin" : "not-an-absolute-directory"}`;
      }
      if (same(args, ["rev-parse", "HEAD"])) return expectedA;
      if (same(args, ["rev-parse", "--absolute-git-dir"])) return "/owned/admin";
      throw new Error("Unexpected native call");
    });
    expect(() => readProducerMetadata("/owned/root", expectedA)).toThrow("Producer input HEAD changed during inspection");
    expect(control.calls).toEqual([pair]);
  }, 30000);

  it.each(["malformed", "generic-sha-error", "unborn"] as const)("uses original HEAD-first fallback only for %s unproved native identity", kind => {
    install((_, args) => {
      if (same(args, pair)) {
        if (kind === "generic-sha-error") throw Object.assign(new Error("Unrelated failure"), { stdout: `${observedB}\n` });
        if (kind === "unborn") throw nativeFailure("HEAD\n");
        return "unproven\n/owned/admin";
      }
      if (same(args, ["rev-parse", "HEAD"])) return expectedA;
      return "/owned/admin";
    });
    expect(readProducerMetadata("/owned/root", expectedA)).toBe("/owned/admin");
    expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"], ["rev-parse", "--absolute-git-dir"]]);
  }, 30000);

  it.each(["empty-metadata", "native-metadata-error"] as const)("matching first HEAD does not skip the fresh fallback check for %s", kind => {
    install((_, args) => {
      if (same(args, pair)) {
        if (kind === "native-metadata-error") throw nativeFailure(`${expectedA}\n`);
        return expectedA;
      }
      if (same(args, ["rev-parse", "HEAD"])) return observedB;
      throw new Error("Metadata must not run");
    });
    expect(() => readProducerMetadata("/owned/root", expectedA)).toThrow("Producer input HEAD changed during inspection");
    expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"]]);
  }, 30000);

  it.each(["head-error", "metadata-error"] as const)("propagates the original %s with matching/unproved priority", kind => {
    const failure = new Error(kind);
    install((_, args) => {
      if (same(args, pair)) return "unproved";
      if (same(args, ["rev-parse", "HEAD"])) {
        if (kind === "head-error") throw failure;
        return expectedA;
      }
      throw failure;
    });
    expect(() => readProducerMetadata("/owned/root", expectedA)).toThrow(failure);
    expect(control.calls).toHaveLength(kind === "head-error" ? 2 : 3);
  }, 30000);

  it("retains actual native output and private fallback types", () => {
    const value = setup();
    const head = git(value.worktree, ["rev-parse", "HEAD"]);
    const metadata = git(value.worktree, ["rev-parse", "--absolute-git-dir"]);
    control.calls.length = 0;
    expect(readProducerMetadata(value.worktree, head)).toBe(metadata);
    expect(control.calls).toEqual([pair]);
    void compilerNegative;
  }, 30000);

  it("keeps no-producer and public standalone inventory completions head-only", () => {
    const value = setup();
    const expected = inspectInputInventory(value.worktree);
    control.calls.length = 0;
    expect(committedInputs(value.worktree)).toEqual({ headSha: expected.headSha, treeSha: expected.treeSha, inputSha256: expected.inputSha256 });
    expect(control.calls.at(-1)).toEqual(["rev-parse", "HEAD"]);
    expect(control.calls.some(args => same(args, pair) || same(args, ["rev-parse", "--absolute-git-dir"]))).toBe(false);
    buildInfoInputFixture(value);
    control.calls.length = 0;
    const inventory = inspectInputInventory(value.worktree);
    expect(inventory.producers).toHaveLength(1);
    expect(control.calls.at(-1)).toEqual(["rev-parse", "HEAD"]);
    expect(control.calls.some(args => same(args, pair))).toBe(false);
  }, 30000);

  it.each(["overlay", "noncanonical"] as const)("preserves shared producer %s refusal before any completion read", kind => {
    const value = setup();
    const generated = buildInfoInputFixture(value);
    const producer = catalog.presentProducers(value.worktree)[0]!;
    const head = git(value.worktree, ["rev-parse", "HEAD"]);
    let overlays: string[] = [];
    if (kind === "overlay") overlays = [producer.inputs[0]! + "/untracked.ts"];
    else {
      const target = join(value.worktree, producer.inputs[0]!);
      const saved = target + ".fixture-original";
      const body = readFileSync(target); writeFileSync(saved, body); rmSync(target); symlinkSync(saved, target);
    }
    control.calls.length = 0;
    expect(() => catalog.verifyProducerInputsForOrigin(value.worktree, head, [producer], overlays)).toThrow(MainSyncError);
    expect(control.calls).toEqual([]);
    expect(existsSync(join(value.worktree, generated.output))).toBe(true);
  }, 30000);

  it("pairs at the generated-origin caller, preserving canonical proof byte/log mutation guards", () => {
    const value = setup();
    const generated = buildInfoInputFixture(value);
    withPath(value);
    const source = value.sourceTurn();
    try { prepareMainSyncInputs({ context: source.context }); }
    finally { source.finish(); }
    const before = committedInputs(value.worktree);
    control.calls.length = 0;
    expect(committedInputs(value.worktree)).toEqual(before);
    expect(control.calls.filter(args => same(args, pair))).toHaveLength(1);
    expect(control.calls.filter(args => same(args, ["rev-parse", "HEAD"]))).toHaveLength(0);
    value.write(generated.output, generated.body + "\n");
    expect(() => committedInputs(value.worktree)).toThrow("Generated dependency bytes");
    value.write(generated.output, generated.body);
    const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    writeFileSync(state.inputs.producers[0].log, "changed execution receipt\n");
    expect(() => committedInputs(value.worktree)).toThrow("Actual generated-origin execution evidence changed");
  }, 30000);

  it("preserves all three actual origin-preparation standalone verifier sites and public inventory shape", () => {
    const value = setup();
    fumadocsInputFixture(value); withPath(value);
    const standalone = vi.spyOn(catalog, "verifyProducerInputs");
    const paired = vi.spyOn(catalog, "verifyProducerInputsForOrigin");
    const source = value.sourceTurn();
    try { prepareMainSyncInputs({ context: source.context }); }
    finally { source.finish(); }
    expect(standalone).toHaveBeenCalledTimes(4);
    expect(paired).not.toHaveBeenCalled();
    const current = inspectInputInventory(value.worktree);
    expect(Object.keys(current).sort()).toEqual(["headSha", "inputSha256", "producers", "treeSha"]);
    expect(paired).not.toHaveBeenCalled();
    expect(committedInputs(value.worktree).headSha).toBe(current.headSha);
    value.write("node_modules/fumadocs-mdx/index.js", "module.exports = { poisoned: true };\n");
    expect(() => committedInputs(value.worktree)).toThrow("Selected canonical package ref, complete bytes or modes changed");
  }, 30000);

  it("refuses native HEAD drift introduced at the same final completion before origin lookup", () => {
    const value = setup(); buildInfoInputFixture(value);
    const before = git(value.worktree, ["rev-parse", "HEAD"]);
    install((root, args) => {
      if (!same(args, pair)) return undefined;
      value.git(["commit", "--allow-empty", "-m", "Owned completion drift"]);
      return value.git(["rev-parse", "HEAD"]) + "\n" + value.metadata;
    });
    expect(() => committedInputs(value.worktree)).toThrow("Producer input HEAD changed during inspection");
    control.reply = undefined;
    expect(git(value.worktree, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
  }, 30000);

  it("refuses faithful no-cmd first B at the generated-origin caller before later A or proof lookup", () => {
    const value = setup(); buildInfoInputFixture(value);
    const expected = git(value.worktree, ["rev-parse", "HEAD"]);
    control.calls.length = 0;
    install((_, args) => {
      if (same(args, pair)) throw nativeFailure(`${observedB}\n`);
      if (same(args, ["rev-parse", "HEAD"])) return expected;
      return undefined;
    });
    expect(() => committedInputs(value.worktree)).toThrow("Producer input HEAD changed during inspection");
    expect(control.calls.filter(args => same(args, pair))).toEqual([pair]);
    expect(control.calls.some(args => same(args, ["rev-parse", "HEAD"]) || same(args, ["rev-parse", "--absolute-git-dir"]))).toBe(false);
    expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
  }, 30000);

  it.each(["signalled", "spawn-error", "spawn-error-signal"])("keeps first B sticky through faithful %s nullable status", kind => {
    install((_, args) => {
      if (!same(args, pair)) return expectedA;
      const failure = nativeFailure(`${observedB}\n`);
      if (kind === "signalled") throw Object.assign(failure, { status: null, signal: "SIGTERM" });
      throw Object.assign(failure, { message: "spawnSync git ETIMEDOUT", status: null,
        signal: kind === "spawn-error-signal" ? "SIGTERM" : null, code: "ETIMEDOUT",
        syscall: "spawnSync git", path: "git", spawnargs: [...pair] });
    });
    expect(() => readProducerMetadata("/owned/root", expectedA)).toThrow("Producer input HEAD changed during inspection");
    expect(control.calls).toEqual([pair]);
  }, 30000);

  it.each(["wrong-command", "wrong-spawn", "incoherent", "plain", "raw"])("keeps %s failure unproved with original HEAD-first priority", kind => {
    install((_, args) => {
      if (!same(args, pair)) return same(args, ["rev-parse", "HEAD"]) ? expectedA : "/owned/admin";
      const failure = nativeFailure(`${observedB}\n`);
      if (kind === "wrong-command") throw Object.assign(failure, { message: "Command failed: git rev-parse origin/main\n" });
      if (kind === "wrong-spawn") throw Object.assign(failure, { message: "spawnSync other ETIMEDOUT", status: null,
        code: "ETIMEDOUT", syscall: "spawnSync other", path: "other", spawnargs: [...pair] });
      if (kind === "incoherent") throw Object.assign(failure, { output: [null, expectedA, failure.stderr] });
      if (kind === "plain") throw { ...failure };
      throw failure.stdout;
    });
    expect(readProducerMetadata("/owned/root", expectedA)).toBe("/owned/admin");
    expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"], ["rev-parse", "--absolute-git-dir"]]);
  }, 30000);

  it.each([
    [false, "contradictory"], [true, "contradictory"],
    [false, "zero"], [true, "zero"],
    [false, "zero-signal"], [true, "zero-signal"],
    [false, "exit"], [true, "exit"],
    [false, "signal"], [true, "signal"],
  ] as const)("preserves fixed-owner code=%s termination=%s decision (source-shaped double)", (code, termination) => {
    install((_, args) => {
      if (!same(args, pair)) return same(args, ["rev-parse", "HEAD"]) ? expectedA : "/owned/admin";
      const failure = nativeFailure(`${observedB}\n`);
      if (termination === "contradictory") Object.assign(failure, { signal: "SIGTERM" });
      if (termination === "zero") Object.assign(failure, { status: 0 });
      if (termination === "zero-signal") Object.assign(failure, { status: 0, signal: "SIGTERM" });
      if (termination === "signal") Object.assign(failure, { status: null, signal: "SIGTERM" });
      if (code) Object.assign(failure, { code: "ETIMEDOUT", syscall: "spawnSync git", path: "git",
        spawnargs: [...pair], message: "spawnSync git ETIMEDOUT" });
      throw failure;
    });
    if (termination === "contradictory" || termination === "zero-signal" || (termination === "zero" && !code)) {
      expect(readProducerMetadata("/owned/root", expectedA)).toBe("/owned/admin");
      expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"], ["rev-parse", "--absolute-git-dir"]]);
    } else {
      expect(() => readProducerMetadata("/owned/root", expectedA)).toThrow("Producer input HEAD changed during inspection");
      expect(control.calls).toEqual([pair]);
    }
  }, 30000);

  it("uses original HEAD-first fallback for complete no-code null/null unproved identity", () => {
    const failure = Object.assign(nativeFailure(`${observedB}\n`), { status: null, signal: null });
    for (const field of ["code", "syscall", "path", "spawnargs"]) expect(Object.hasOwn(failure, field)).toBe(false);
    install((_, args) => {
      if (same(args, pair)) throw failure;
      if (same(args, ["rev-parse", "HEAD"])) return expectedA;
      if (same(args, ["rev-parse", "--absolute-git-dir"])) return "/owned/admin";
      throw new Error("Unexpected native call");
    });
    expect(readProducerMetadata("/owned/root", expectedA)).toBe("/owned/admin");
    expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"], ["rev-parse", "--absolute-git-dir"]]);
  }, 30000);
});


describe("native producer identity and directory domains", () => {
  it("retains the original two-read output across native roots and internal newlines", () => {
    const value = setup();
    const roots = [value.worktree];
    const nested = join(value.worktree, "nested space", "deeper");
    mkdirSync(nested, { recursive: true }); roots.push(nested);
    for (const name of ["linked space", "linked\nnewline"]) {
      const root = join(value.base, name);
      value.git(["worktree", "add", "--detach", root, "HEAD"]); roots.push(root);
    }
    const standalone = join(value.base, "actual\nnewline root");
    mkdirSync(standalone);
    git(standalone, ["init", "--initial-branch=main"]);
    git(standalone, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", "Owned newline native fixture"]);
    roots.push(standalone);
    let exercisedNewline = false;
    for (const root of roots) {
      const head = git(root, ["rev-parse", "HEAD"]);
      const metadata = git(root, ["rev-parse", "--absolute-git-dir"]);
      const combined = git(root, pair);
      expect(combined).toBe(`${head}\n${metadata}`);
      expect(combined.slice(0, combined.indexOf("\n"))).toBe(head);
      expect(combined.slice(combined.indexOf("\n") + 1)).toBe(metadata);
      expect(readProducerMetadata(root, head)).toBe(metadata);
      exercisedNewline ||= metadata.includes("\n");
    }
    expect(exercisedNewline).toBe(true);
  }, 30000);

  it("keeps an actual unborn native result unproved and propagates original HEAD failure", () => {
    const value = setup();
    const before = git(value.worktree, ["rev-parse", "HEAD"]);
    value.git(["symbolic-ref", "HEAD", "refs/heads/producer-unborn"]);
    const result = spawnSync("git", pair, { cwd: value.worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim().startsWith(before)).toBe(false);
    control.calls.length = 0;
    expect(() => readProducerMetadata(value.worktree, before)).toThrow();
    expect(control.calls).toEqual([pair, ["rev-parse", "HEAD"]]);
  }, 30000);
});

function setup() { const value = syncFixture(); fixtures.push(value); return value; }
function same(left: string[], right: string[]) { return JSON.stringify(left) === JSON.stringify(right); }
function install(reply: NonNullable<typeof control.reply>) { control.calls.length = 0; control.reply = reply; }
function nativeFailure(stdout: string) {
  const stderr = "fatal: synthetic metadata failure\n";
  return Object.assign(new Error(`Command failed: git rev-parse HEAD --absolute-git-dir\n${stderr}`), {
    pid: 123, status: 128, signal: null, stdout, stderr, output: [null, stdout, stderr],
  });
}
function withPath(value: ReturnType<typeof syncFixture>) {
  const previous = process.env.PATH; process.env.PATH = `${value.bin}:${previous ?? ""}`;
  restorers.push(() => { if (previous === undefined) Reflect.deleteProperty(process.env, "PATH"); else process.env.PATH = previous; });
}
function compilerNegative(root: string, mismatch: Extract<FirstProducerHead, { kind: "mismatch" }>) {
  // @ts-expect-error A proved mismatch cannot enter unproved fallback.
  fallbackProducerMetadata(root, expectedA, mismatch);
  // @ts-expect-error Completion knowledge is required, not optional.
  fallbackProducerMetadata(root, expectedA);
}
