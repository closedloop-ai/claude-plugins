import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deliveryPlacementProblem } from "../../../lib/fleet-orchestrator/scripts/delivery-placement.mjs";
import { parseValidationResult, validateValidationRequest } from "../../../lib/vibe/scripts/cloud-worker.mjs";
import { imageProblem, invalidateImages, recordImages } from "../../../lib/vibe/scripts/image-head.mjs";
import { pluginScriptProblems } from "../../../lib/vibe/scripts/plugin-script-references.mjs";
import { providerProbeProblem } from "../../../lib/vibe/scripts/provider.mjs";
import { isOwnedPrototypeSession } from "./prototype-session.mjs";
import { prototypeViewerAccess } from "./prototype-share.mjs";
import { makeCheckout, makeHome } from "./test-fixtures.mjs";

test("ISS-14476 distinguishes immutable preview access, a Vercel team sign-in and an unknown response", async () => {
  const preview = "https://preview.example.test/p/board";
  const result = (status, location) => new Response("", { status, headers: location ? { location } : {} });
  const checked = [];
  assert.equal(await prototypeViewerAccess(preview, async (url, options) => {
    checked.push([url, options.method, options.redirect]);
    return result(200);
  }), "public");
  assert.deepEqual(checked, [[preview, "HEAD", "manual"]]);
  const vercel = async () => result(302, "https://vercel.com/sso-api?org=example");
  assert.equal(await prototypeViewerAccess(preview, vercel), "vercel-team");
  assert.equal(await prototypeViewerAccess(preview, async () => result(302, "https://example.com/login")), "unverified");
  assert.equal(await prototypeViewerAccess(preview, async () => { throw new Error("no response"); }), "unverified");
});

test("ISS-14476 requires stored ownership on a normal vibe branch and reads matching legacy prototypes", () => {
  const provenance = { slug: "board", operator: { id: "fixture", email: "fixture@example.test" }, createdAt: "2026-11-19T10:00:00Z" };
  const current = { ...provenance, kind: "prototype", branch: "vibe/board" };
  const legacy = { ...provenance, branch: "prototype/board" };
  assert.equal(isOwnedPrototypeSession(current, "vibe/board"), true);
  assert.equal(isOwnedPrototypeSession(legacy, "prototype/board"), true);
  assert.equal(isOwnedPrototypeSession({ branch: "vibe/board", slug: "board" }), false);
  assert.equal(isOwnedPrototypeSession(current, "vibe/other"), false);
});

