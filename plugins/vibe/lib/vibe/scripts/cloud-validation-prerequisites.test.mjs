import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { parseValidationResult, validationBrief, validationLanes } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-worker.mjs";
import { validationPrerequisites } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-validation-prerequisites.mjs";
import { installPnpmHelpFixture } from "./pnpm-help-test-fixture.mjs";

installPnpmHelpFixture();

const REPO = "closedloop-ai/symphony-alpha";
const LANE = { name: "desktop-tests", command: "pnpm --dir apps/desktop test" };
const TARGET = "@closedloop-ai/telemetry-contract";
const BASE = "@closedloop-ai/telemetry-base";
const packageFile = (name, fields) => JSON.stringify({ name, ...fields });
const emitted = { exports: { ".": "./dist/index.js" }, scripts: { build: "tsc" } };

function checkout(t, setup, flow = false) {
  const fixture = makeHome("vibe-cloud-prerequisites-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  const files = {
    "pnpm-workspace.yaml": flow ? 'packages: ["apps/*", "packages/*"]' : 'packages:\n  - "apps/*"\n  - "packages/*"\n',
    "apps/desktop/package.json": packageFile("desktop", { dependencies: { [TARGET]: "workspace:*" } }),
    "packages/telemetry-contract/package.json": packageFile(TARGET, { scripts: { build: "tsc" }, dependencies: { [BASE]: "workspace:*" } }),
    "turbo.json": `{
      // The committed version keeps config comments and literal URLs.
      "$schema": "https://v2-10-4.turborepo.dev/schema.json",
      "tasks": { "${TARGET}#build": { "outputs": ["dist/**"] /* compiled entry */ } }
    }`,
    "packages/telemetry-base/package.json": packageFile(BASE, emitted),
    "packages/unrelated/package.json": packageFile("@closedloop-ai/unrelated", emitted),
    ...(setup ? {
      ".closedloop-ai/vibe-recipes.json": '{"schema":1,"provider":"vibe-closedloop-provider"}',
      ".closedloop-ai/loops-setup.sh": "#!/bin/bash\n",
    } : {}),
  };
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: `https://github.com/${REPO}.git`, files });
  const commit = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  return { worktree, commit, repository: REPO, branch: "proof", provider: "claude", model: "claude-sonnet-5-5",
    lanes: [LANE, { name: "desktop-renderer", command: "pnpm --filter desktop test:renderer" }] };
}

test("ISS-14476 adds committed Desktop build dependencies in topological order without caller build lanes", (t) => {
  const request = checkout(t, true);
  const resolved = validationLanes(request).lanes;
  assert.deepEqual(resolved.map(({ command }) => command),
    ["./.closedloop-ai/loops-setup.sh", `pnpm --filter ${BASE} build`, `pnpm --filter ${TARGET} build`,
      LANE.command, "pnpm --filter desktop test:renderer"]);
  assert.equal(resolved.filter(({ command }) => command.includes(TARGET)).length, 1);
  assert.throws(()=>validationBrief(request),/split into at most 2 lanes/);
  const brief = validationBrief({...request,resultArtifact:{kind:"validation-outcomes",branch:"vibe-validation-results/dependencies",path:".vibe-validation-outcomes-12345678.json"}});
  assert.ok(brief.indexOf(`pnpm --filter ${TARGET} build`) < brief.indexOf(LANE.command));
  assert.match(brief, /If a prerequisite fails, report its exit code/);
});

test("ISS-14476 preserves distinct prerequisite evidence and refuses a Desktop lane after missing dist build fails", (t) => {
  const request = checkout(t, false);
  const plans = validationLanes(request).lanes;
  const report = (codes) => "VIBE_VALIDATION_RESULT " + JSON.stringify({
    commit: request.commit, provenance: { host: "vm", remote: "true", origin: `https://github.com/${REPO}`, commit: request.commit },
    lanes: plans.map(({ name }, index) => ({ name, exitCode: codes[index], notRun: "telemetry-contract failed" })), status: [],
  });
  assert.deepEqual(parseValidationResult(report([0, 0, 0, 0]), request).lanes.map(({ command }) => command),
    [`pnpm --filter ${BASE} build`, `pnpm --filter ${TARGET} build`, LANE.command, "pnpm --filter desktop test:renderer"]);
  assert.equal(parseValidationResult(report([0, 1, null, null]), request).passed, false);
  assert.throws(() => parseValidationResult(report([0, 1, 1, 0]), request), /ran desktop-tests after prerequisite.*failed/);
});

test("ISS-14476 selects the deepest exact workspace owner with a same-length sibling control", () => {
  const parent = "@fixture/parent";
  const nested = "@fixture/nested";
  const sibling = "@fixture/sibling";
  const manifest = (name) => packageFile(name, { dependencies: { [`${name}-build`]: "workspace:*" } });
  const files = new Map([
    ["pnpm-workspace.yaml", 'packages:\n  - "apps/**"\n  - "packages/*"\n'],
    ["package.json", JSON.stringify({scripts:{"desktop:typecheck":"pnpm turbo typecheck --filter="+nested}})],
    ["apps/desktop/package.json", manifest(parent)],
    ["apps/desktop/renderer/package.json", manifest(nested)],
    ["apps/desktop/siblings/package.json", manifest(sibling)],
    ...[parent, nested, sibling].map((name) => [`packages/${name.split("/")[1]}/package.json`, packageFile(`${name}-build`, emitted)]),
  ]);
  function selected(command, paths) {
    return validationPrerequisites([{ command }], { read: (name) => files.get(name) ?? null, files: () => paths })
      .map(({ command }) => command);
  }
  const names = [...files.keys()];
  const lane = "pnpm --dir apps/desktop/renderer test";
  assert.deepEqual(selected("pnpm desktop:typecheck",names),["pnpm --filter "+nested+"-build build"]);
  assert.deepEqual(selected(lane, names), [`pnpm --filter ${nested}-build build`]);
  assert.deepEqual(selected(lane, [...names].reverse()), [`pnpm --filter ${nested}-build build`]);
  assert.deepEqual(selected("pnpm --dir apps/desktop/siblings test", names), [`pnpm --filter ${sibling}-build build`]);
  assert.deepEqual(selected(LANE.command, names), [`pnpm --filter ${parent}-build build`]);
});

test("flow workspace packages contribute the same committed prerequisite builds", t => {
  const commands = validationLanes(checkout(t, true, true)).lanes.map(lane => lane.command);
  assert.ok(commands.includes(`pnpm --filter ${TARGET} build`));
});

test("literal and quoted workspace selectors build identical prerequisites",t=>{
  const request=checkout(t,true);
  const setup=command=>validationLanes({...request,lanes:[{name:"renderer",command}]}).lanes.filter(l=>l.prerequisite).map(l=>l.command);
  const plain=setup("pnpm --filter=desktop test:renderer");
  assert.ok(plain.length>1);
  assert.deepEqual(setup("pnpm -F=desktop test:renderer"),plain);
  assert.doesNotThrow(()=>setup('pytest -k "slow or smoke"'));
  assert.deepEqual(setup('pnpm --filter="desktop" test:renderer'),plain);
});
