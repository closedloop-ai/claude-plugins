import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseValidationResult, validationBrief } from "./cloud-worker.mjs";

const commit = "a".repeat(40);
const specs = Array.from({ length: 11 }, (_, i) => ({
  name: "unit-" + i,
  command: "node --test fixture-" + i + ".test.mjs",
}));
const subject = {
  worktree: "/fixture",
  repository: "example/widgets",
  provider: "claude",
  branch: "main",
  commit,
  model: "fixture-model",
  lanes: specs,
};
test("oversized unapproved validation refuses before dispatch with the exact split capacity", () => {
  assert.throws(() => validationBrief(subject), /split into at most 2 lanes per request/);
});
test("a clipped one-of-eight provider log can import all approved artifact outcomes", async () => {
  const { encodeOutcomes, artifactPointer } = await import("./cloud-outcome-artifact.mjs");
  const req = {
    ...subject,
    resultArtifact: {
      kind: "validation-outcomes",
      path: ".vibe-validation-outcomes-12345678.json",
      branch: "vibe-validation-results/fixture-12345678",
    },
  };
  const key = createHash("sha256").update(JSON.stringify(req)).digest("hex");
  const digest = "c".repeat(64),
    child = "b".repeat(40),
    dir = "/tmp/vibe-lane-results-Abc012";
  const records = specs.map((lane, i) => ({
    name: lane.name,
    exitCode: i === 9 ? 1 : 0,
    privateStreams: Object.fromEntries(
      ["stdout", "stderr"].map((ch) => [ch, { file: dir + "/" + i + "." + ch, sha256: digest, bytes: i + 1 }]),
    ),
  }));
  const encoded = encodeOutcomes({
    key,
    commit,
    repository: req.repository,
    directory: dir,
    host: "worker",
    lanes: records,
  });
  const raw =
    'tool: VIBE_VALIDATION_LANE {"index":0,"part":0,"parts":8}…\nVIBE_OUTCOME_ARTIFACT ' + child + ":" + digest;
  assert.equal(artifactPointer(raw, req).commit, child);
  const data = parseValidationResult(raw, req, {
    requestKey: key,
    artifactReader: () => ({ result: { version: 1, encoded } }),
  });
  assert.equal(data.lanes.length, 11);
  assert.equal(data.passed, false);
  assert.equal(data.lanes[9].exitCode, 1);
  assert.deepEqual(data.lanes[2].privateStreams, records[2].privateStreams);
  assert.throws(
    () =>
      parseValidationResult(raw, req, {
        requestKey: "f".repeat(64),
        artifactReader: () => ({ result: { version: 1, encoded } }),
      }),
    /different request/,
  );
});

test("the requested result ref supplies the same verified outcomes when its log pointer is clipped", async (t) => {
  const { join } = await import("node:path");
  const { git, makeCheckout, makeHome } = await import("../../../skills/vibe/scripts/test-fixtures.mjs");
  const { encodeOutcomes } = await import("./cloud-outcome-artifact.mjs");
  const fixture = makeHome("outcome-reader-");
  t.after(fixture.cleanup);
  const worktree = join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: "https://github.com/example/widgets.git" });
  const run = (...args) => git(worktree, args, fixture.home);
  const base = run("rev-parse", "HEAD");
  const branch = "vibe-validation-results/fixture-12345678",
    file = ".vibe-validation-outcomes-12345678.json";
  const req = {
    ...subject,
    worktree,
    commit: base,
    resultArtifact: { kind: "validation-outcomes", branch, path: file },
  };
  const key = createHash("sha256").update(JSON.stringify(req)).digest("hex");
  const stream = { bytes: 17, sha256: "c".repeat(64) };
  const encoded = encodeOutcomes({
    key,
    commit: base,
    host: "fixture",
    repository: req.repository,
    directory: "/tmp/vibe-lane-results-abc123",
    lanes: specs.map((_, i) => ({
      exitCode: i === 4 ? 17 : 0,
      privateStreams: { stdout: stream, stderr: stream },
    })),
  });
  const bytes = JSON.stringify({ version: 1, encoded }) + "\n";
  const origin = join(fixture.root, "result.git");
  run("init", "--quiet", "--bare", origin);
  run("remote", "set-url", "origin", origin);
  const { execFileSync } = await import("node:child_process");
  const writer = new URL("./cloud-outcome-writer.mjs", import.meta.url).href;
  const script =
    "import {publishOutcomes} from " +
    JSON.stringify(writer) +
    ";console.log(publishOutcomes(...JSON.parse(process.argv[1])))";
  const publish = () =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify([req.resultArtifact, base, encoded])],
      { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const pointer = publish();
  const child = run("rev-parse", "HEAD");
  assert.equal(pointer, "VIBE_OUTCOME_ARTIFACT " + child + ":" + createHash("sha256").update(bytes).digest("hex"));
  assert.throws(publish, /already exists/);
  const log = 'tool: VIBE_VALIDATION_LANE {"index":0,"part":0,"parts":8}…';
  const result = parseValidationResult(log, req);
  assert.equal(result.artifact.commit, child);
  assert.equal(result.artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.lanes[4].exitCode, 17);
  assert.throws(
    () => parseValidationResult(log + "\nVIBE_OUTCOME_ARTIFACT " + child + ":" + "0".repeat(64), req),
    /SHA-256 differs/,
  );
});

