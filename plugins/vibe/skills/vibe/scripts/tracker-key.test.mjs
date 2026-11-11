import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bindProvider, makeHome } from "./test-fixtures.mjs";

// Each case runs in a child process so the binding comes only from its own environment.
function keysIn(t, env) {
  const fixture = makeHome("tracker-key-");
  t.after(fixture.cleanup);
  const script = `
    const { issueKey, requirementsKey, trackerKey, workItem } = await import(${JSON.stringify(new URL("./tracker-key.mjs", import.meta.url).href)});
    const item = workItem();
    process.stdout.write(JSON.stringify({ key: trackerKey(), issue: issueKey(), requirements: requirementsKey(),
      items: ["ISS-12", "#12", "12", "a b"].map((value) => item.test(value)) }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, HOME: fixture.home, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", ...env(fixture.home) } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("with no tracker bound no key matches and a work item is a GitHub number", (t) => {
  const generic = keysIn(t, () => ({}));
  for (const key of [generic.key, generic.issue, generic.requirements]) assert.equal(new RegExp(key).test("ISS-12"), false);
  assert.deepEqual(generic.items, [false, true, false, false]);
});

test("with the tracker bound its keys match and a work item is its slug", (t) => {
  const bound = keysIn(t, (home) => bindProvider(home));
  assert.ok(new RegExp(`^${bound.key}$`).test("ISS-12"));
  assert.ok(new RegExp(`^${bound.issue}$`).test("FEA-3") && !new RegExp(`^${bound.issue}$`).test("PLN-3"));
  assert.ok(new RegExp(`^${bound.requirements}$`).test("PRD-7"));
  assert.deepEqual(bound.items, [true, false, false, false]);
});