test("ISS-14476 resolves reviewed source shell scripts and refuses symlink escapes or absent installed scripts", (t) => {
  const fixture = makeHome("vibe-script-containment-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "checkout");
  const manifest = JSON.stringify({ name: "vibe-generic", version: "1.1.104" });
  makeCheckout({ ...fixture, checkout, files: {
    "plugins/vibe/.codex-plugin/plugin.json": manifest,
    "plugins/vibe/skills/vibe/scripts/review.sh": "#!/bin/sh\nexit 0\n",
  } });
  const installed = path.join(fixture.root, "installed");
  mkdirSync(path.join(installed, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(installed, "skills/vibe/scripts"), { recursive: true });
  writeFileSync(path.join(installed, ".codex-plugin/plugin.json"), manifest);
  const escape = "plugins/vibe/skills/vibe/scripts/escape.sh";
  const target = path.join(installed, "skills/vibe/scripts/allowed.sh");
  writeFileSync(target, "#!/bin/sh\nexit 0\n");
  symlinkSync(target, path.join(checkout, escape));
  assert.deepEqual(pluginScriptProblems("Read plugins/vibe/skills/vibe/scripts/review.sh", installed, checkout), []);
  assert.deepEqual(pluginScriptProblems("Run ./scripts/allowed.sh", installed, checkout), []);
  assert.match(pluginScriptProblems("Read " + escape, installed, checkout).join("\n"), /not a contained regular file/);
  assert(pluginScriptProblems("Read ../vibe/scripts/absent.sh", installed, checkout).length);
});

test("AC-40 ISS-14476 names provider-declared probe operations and connection argument keys before dispatch", () => {
  const needed = { state: "unprobed", connectionsNeeded: [
    { name: "tracker", check: "mcp tracker get-me" }, { name: "graph", check: "mcp graph sync_status" },
  ] };
  const refusal = providerProbeProblem(needed);
  assert.match(refusal, /get-me.*sync_status/);
  assert.match(refusal, /--connection tracker=<state> --connection graph=<state>/);
  assert.equal(providerProbeProblem({ ...needed, state: "bound" }), null);
  assert.match(providerProbeProblem({ ...needed, state: "bound-disconnected" }, { disconnected: true }), /--connection graph/);
});

test("AC-44 ISS-14476 admits a cross-repository unrelated issue without reading a malformed fleet board", () => {
  const content = "Delivery placement: unrelated: this project owns the reporter\n";
  const input = { content, repository: "example/plugin", sourceRepository: "example/app", operation: "issue",
    board: { get units() { throw new Error("unexpected program board read"); } } };
  assert.equal(deliveryPlacementProblem(input), null);
  assert.notEqual(deliveryPlacementProblem({ ...input, sourceRepository: undefined, board: { units: {} }, content: "No placement" }), null);
  assert.match(deliveryPlacementProblem({ ...input, board: { units: { owned: { repo: "example/plugin" } } },
    operation: "pull-request" }), /owned/);
});

test("ISS-14476 retires an image witness as soon as a replacement build can overwrite its tags", (t) => {
  const { root, cleanup } = makeHome("vibe-image-witness-");
  t.after(cleanup);
  const build = "docker compose -f e2e/compose.yml up --build";
  const reuse = "docker compose up --no-build";
  const input = { project: "fixture", worktree: root, head: "a".repeat(40), source: { treeSha256: "b".repeat(64) }, records: root };
  assert.equal(recordImages({ ...input, command: build }), true);
  assert.equal(imageProblem({ ...input, command: reuse }), null);
  assert.match(imageProblem({ ...input, command: reuse, source: { treeSha256: "c".repeat(64) } }), /different uncommitted inputs/);
  invalidateImages({ ...input, command: reuse });
  assert.equal(imageProblem({ ...input, command: reuse }), null);
  invalidateImages({ ...input, command: build });
  assert.match(imageProblem({ ...input, command: reuse }), /no recorded build/);
});

test("ISS-14476 cloud validation refuses other commits and keeps separate bounded failure streams", () => {
  const commit = "a".repeat(40);
  const request = { provider: "claude", repository: "example/plugin", worktree: "/fixture",
    branch: "vibe/proof", model: "claude-test-model", commit, lanes: [{ name: "lint", command: "node --test plugins/vibe/lib/vibe/scripts/cloud-worker.test.mjs" }] };
  const entry = { name: "lint", exitCode: null, notRun: "dependency absent", stdoutTail: "a".repeat(5_000) + "stdout end",
    stderrTail: "b".repeat(5_000) + "stderr end", diagnosis: "bootstrap missing" };
  const result = (sha) => "VIBE_VALIDATION_RESULT " + JSON.stringify({ commit: sha, status: [],
    lanes: [entry], provenance: { host: "validation", remote: "true", origin: "https://github.com/example/plugin", commit: sha } });
  assert.throws(() => validateValidationRequest({ ...request, provider: "codex" }), /use provider claude/);
  assert.throws(() => parseValidationResult(result("b".repeat(40)), request), /not the requested/);
  const parsed = parseValidationResult(result(commit), request);
  assert.equal(parsed.passed, false);
  const lane = parsed.lanes[0];
  assert.equal(lane.notRun, "dependency absent");
  assert.equal(lane.diagnosis, "bootstrap missing");
  assert.match(lane.stdoutTail, /stdout end$/);
  assert.match(lane.stderrTail, /stderr end$/);
  assert(lane.stderrTail.length < 5_000 && lane.stdoutTail.length < 5_000);
});