test("standalone reporter hashes both real streams and emits only the canonical probe fields", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { git, makeCheckout, makeHome } = await import("../../../skills/vibe/scripts/test-fixtures.mjs");
  const { decodeOutcomes, outcomeRecords } = await import("./cloud-outcome-artifact.mjs");
  const fixture = makeHome("outcome-writer-");
  t.after(fixture.cleanup);
  const worktree = join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: "https://github.com/example/widgets.git" });
  const rewrite = git(worktree, ["config", "--name-only", "--get-regexp", "^url\\..*\\.insteadof$"], fixture.home);
  git(worktree, ["config", "--unset", rewrite], fixture.home);
  const commit = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "vibe-lane-results-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "a".repeat(64),
    names = ["probe"],
    repository = "example/widgets";
  const caps = {
    defaultDaemon: "NO",
    defaultHello: "NO",
    vfsDaemon: "YES",
    vfsHello: "NO",
    compose: "YES",
    electronVersion: "NO",
    electronWindow: "NO",
  };
  const stdout =
    "CLOUD_CAPABILITIES " +
    "x".repeat(130000) +
    "\nCLOUD_CAPABILITY_STATUS " +
    JSON.stringify(caps) +
    "\nCLOUD_HOST_RUNTIME " +
    JSON.stringify({ commit, checks: { nonRoot: true, docker: false } }) +
    "\n";
  writeFileSync(join(dir, "0.stdout"), stdout);
  writeFileSync(join(dir, "0.stderr"), "private fixture output");
  writeFileSync(join(dir, "0.json"), JSON.stringify({ name: "probe", exitCode: 0 }));
  const args = Buffer.from(JSON.stringify({ key, commit, repository, names, probe: 0 })).toString("base64url");
  const run = () =>
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./cloud-outcome-writer.mjs", import.meta.url)), args, dir],
      {
        cwd: worktree,
        env: { ...process.env, CLAUDE_CODE_REMOTE: "true" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const line = run();
  assert.ok(line.length < 400);
  const decoded = decodeOutcomes(outcomeRecords(line, "VIBE_OUTCOMES_V1")[0], {
    key,
    commit,
    repository,
    names,
    probe: 0,
  }).lanes[0];
  assert.equal(decoded.privateStreams.stdout.sha256, createHash("sha256").update(stdout).digest("hex"));
  assert.match(decoded.stdoutTail, /"electronWindow":"NO"/);
  assert.match(decoded.stdoutTail, /"nonRoot":true/);
  assert.doesNotMatch(line, /private fixture output/);
  writeFileSync(join(worktree, "uncommitted.txt"), "fixture");
  assert.throws(run, /checkout has tracked or untracked changes/);
});

test("fixed records preserve allowed frozen facts and reject a successful gate without its verdict", async () => {
  const { encodeOutcomes, decodeOutcomes } = await import("./cloud-outcome-artifact.mjs");
  const key = "a".repeat(64),
    repository = "example/widgets",
    context = { key, commit, repository, names: ["frozen"], frozen: [0] };
  const stream = { bytes: 0, sha256: "b".repeat(64) };
  const lane = { exitCode: 0, privateStreams: { stdout: stream, stderr: stream } };
  const pack = (row) =>
    encodeOutcomes({ ...context, host: "vm", directory: "/tmp/vibe-lane-results-aaaaaa", lanes: [row] });
  const line = decodeOutcomes(
    pack({ ...lane, frozen: { verdict: 1, files: 5, stories: 9, inputs: "bbbbbbbbbbbbbbbb" } }),
    context,
  ).lanes[0];
  assert.equal(line.stdoutTail, "FROZEN PASS 5 files 9 stories inputs bbbbbbbbbbbbbbbb");
  assert.throws(() => decodeOutcomes(pack(lane), context), /invalid frozen verdict/);
});
