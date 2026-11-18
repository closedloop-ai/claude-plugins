import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./diff-rules-test-fixture.mjs";

// A build copies plugins/tool to plugins/tool-built and writes a marker at the output's root naming its source.
const SOURCE = "plugins/tool/skills/x/scripts/helper.mjs";
const BUILT = "plugins/tool-built/skills/x/scripts/helper.mjs";
const MARKER = "plugins/tool-built/.vibe-build.json";
const HELPER = "export function capitalize(value) {\n  return `${value[0]?.toUpperCase() ?? \"\"}${value.slice(1)}`;\n}\n";
const marker = (builtFrom) => `${JSON.stringify({ builtFrom }, null, 2)}\n`;
const duplicates = (result) => result.blocking.filter((finding) => finding.rule === "duplicate-helper");

test("ISS-14162 a built mirror under a valid build marker is the same definition as its source, not a duplicate", (t) => {
  const result = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: marker("plugins/tool") } });
  assert.deepEqual(duplicates(result), []);
  const committedSource = run(t, { base: { [SOURCE]: HELPER }, head: { [BUILT]: HELPER, [MARKER]: marker("plugins/tool") } });
  assert.deepEqual(duplicates(committedSource), [], "the source at base proves the pair too");
});

test("ISS-14162 a real copy elsewhere is still flagged beside a built mirror", (t) => {
  const copy = "plugins/other/lib/helper-copy.mjs";
  const result = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: marker("plugins/tool"), [copy]: HELPER } });
  assert.ok(duplicates(result).some((finding) => finding.problem.includes(copy) || finding.file === copy), JSON.stringify(duplicates(result)));
  const unbuilt = "plugins/tool-built/lib/extra.mjs";
  const noSource = run(t, { head: { [SOURCE]: HELPER, [MARKER]: marker("plugins/tool"), [unbuilt]: HELPER } });
  assert.equal(duplicates(noSource).length, 1, "a file under the marker with no source at its own path is a copy");
});

test("ISS-14162 a built copy with no build marker is still flagged", (t) => {
  const result = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER } });
  assert.equal(duplicates(result).length, 1);
});

test("ISS-14162 a malformed build marker proves nothing, so the copy is still flagged", (t) => {
  const plainText = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: "plugins/tool\n" } });
  assert.equal(duplicates(plainText).length, 1, "not JSON");
  const wrongType = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: `${JSON.stringify({ builtFrom: ["plugins/tool"] })}\n` } });
  assert.equal(duplicates(wrongType).length, 1, "builtFrom is not a string");
  const escaping = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: marker("plugins/tool-built/../tool") } });
  assert.equal(duplicates(escaping).length, 1, "builtFrom is not a plain path from the repository root");
});

test("ISS-14162 a build marker naming a source that does not exist is still flagged", (t) => {
  const result = run(t, { head: { [SOURCE]: HELPER, [BUILT]: HELPER, [MARKER]: marker("plugins/missing") } });
  assert.equal(duplicates(result).length, 1);
});
