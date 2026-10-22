import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutLocation, readWriterSummary } from "./ledger.js";
import { syncFixture, probeNativeGit } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const value of fixtures.splice(0)) value.cleanup();
});

describe("native checkout metadata keeps root and authorization semantics", () => {
  it("batches only admin and branch after the exact-root native check", () => {
    const value = setup();
    const expected = checkoutLocation(value.worktree);
    const probe = probeNativeGit(value); restorers.push(probe.restore);
    expect(checkoutLocation(value.worktree)).toEqual(expected);
    expect(probe.calls()).toEqual([["rev-parse", "--show-toplevel"], ["rev-parse", "--absolute-git-dir", "--abbrev-ref", "HEAD"]]);
  }, 30000);

  it.each(["missing", "empty-dir", "empty-branch", "nonabsolute", "nonzero"] as const)("rejects %s native metadata before constructing a location", kind => {
    const value = setup();
    const expected = checkoutLocation(value.worktree);
    let output = "relative-metadata\nvibe/test\n";
    if (kind === "missing") output = `${expected.dir}\n`;
    if (kind === "empty-dir") output = "\nvibe/test\n";
    if (kind === "empty-branch") output = `${expected.dir}\n\n`;
    if (kind === "nonzero") output = `${expected.dir}\nvibe/test\n`;
    const probe = probeNativeGit(value, { argv: ["rev-parse", "--absolute-git-dir", "--abbrev-ref", "HEAD"], output, status: kind === "nonzero" ? 1 : 0 });
    restorers.push(probe.restore);
    expect(() => checkoutLocation(value.worktree)).toThrow();
  }, 30000);

  it.each(["ordinary", "newline-space", "symlink", "detached"] as const)("preserves all actual %s location fields", kind => {
    const value = setup();
    let root = value.worktree;
    if (kind === "newline-space") { root = join(value.base, "native root\nwith spaces"); renameSync(value.worktree, root); }
    if (kind === "symlink") { root = join(value.base, "linked root"); symlinkSync(value.worktree, root, "dir"); }
    if (kind === "detached") value.git(["checkout", "--detach"]);
    const place = checkoutLocation(root);
    const dir = value.git.bind(value);
    if (kind !== "newline-space") expect(place.dir).toBe(dir(["rev-parse", "--absolute-git-dir"]));
    expect(place.file).toBe(join(place.dir, "vibe-writer.json"));
    expect(place.lock).toBe(join(place.dir, "vibe-writer.lock"));
    if (kind === "newline-space") expect(place.dir).toContain("native root\nwith spaces");
    if (kind === "detached") expect(place.branch).toBe("HEAD");
    else expect(place.branch).toBe("vibe/test");
  }, 30000);

  it.each([false, true])("preserves first nested-root refusal with invalid HEAD=%s", invalid => {
    const value = setup();
    const nested = join(value.worktree, "nested"); mkdirSync(nested);
    if (invalid) value.git(["symbolic-ref", "HEAD", "refs/heads/missing"]);
    const probe = probeNativeGit(value); restorers.push(probe.restore);
    expect(() => checkoutLocation(nested)).toThrow("Use the session's exact worktree root");
    expect(probe.calls()).toEqual([["rev-parse", "--show-toplevel"]]);
  }, 30000);

  it("refuses invalid HEAD and nonrepository roots without an invented location", () => {
    const value = setup();
    const outside = join(value.base, "not-a-repo"); mkdirSync(outside);
    expect(() => checkoutLocation(outside)).toThrow();
    value.git(["symbolic-ref", "HEAD", "refs/heads/missing"]);
    expect(() => checkoutLocation(value.worktree)).toThrow();
  }, 30000);

  it("keeps session branch ownership in the existing real writer-summary caller", () => {
    const value = setup();
    const source = value.sourceTurn(); source.finish();
    const before = readWriterSummary(value.worktree);
    expect(before).toMatchObject({ workerId: "fixture-source" });
    value.git(["checkout", "-b", "vibe/other"]);
    expect(() => readWriterSummary(value.worktree)).toThrow("Session worktree or branch changed");
  }, 30000);
});

function setup() { const value = syncFixture(); fixtures.push(value); return value; }
