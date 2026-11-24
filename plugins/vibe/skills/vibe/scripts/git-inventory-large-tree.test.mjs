import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "../../handoff/scripts/diff-rules-repo.mjs";
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { committedSourceIdentity, sourceIdentity } from "../../../lib/vibe/scripts/tested-head.mjs";
import { git, gitEnv, isolatedVibeEnvironment, makeHome } from "./test-fixtures.mjs";

const recorder = fileURLToPath(new URL("./pre-pr-lanes.mjs", import.meta.url));
const lane = "pnpm --filter @repo/app test";
const matchingFailure = { id: "ordered rows > preserves tie order", assertion: "expected [2, 1] to deeply equal [1, 2]" };
const sentinel = "z-sentinel file.txt";
const emptySha = createHash("sha256").digest("hex");

function gitFixture(t) {
  const { root, home, cleanup } = makeHome("vibe-large-git-tree-");
  t.after(cleanup);
  const repo = path.join(root, "repo");
  git(root, ["init", "--quiet", "--initial-branch=session", repo], home);
  writeFileSync(path.join(repo, sentinel), "session fixture\n");
  git(repo, ["add", "--", sentinel], home);
  git(repo, ["commit", "--quiet", "-m", "fixture session"], home);
  return { root, home, repo, head: git(repo, ["rev-parse", "HEAD"], home) };
}

function importLargeMain({ repo, home }) {
  const repeated = "a".repeat(27000);
  const target = sentinel;
  const entries = Array.from({ length: 5200 }, (_, index) => ({
    file: `root/${"directory".repeat(8)}/${"fixture".repeat(17)}-${String(index).padStart(5, "0")}.txt`,
    mode: "100644", content: repeated, mark: 1,
  }));
  entries.push({ file: sentinel, mode: "100755", content: repeated, mark: 1 },
    { file: "z-symbolic-link", mode: "120000", content: target, mark: 2 });
  const commands = [
    `blob\nmark :1\ndata ${repeated.length}\n${repeated}`,
    `blob\nmark :2\ndata ${target.length}\n${target}`,
    "commit refs/heads/main\ncommitter Vibe Fixture <vibe-fixture@example.invalid> 1 +0000\ndata 4\nmain",
    ...entries.map(({ file, mode, mark }) => `M ${mode} :${mark} ${JSON.stringify(file)}`),
    "", "done", "",
  ].join("\n");
  execFileSync("git", ["-C", repo, "fast-import", "--quiet"], {
    env: gitEnv(home), input: commands, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
  });
  const main = git(repo, ["rev-parse", "refs/heads/main"], home);
  git(repo, ["update-ref", "refs/remotes/origin/main", main], home);
  const listing = execFileSync("git", ["-C", repo, "ls-tree", "-rz", "--full-tree", main],
    { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  assert.ok(listing.length > 1024 * 1024, "the real tree listing exceeds Node's default buffer");
  assert.ok(entries.reduce((sum, { content }) => sum + content.length, 0) > 128 * 1024 * 1024,
    "the fixture's aggregate committed blob data exceeds the previously failing explicit cap");
  return { main, entries };
}

function expectedTree(entries) {
  const hash = createHash("sha256");
  for (const entry of entries.sort((a, b) => (a.file > b.file) - (a.file < b.file))) {
    const mode = entry.mode === "120000" ? "symlink" : entry.mode === "100755" ? "73" : "0";
    for (const value of [entry.file, mode, entry.content]) hash.update(`${Buffer.byteLength(value)}:`).update(value);
  }
  return hash.digest("hex");
}

test("AC-80 ISS-14476 records an exact main-preexisting receipt above the inventory and cumulative blob limits", (t) => {
  const fixture = gitFixture(t);
  const { root, home, repo, head } = fixture;
  const { main, entries } = importLargeMain(fixture);
  const report = path.join(root, "report.txt");
  const failures = path.join(root, "failures.json");
  const log = path.join(repo, ".git", "vibe-lane-results.json");
  writeFileSync(report, `IN THE TURBO GRAPH: 1 packages\n    ${lane}\n`);
  const run = (mainSha) => spawnSync(process.execPath, [recorder, "record", "--worktree", repo, "--head", head,
    "--command", lane, "--report", report, "--result", "main-preexisting", "--main-sha", mainSha, "--failures", failures],
  { env: isolatedVibeEnvironment(home), encoding: "utf8", timeout: 60_000 });

  writeFileSync(failures, JSON.stringify({ branch: [matchingFailure], main: [{ ...matchingFailure, assertion: "different" }] }));
  const mismatch = run(main);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout + mismatch.stderr, /does not fail on main with the same assertion/);
  assert.equal(existsSync(log), false);

  writeFileSync(failures, JSON.stringify({ branch: [matchingFailure], main: [matchingFailure] }));
  const wrongRef = run(head);
  assert.notEqual(wrongRef.status, 0);
  assert.match(wrongRef.stdout + wrongRef.stderr, /not this clone's exact fetched origin\/main/);
  assert.equal(existsSync(log), false);

  const recorded = run(main);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const [entry] = JSON.parse(readFileSync(log, "utf8"));
  assert.deepEqual([entry.result, entry.mainSha, entry.failures], ["main-preexisting", main, [matchingFailure]]);
  assert.deepEqual(entry.mainSource, { head: main, diffSha256: emptySha, treeSha256: expectedTree(entries) });

  const diff = gitRepo(repo, main, () => false, {}, []);
  assert.equal(diff.baseFiles.size, entries.length);
  assert.equal(diff.baseObjects.get(sentinel)?.mode, "100755");
  assert.equal(diff.baseObjects.get("z-symbolic-link")?.mode, "120000");
  assert.ok(diff.headFiles.includes(sentinel));
  assert.throws(() => gitRepo(repo, "missing-base", () => false, {}, []), /not a valid object name missing-base/i);
});

test("ISS-14476 keeps ordinary source identity and rejects an incomplete bounded blob frame", (t) => {
  const { repo, head } = gitFixture(t);
  assert.deepEqual(committedSourceIdentity(repo, head), sourceIdentity(repo, head));
  const exec = childProcess.execFileSync;
  try {
    childProcess.execFileSync = function (command, args, options) {
      const output = exec(command, args, options);
      return command === "git" && args[1] === repo && args[2] === "cat-file" && args[3] === "--batch"
        ? output.subarray(0, -1) : output;
    };
    syncBuiltinESMExports();
    assert.throws(() => committedSourceIdentity(repo, head), /incomplete committed blob/);
  } finally {
    childProcess.execFileSync = exec;
    syncBuiltinESMExports();
  }
});

test("ISS-14476 keeps literal Git inventory argv, full output framing and the larger existing budget", () => {
  const output = Buffer.from("  leading\0spaced path\0");
  const args = ["ls-files", "-z", "--", "path with spaces"];
  const run = (command, argv, options) => {
    assert.equal(command, "git");
    assert.deepEqual(argv, ["-C", "/repo fixture", ...args]);
    assert.equal(options.encoding, "buffer");
    return { output, budget: options.maxBuffer };
  };
  assert.deepEqual(readGitInventory("/repo fixture", args, { encoding: "buffer", run }), {
    output, budget: 128 * 1024 * 1024,
  });
  assert.deepEqual(readGitInventory("/repo fixture", args, { encoding: "buffer", run, maxBuffer: 512 * 1024 * 1024 }), {
    output, budget: 512 * 1024 * 1024,
  });
  assert.throws(() => readGitInventory("/repo fixture", ["status"], { run }), /Git inventory command/);
});
