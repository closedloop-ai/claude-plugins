import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureGitCommit } from "./git-commit-fixture.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("release fixture fetches one exact missing commit in a depth-one checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "git-release-fixture-"));
  const previousPath = process.env.PATH;
  try {
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const shallow = join(root, "shallow");
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(source, "release.txt"), "one\n");
    git(source, "add", "release.txt");
    git(source, "commit", "-qm", "release one");
    const releaseSha = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "release.txt"), "two\n");
    git(source, "commit", "-qam", "release two");
    const headSha = git(source, "rev-parse", "HEAD");
    execFileSync("git", ["clone", "-q", "--bare", source, remote]);
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${remote}`, shallow]);
    assert.throws(() => git(shallow, "rev-parse", `${releaseSha}^{commit}`));
    const bin = join(root, "bin");
    const log = join(root, "git-argv.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      `exec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    assert.equal(ensureGitCommit(shallow, releaseSha), releaseSha);
    assert.equal(git(shallow, "rev-parse", `${releaseSha}^{commit}`), releaseSha);
    git(shallow, "remote", "remove", "origin");
    assert.equal(ensureGitCommit(shallow, headSha), headSha,
      "an existing commit never consults the remote");
    assert.equal(git(shallow, "rev-parse", "HEAD"), headSha,
      "fetching the fixture never changes checkout state");
    const fetches = readFileSync(log, "utf8").split("\n").filter((line) => line.includes(" fetch "));
    assert.deepEqual(fetches, [
      `-C ${shallow} fetch --no-tags --depth=1 origin ${releaseSha}`,
    ]);
    assert.doesNotMatch(fetches[0], /--unshallow|\bmain\b|refs\/heads/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
