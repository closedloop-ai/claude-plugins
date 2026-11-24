import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { runCloudFrozen } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-frozen-render.mjs";
import { CLOUD_FROZEN_GATE, CLOUD_FROZEN_LAUNCHER, resolveCloudFrozenLane } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-validation-frozen.mjs";
import { sessionBinding } from "../../../../vibe-closedloop/lib/vibe/scripts/provider.mjs";
import { validationBrief, validationLanes } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-worker.mjs";

const TOOL = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const APPLICATION = { repository: "closedloop-ai/symphony-alpha", baseRef: "refs/tags/test-base", base: BASE, headRef: "refs/heads/frozen-proof", head: HEAD };
const COMMAND = `node scripts/frozen-render-gate.mjs --repo . --base ${BASE} --workers 2`;
const REPO = "closedloop-ai/claude-plugins";
const PROVIDER = "plugins/vibe-closedloop/provider/provider.json";
const PROVIDER_ROOT = fileURLToPath(new URL("../../../../vibe-closedloop/provider/", import.meta.url));

test("ISS-14476 admits only the committed frozen gate through the public exact-tooling validation boundary", (t) => {
  const fixture = makeHome("vibe-cloud-frozen-lane-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: `https://github.com/${REPO}.git`,
    files: { [CLOUD_FROZEN_LAUNCHER]: "fixture launcher\n", [CLOUD_FROZEN_GATE]: "fixture gate\n", [PROVIDER]: "{}\n" } });
  const commit = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const request = { worktree, repository: REPO, commit, branch: "frozen-proof", provider: "claude",
    model: "claude-sonnet-5-5", lanes: [{ name: "frozen", command: COMMAND }], frozenRender: APPLICATION };
  const exact = validationLanes(request).lanes[0];
  assert.equal(exact.command, COMMAND);
  assert.match(exact.cloudFrozen, new RegExp(commit));
  assert.match(exact.cloudFrozen, new RegExp(BASE));
  assert.match(exact.cloudFrozen, new RegExp(HEAD));
  assert.match(validationBrief(request), /the checked-out proof tooling and pinned application inputs/);
  assert.throws(() => validationLanes({ ...request, commit: TOOL }), /exact pushed claude-plugins tooling commit/);
  assert.throws(() => validationLanes({ ...request, repository: APPLICATION.repository }), /exact pushed claude-plugins tooling commit/);
  assert.throws(() => validationLanes({ ...request, frozenRender: { ...APPLICATION, head: "main" } }), /full base and head commits/);
  assert.throws(() => validationLanes({ ...request, frozenRender: { ...APPLICATION, base: HEAD } }), /differs from the pinned application base/);
  for (const command of [
    COMMAND + " --with-deps", COMMAND.replace("--workers 2", "--workers 5"), COMMAND + " --out outside",
    COMMAND.replace("scripts/", "/installed/plugins/cache/"),
    COMMAND.replace("--repo .", "--repo ../other"), COMMAND + " | cat", `node ${CLOUD_FROZEN_LAUNCHER}`,
  ]) assert.throws(() => validationLanes({ ...request, lanes: [{ name: "frozen", command }] }), /CLOUD_FROZEN_UNAVAILABLE/);
  assert.throws(() => resolveCloudFrozenLane(COMMAND, request, { currentHead: () => commit, readCommitted: () => { throw new Error("missing"); } }),
    /exact tooling commit does not contain/);
});

function runnerFixture(t, { dirty = false, moved = false, noRecipe = false, noBrowser = false } = {}) {
  const fixture = makeHome("vibe-cloud-frozen-runner-");
  t.after(fixture.cleanup);
  const root = fixture.root;
  const gitDir = path.join(root, ".git");
  mkdirSync(gitDir);
  mkdirSync(path.join(root, "plugins/vibe-closedloop/.claude-plugin"), { recursive: true });
  writeFileSync(path.join(root, "plugins/vibe-closedloop/.claude-plugin/plugin.json"), '{"name":"vibe","version":"1.1.104"}');
  symlinkSync(PROVIDER_ROOT, path.join(root, "plugins/vibe-closedloop/provider"), "dir");
  const calls = [];
  const run = (command, args, { cwd }) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "rev-parse HEAD") return TOOL;
    if (joined === "rev-parse --absolute-git-dir") return gitDir;
    if (joined === "status --porcelain --untracked-files=no") return dirty ? " M launcher" : "";
    if (joined === "rev-parse refs/vibe-cloud/base^{commit}") return BASE;
    if (joined === "rev-parse refs/vibe-cloud/head^{commit}") return moved ? BASE : HEAD;
    if (args[0] === "worktree") mkdirSync(args[4], { recursive: true });
    if (args[0] === "show") {
      if (noRecipe) throw new Error("missing");
      const repo = args[1].startsWith(BASE) ? path.join(path.dirname(cwd), "base") : cwd;
      const dir = path.join(repo, ".closedloop-ai");
      mkdirSync(dir, { recursive: true });
      const optIn = '{"schema":1,"provider":"vibe-closedloop-provider"}';
      writeFileSync(path.join(dir, "vibe-recipes.json"), optIn);
      return optIn;
    }
    return "";
  };
  const launch = async (_repo, options) => {
    calls.push(["chromium", options.headless]);
    if (noBrowser) throw new Error("no browser");
    return { close: async () => {} };
  };
  const gate = async (options) => {
    calls.push(["gate", options.base, options.workers]);
    assert.deepEqual(sessionBinding().capabilities, ["recipes"]);
    return { exitCode: 0, line: "FROZEN PASS fixture" };
  };
  const invoke = (script = path.join(root, CLOUD_FROZEN_LAUNCHER)) =>
    runCloudFrozen({ request: { tooling: TOOL, application: APPLICATION, workers: 2 }, root, script, run, launch, gate });
  return { calls, invoke };
}

test("ISS-14476 actual frozen lane runner binds the two commits, uses recipes only, and launches Chromium headlessly", async (t) => {
  const f = runnerFixture(t);
  assert.deepEqual(await f.invoke(), { exitCode: 0, line: "FROZEN PASS fixture" });
  assert.ok(f.calls.some((args) => args.join(" ") === "pnpm exec playwright install chromium"));
  assert.ok(!f.calls.flat().includes("--with-deps"));
  assert.deepEqual(f.calls.slice(-2), [["chromium", true], ["gate", BASE, 2]]);
});

test("ISS-14476 frozen lane runner refuses mutable tooling, stale app refs, missing recipes and failed browser", async (t) => {
  await assert.rejects(runnerFixture(t, {}).invoke("/mutable/installed/cloud-frozen-render.mjs"), /exact clean pushed/);
  for (const [input, expected] of [
    [{ dirty: true }, /exact clean pushed/], [{ moved: true }, /no longer points/],
    [{ noRecipe: true }, /commit the Vibe recipe opt-in/], [{ noBrowser: true }, /could not install or launch headless Chromium/],
  ]) {
    const f = runnerFixture(t, input);
    await assert.rejects(f.invoke(), expected);
    assert.ok(!f.calls.some(([command]) => command === "gate"));
  }
});

test("frozen CLI verdict emitter preserves repetition evidence on both entry paths",async ()=>{
  const {emitFrozenVerdict}=await import("../../../skills/handoff/scripts/frozen-render-gate.mjs");
  let out="",err="";
  assert.equal(emitFrozenVerdict({line:"unstable",exitCode:0,repetitionReport:["story","base","head"]},
    {stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}}),0);
  assert.equal(out,"unstable\n");assert.equal(err,"story\nbase\nhead\n");
});
