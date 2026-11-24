import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { encodePng } from "../../handoff/scripts/png-diff.mjs";
import { fixture, NEEDS_APP } from "./writer-placement-test-fixture.mjs";

bindProviderInProcess(after);

test("prevention remote readiness accepts bound legacy evidence and rejects stale or overflowing captured evidence", (t) => {
  const { dir, run, evidence } = fixture(t);
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const args = ["writer", "remote-proof", "--tickets", "ISS-7", "--where", "remote", "--worktree", "/fixture/remote",
    "--head", head, "--ready", head, "--base", base];
  const placed = run("placement", "ISS-7", "--evidence", evidence("app", NEEDS_APP));
  assert.equal(placed.status, 0, placed.stderr);
  const report = path.join(dir, "findings.json");
  const ready = (body) => {
    writeFileSync(report, JSON.stringify(body));
    return run(...args, "--visual-qa", report);
  };
  assert.match(run(...args).stderr, /no visual QA findings file/);
  assert.match(ready({ head: base, findings: [] }).stderr, /not the current source/);
  const legacy = ready({ head, findings: [] });
  assert.equal(legacy.status, 0, legacy.stderr);
  const check = run("push-check", "remote-proof", "--head", head);
  assert.equal(check.status, 0, "a legacy remote row has no repository or owning host for release discovery: " + check.stderr);
  assert.match(check.stdout, /^READY remote-proof /);

  const png = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
  for (const name of ["rest.png", "end.png"]) writeFileSync(path.join(dir, name), png);
  const captured = (entries) => ({ head, findings: [], rounds: [{ id: "web-remote", head, runtime: "web", captures: [{
    png: "rest.png", surface: "Web", target: "/issues", viewport: "390x800", theme: "light", paths: ["apps/app/issues.tsx"],
    overflow: { width: 390, height: 800, checkedContainers: 1, entries },
  }] }] });
  const clean = ready(captured([]));
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(ready({ head, findings: [], rounds: [] }).stderr, /needs captured rounds/);
  const overflow = { path: ":root", horizontal: true, vertical: false, blocking: true,
    scrollWidth: 410, clientWidth: 390, scrollHeight: 800, clientHeight: 800, farEndPng: "end.png" };
  assert.match(ready(captured([overflow])).stderr, /unintended overflow/);
});
