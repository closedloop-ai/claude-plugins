import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { committedInputs } from "./main-sync-checks.js";
import { MainSyncError } from "./main-sync-contracts.js";
import { committedIdentity } from "./main-sync-state.js";
import { syncFixture, probeNativeGit } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const value of fixtures.splice(0)) value.cleanup();
});

describe("native committed identity preserves every assessment boundary", () => {
  it("batches only the two revision reads after the separate merge-path check", () => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    const calls = nativeProbe(value);
    expect(committedIdentity(value.worktree)).toEqual(expected);
    expect(calls()).toEqual([["rev-parse", "--git-path", "MERGE_HEAD"], ["rev-parse", "HEAD", "HEAD^{tree}"]]);
  }, 30000);

  it.each(["missing", "extra", "malformed"] as const)("rejects %s batched revision output", kind => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    let output = `${expected.headSha}\nnot-a-tree\n`;
    if (kind === "missing") output = `${expected.headSha}\n`;
    else if (kind === "extra") output = `${expected.headSha}\n${expected.treeSha}\n${expected.headSha}\n`;
    nativeProbe(value, output);
    expect(() => committedIdentity(value.worktree)).toThrow();
  }, 30000);

  it.each(["nested", "symlink-space", "detached"] as const)("retains the actual %s root identity", kind => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    let root = value.worktree;
    if (kind === "nested") { root = join(root, "nested", "deeper"); mkdirSync(root, { recursive: true }); }
    if (kind === "symlink-space") { root = join(value.base, "root with spaces"); symlinkSync(value.worktree, root, "dir"); }
    if (kind === "detached") value.git(["checkout", "--detach"]);
    expect(committedIdentity(root)).toEqual(expected);
  }, 30000);

  it("reads changed HEAD and another root rather than reusing a prior identity", () => {
    const value = setup();
    const before = committedIdentity(value.worktree);
    value.write("apps/app/probe.ts", "export const changed = true;\n");
    value.git(["add", "apps/app/probe.ts"]); value.git(["commit", "-m", "Synthetic changed identity"]);
    const after = committedIdentity(value.worktree);
    expect(after.headSha).not.toBe(before.headSha);
    expect(after.treeSha).not.toBe(before.treeSha);
    const other = setup("other-input");
    expect(committedIdentity(other.worktree).treeSha).not.toBe(after.treeSha);
    expect(committedIdentity(value.worktree)).toEqual(after);
  }, 30000);

  it.each(["file", "symlink", "unborn"] as const)("keeps merge-first NEEDS_COMMIT priority for %s state", kind => {
    const value = setup();
    const marker = join(value.metadata, "MERGE_HEAD");
    if (kind === "symlink") {
      const target = join(value.base, "merge-marker"); writeFileSync(target, "fixture\n"); symlinkSync(target, marker);
    } else writeFileSync(marker, "fixture\n");
    if (kind === "unborn") value.git(["symbolic-ref", "HEAD", "refs/heads/absent-fixture"]);
    try { committedIdentity(value.worktree); throw new Error("Missing merge refusal"); }
    catch (error) { expect(error).toBeInstanceOf(MainSyncError); expect(error).toMatchObject({ status: "NEEDS_COMMIT" }); }
  }, 30000);

  it("preserves existsSync broken-merge-link semantics and refuses an invalid HEAD", () => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    symlinkSync(join(value.base, "missing-marker"), join(value.metadata, "MERGE_HEAD"));
    expect(committedIdentity(value.worktree)).toEqual(expected);
    value.git(["symbolic-ref", "HEAD", "refs/heads/absent-fixture"]);
    expect(() => committedIdentity(value.worktree)).toThrow();
  }, 30000);

  it.each(["dirty", "staged", "untracked"] as const)("keeps the production input assessment strict for %s source", kind => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    value.write(kind === "untracked" ? "apps/app/extra.ts" : "apps/app/probe.ts", "export const changed = true;\n");
    if (kind === "staged") value.git(["add", "apps/app/probe.ts"]);
    expect(committedIdentity(value.worktree)).toEqual(expected);
    expect(() => committedInputs(value.worktree)).toThrow();
  }, 30000);

  it("keeps canonical unconsumed private evidence under its existing input policy", () => {
    const value = setup();
    const expected = committedIdentity(value.worktree);
    value.write(".closedloop-ai/vibe-plans/measurement.json", "{\"private\":true}\n");
    expect(committedInputs(value.worktree)).toMatchObject(expected);
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/measurement.json"), "utf8")).toBe("{\"private\":true}\n");
  }, 30000);
});

function setup(source?: string) {
  const value = syncFixture(source);
  fixtures.push(value);
  return value;
}

/** Counts actual delegated native calls outside any timing experiment. */
function nativeProbe(value: ReturnType<typeof syncFixture>, pairOutput?: string) {
  const probe = probeNativeGit(value, pairOutput === undefined ? undefined : { argv: ["rev-parse", "HEAD", "HEAD^{tree}"], output: pairOutput });
  restorers.push(probe.restore);
  return probe.calls;
}
