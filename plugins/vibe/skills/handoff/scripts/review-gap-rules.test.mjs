import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { checkDuplicateHelpers, checkUnusedExports } from "./review-gap-rules.mjs";
import { run } from "./diff-rules-test-fixture.mjs";


test("AC-017 duplicate-helper review indexes a 1 MB source file within one second", (t) => {
  const candidate = "src/large-diff.ts";
  const existing = "src/existing.ts";
  const declarations = Array.from({ length: 2400 }, (_, index) => `function helper${index}(value) {`);
  const body = '  return value + "long helper body";';
  const pad = `// ${"x".repeat(77)}\n`.repeat(12000);
  const head = pad + declarations.flatMap((declaration) => [declaration, body, "}"]).join("\n");
  assert.ok(Buffer.byteLength(head) > 1_000_000);
  const texts = new Map([[candidate, head], [existing, `${declarations[0]}\n${body}\n}\n`]]);
  const reads = [];
  const files = [{ path: candidate, status: "M", added: declarations.map((text, index) => ({ line: 12001 + index * 3, text })) }];
  const repo = {
    headFiles: new Set(texts.keys()),
    head: (file) => { reads.push(file); return texts.get(file) ?? null; },
    base: () => null,
    wordFiles: () => { throw new Error("duplicate-helper must not search the whole repository once per helper"); },
  };
  const findings = [];
  const split = String.prototype.split;
  let wholeFileSplits = 0;
  const splitProbe = t.mock.method(String.prototype, "split", function (separator, limit) {
    if (separator === "\n" && this.valueOf() === head) wholeFileSplits += 1;
    return split.call(this, separator, limit);
  });
  let elapsed;
  try {
    const started = performance.now();
    checkDuplicateHelpers(files, repo, (...args) => findings.push(args));
    elapsed = performance.now() - started;
  } finally {
    splitProbe.mock.restore();
  }
  assert.ok(wholeFileSplits <= 1, `whole-file splits: ${wholeFileSplits}`);
  assert.ok(elapsed < 1000, `large synthetic diff finished in ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(reads, [existing, candidate]);
  assert.deepEqual(findings.map(([rule, file, line]) => [rule, file, line]), [["duplicate-helper", candidate, 12001]]);
});

test("AC-017 duplicate-helper diagnostics preserve body, source and canonical file ordering", () => {
  const declaration = "function reuse(value) {";
  const same = `${declaration}\n  if (value) {\n    return \"the intended result\";\n  }\n}\n`;
  const reformatted = `${declaration}\n    if (value) {\n        return \"the intended result\";\n    }\n}\n`;
  const different = same.replace("intended", "different");
  const texts = new Map([
    ["src/z.ts", reformatted], ["src/reuse.ts", same], ["src/a.ts", same],
    ["src/0.test.ts", same], ["src/0.stories.tsx", same], ["src/0.ts", different],
    ["src/duplicate-declaration.ts", `function reuse() {\n}\n${same}`],
    ["src/unclosed.ts", `${declaration}\n    return value + \"long helper body\";\n`],
  ]);
  const names = ["src/z.ts", "src/a.ts", "src/unclosed.ts", "src/duplicate-declaration.ts"];
  const files = names.map((path, index) => ({ path, status: "M", added: [{ line: 3 + index, text: declaration }] }));
  const findings = [];
  checkDuplicateHelpers(files, { headFiles: [...texts.keys()], head: (file) => texts.get(file) ?? null,
    wordFiles: (name) => [...texts].filter(([, source]) => source.includes(name)).map(([file]) => file) },
    (...args) => findings.push(args));
  assert.deepEqual(findings, [
    ["duplicate-helper", "src/z.ts", 3, "new helper reuse duplicates src/a.ts",
      "move the shared behavior to one owner and import it from src/a.ts"],
    ["duplicate-helper", "src/a.ts", 4, "new helper reuse duplicates src/reuse.ts",
      "move the shared behavior to one owner and import it from src/reuse.ts"],
  ]);
});

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

test("ISS-14116: unused-export prefetches every new export name in one search before reading any", () => {
  const files = [
    { path: "src/a.ts", status: "M", added: [{ line: 1, text: "export const alpha = 1;" }, { line: 2, text: "export function beta() {}" }] },
    { path: "src/b.ts", status: "A", added: [{ line: 1, text: "export type Gamma = string;" }] },
  ];
  const calls = [];
  const repo = {
    base: () => null,
    prefetchWords: (words) => calls.push(["prefetch", [...words]]),
    wordFiles: (word) => { calls.push(["read", word]); return word === "alpha" ? ["src/a.ts", "src/c.ts"] : []; },
  };
  const findings = [];
  checkUnusedExports(files, repo, () => false, (...args) => findings.push(args[2]));
  assert.deepEqual(calls[0], ["prefetch", ["alpha", "beta", "Gamma"]]);
  assert.equal(calls.filter(([kind]) => kind === "prefetch").length, 1);
  assert.deepEqual(findings, [2, 1]);
});
