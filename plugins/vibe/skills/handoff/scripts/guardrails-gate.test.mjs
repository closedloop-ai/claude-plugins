import assert from "node:assert/strict";
import test from "node:test";
import {
  Check, createGuardrailsGate, findingId, findingsProblems, FINDINGS_SCHEMA, fromDiffRule, fromGateOutput, REVIEWER_CHECKS, scanConventions,
  scanTestRepairs, scanTokens, Severity,
} from "./guardrails-gate.mjs";
import { parseUnifiedDiff } from "./diff-rules.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function diff(path, added = [], removed = [], { status = "M" } = {}) {
  const header = status === "A" ? `new file mode 100644\n--- /dev/null\n+++ b/${path}\n` : `--- a/${path}\n+++ b/${path}\n`;
  return `diff --git a/${path} b/${path}\n${header}@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((line) => `-${line}`).join("\n")}${removed.length ? "\n" : ""}${added.map((line) => `+${line}`).join("\n")}\n`;
}

function files(...parts) {
  return parseUnifiedDiff(parts.join(""));
}

function gateFor({ diffText = "", routes = [], diffRulesFn = () => ({ blocking: [] }), packageScripts = { "check:source-gates": "x" }, sources = {} } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push({ line, options });
    if (line.includes("rev-parse HEAD")) return ok(`${HEAD}\n`);
    if (line.includes("merge-base")) return ok(`${BASE}\n`);
    if (line.includes("diff --no-color")) return ok(diffText);
    for (const [matcher, result] of routes) if (line.includes(matcher)) return typeof result === "function" ? result(line) : result;
    return ok("");
  };
  const gate = createGuardrailsGate({
    run, diffRulesFn,
    exists: (file) => file.endsWith("package.json") || file in sources,
    read: (file) => (file.endsWith("package.json") ? JSON.stringify({ scripts: packageScripts }) : sources[file]),
  });
  return { gate, calls };
}

test("tokens: a hex color, an arbitrary pixel value and an inline style are findings; a comment and a custom property are not", () => {
  const found = scanTokens(files(diff("apps/app/a.tsx", [
    "const x = <div className=\"p-[13px]\" style={{ color: \"#ff0000\" }} />;",
    "// #abcdef is a comment",
    "  --accent: #123456;",
  ])));
  const messages = found.map((item) => item.message).sort();
  assert.deepEqual(messages, ["arbitrary pixel value; use the spacing or sizing token", "hardcoded color; use the token the surface bundles", "inline style; use the token classes"]);
  assert.ok(found.every((item) => item.file === "apps/app/a.tsx" && item.line === 1 && item.severity === Severity.Medium));
});

test("tokens: a fragment link and a deleted file are not colors", () => {
  assert.deepEqual(scanTokens(files(diff("apps/app/a.tsx", ["const link = \"/docs#section\"; const u = `${base}#abc`;"]))), []);
  assert.deepEqual(scanTokens(files(diff("apps/app/b.tsx", [], ["const c = \"#ff0000\";"], { status: "M" }))), []);
});

test("conventions: enum, as cast, console, raw anchor and inline import; import renames, as const and test console are not", () => {
  const found = scanConventions(files(
    diff("packages/app/a.tsx", [
      "export enum Mode { A }",
      "const v = value as Foo;",
      "const w = [1] as const;",
      "import { x as y } from \"./z\";",
      "console.log(v);",
      "<a href=\"/settings\">x</a>",
      "const m = await import(\"./m\");",
    ]),
    diff("packages/app/a.test.tsx", ["console.log(1);"]),
  ));
  assert.deepEqual(found.map((item) => item.message).sort(), [
    "TypeScript enum; use a PascalCase const object",
    "`as` cast; narrow or type it instead",
    "console call in source",
    "inline import(); imports belong at the top of the file",
    "raw internal `<a href>`; use the navigation Link",
  ]);
  assert.equal(found.find((item) => item.message.startsWith("TypeScript enum")).severity, Severity.High);
});

const repairFile = (path = "apps/app/a.test.tsx") => files(diff(path, ["x"]));
const repairs = (before, after) => scanTestRepairs(repairFile(), () => before, () => after);

test("test repair: a changed assertion shows the words that differ, ignoring whitespace and a trailing semicolon", () => {
  assert.deepEqual(repairs("expect(a).toBe(1)\n", "  expect(a).toBe(1);\n").findings, []);
  const { findings } = repairs("expect(a).toBe(1);\n", "expect(a).toBe(2);\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, Severity.High);
  assert.match(findings[0].evidence, /-expect\(a\)\.toBe\(1\) \+expect\(a\)\.toBe\(2\)/);
  assert.match(findings[0].evidence, /changed words: expect\(a\)\.toBe\(2\)/);
});

test("test repair regression (a): a reversed expectation inside an assertion split across lines is reported with word-level evidence", () => {
  const before = [
    "  // pins current behavior; looks odd because Close skips the reset",
    "  expect(screen.getByRole(\"textbox\", { name: \"Issue title\" })).toHaveValue(",
    "    \"Keep\"",
    "  );",
    "",
  ].join("\n");
  const after = [
    "  // the shared composer has one dismissal path",
    "  expect(screen.getByRole(\"textbox\", { name: \"Issue title\" })).toHaveValue(",
    "    \"\"",
    "  );",
    "",
  ].join("\n");
  const { findings, unevaluated } = repairs(before, after);
  assert.deepEqual(unevaluated, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, Check.TestRepair);
  assert.equal(findings[0].line, 2);
  assert.match(findings[0].evidence, /toHaveValue\( "Keep" \)/);
  assert.match(findings[0].evidence, /changed words: .*""/);
});

test("test repair: a reformat of the same assertion across lines, with a trailing comma, is not a change", () => {
  const before = "expect(screen.getByText(\"a\")).toHaveValue(\"Keep\");\n";
  const after = "expect(screen.getByText(\"a\")).toHaveValue(\n  \"Keep\",\n);\n";
  assert.deepEqual(repairs(before, after).findings, []);
});

test("test repair: a removed or added assertion is a finding, a non-assertion repair is not, a new test file is not scanned", () => {
  assert.match(repairs("expect(a).toBe(1);\n", "\n").findings[0].message, /removed/);
  assert.match(repairs("\n", "expect(b).toBe(1);\n").findings[0].message, /added/);
  assert.deepEqual(repairs("import { a } from \"./a\";\n", "import { b } from \"./b\";\n").findings, []);
  assert.deepEqual(scanTestRepairs(files(diff("apps/app/new.test.tsx", ["expect(1).toBe(1);"], [], { status: "A" })), () => undefined, () => "expect(1).toBe(1);").findings, []);
});

test("test repair: a file whose base or head cannot be read is unevaluated, and the gate then lists the check as skipped, never run", () => {
  const result = scanTestRepairs(repairFile(), () => undefined, () => "expect(a).toBe(1);");
  assert.deepEqual(result, { findings: [], unevaluated: ["apps/app/a.test.tsx"] });
  const gate = gateFor({
    diffText: diff("apps/app/a.test.tsx", ["expect(a).toBe(2);"], ["expect(a).toBe(1);"]),
    routes: [["show", { status: 128, stdout: "", stderr: "fatal" }]],
    sources: { "/wt/apps/app/a.test.tsx": "expect(a).toBe(2);" },
  }).gate.gate({ worktree: "/wt" });
  assert.ok(!gate.checks_run.includes(Check.TestRepair));
  const skip = gate.checks_skipped.find((entry) => entry.name === Check.TestRepair);
  assert.match(skip.reason, /^partial: .*apps\/app\/a\.test\.tsx/);
  assert.deepEqual(findingsProblems(gate), []);
});

test("test repair through the whole gate: the reversed split-line assertion is reported and the check is listed as run", () => {
  const before = "expect(el).toHaveValue(\n  \"Keep\"\n);\n";
  const after = "expect(el).toHaveValue(\n  \"\"\n);\n";
  const report = gateFor({
    diffText: diff("apps/app/a.test.tsx", ["  \"\""], ["  \"Keep\""]),
    routes: [["show", ok(before)]],
    sources: { "/wt/apps/app/a.test.tsx": after },
  }).gate.gate({ worktree: "/wt" });
  assert.ok(report.checks_run.includes(Check.TestRepair));
  assert.equal(report.findings.filter((item) => item.check === Check.TestRepair).length, 1);
});

test("conventions regression (b): an `as` inside a test title string or a multi-line import rename is not a cast", () => {
  const head = [
    "import {",
    "  CreationFieldPlacement,",
    "  type CreationFieldValue,",
    "  type ArtifactCreationField as CreationSchemaField,",
    "  creationOptionsFromLabels,",
    "} from \"./schema\";",
    "it(\"shows the creator as Owner when none is set\", () => {});",
    "",
  ].join("\n");
  const changed = files(diff("apps/app/c.test.tsx", head.split("\n")));
  assert.deepEqual(scanConventions(changed, () => head).filter((item) => item.message.startsWith("`as` cast")), []);
  assert.deepEqual(scanConventions(changed).filter((item) => item.message.startsWith("`as` cast")), []);
});

test("conventions regression (c): an exported cast is reported, an export list rename is not", () => {
  const head = [
    "import { a as b } from \"./a\";",
    "export const CREATOR = PEOPLE[0] as User;",
    "export { x as y };",
    "export type { T as U } from \"./t\";",
    "",
  ].join("\n");
  const changed = files(diff("apps/app/fixtures.ts", head.split("\n")));
  const casts = scanConventions(changed, () => head).filter((item) => item.message.startsWith("`as` cast"));
  assert.deepEqual(casts.map((item) => item.line), [2]);
  assert.match(casts[0].evidence, /PEOPLE\[0\] as User/);
});

test("a finding id is stable for the same check, place and message and differs when any changes", () => {
  assert.equal(findingId("tokens", "a.tsx", 3, "m"), findingId("tokens", "a.tsx", 3, "m"));
  assert.notEqual(findingId("tokens", "a.tsx", 3, "m"), findingId("tokens", "a.tsx", 4, "m"));
  assert.notEqual(findingId("tokens", "a.tsx", 3, "m"), findingId("conventions", "a.tsx", 3, "m"));
  assert.match(findingId("tokens", "a.tsx", null, "m"), /^tokens:[0-9a-f]{10}$/);
});

test("a diff-rules finding keeps its rule in the message and its fix as evidence", () => {
  const item = fromDiffRule({ rule: "shared-path", file: "apps/api/lib/a.ts", line: 4, problem: "changes a shared path", fix: "record the evidence" });
  assert.equal(item.check, Check.DiffRules);
  assert.equal(item.message, "shared-path: changes a shared path");
  assert.equal(item.evidence, "record the evidence");
  assert.equal(item.line, 4);
});

test("a failing wrapped gate gives one finding per file:line it names, or one for the whole run", () => {
  const named = fromGateOutput(Check.Biome, "apps/app/a.tsx:12:3 lint/style\nnoise\napps/app/a.tsx:12:9 again\nelse/where.ts:1:1 x", new Set(["apps/app/a.tsx"]));
  assert.equal(named.length, 1);
  assert.equal(named[0].file, "apps/app/a.tsx");
  assert.equal(named[0].line, 12);
  const whole = fromGateOutput(Check.SourceGates, "Error: gate failed\nsee log", new Set());
  assert.equal(whole.length, 1);
  assert.equal(whole[0].file, ".");
  assert.equal(whole[0].line, null);
});

test("the full gate: exact shape, wrapped gates run bounded in the worktree, diff-rules wrapped, reviewer checks listed as skipped", () => {
  const { gate, calls } = gateFor({
    diffText: diff("apps/app/a.tsx", ["const c = \"#ff0000\";"]),
    routes: [["pnpm check:source-gates", { status: 1, stdout: "", stderr: "gate rule failed at apps/app/a.tsx:5" }]],
    diffRulesFn: () => ({ blocking: [{ rule: "env-dump", file: "scripts/x.mjs", line: 2, problem: "dumps env", fix: "name keys" }] }),
  });
  const report = gate.gate({ worktree: "/wt" });
  assert.deepEqual(findingsProblems(report), []);
  assert.equal(report.schema, FINDINGS_SCHEMA);
  assert.equal(report.head, HEAD);
  assert.equal(report.base, BASE);
  assert.deepEqual(report.checks_run, [Check.Biome, Check.SourceGates, Check.DiffRules, Check.Tokens, Check.Conventions, Check.TestRepair, Check.OwnerDuplicates]);
  assert.deepEqual(report.checks_skipped.map((entry) => entry.name), REVIEWER_CHECKS.map((entry) => entry.name));
  const checks = new Set(report.findings.map((item) => item.check));
  assert.deepEqual([...checks].sort(), [Check.DiffRules, Check.SourceGates, Check.Tokens]);
  assert.ok(calls.some((call) => call.line === "pnpm exec biome check apps/app/a.tsx" && call.options.cwd === "/wt"));
  assert.ok(calls.some((call) => call.line === "pnpm check:source-gates"));
});

test("a gate that cannot run is skipped with its reason and never in checks_run", () => {
  const noScript = gateFor({ diffText: diff("apps/app/a.tsx", ["const a = 1;"]), packageScripts: {} }).gate.gate({ worktree: "/wt" });
  assert.ok(!noScript.checks_run.includes(Check.SourceGates));
  assert.deepEqual(noScript.checks_skipped.find((entry) => entry.name === Check.SourceGates), { name: Check.SourceGates, reason: "the repository defines no \"check:source-gates\" script" });
  const noPnpm = gateFor({ diffText: diff("apps/app/a.tsx", ["const a = 1;"]), routes: [["pnpm", { status: 127, stdout: "", stderr: "pnpm: not found" }]] }).gate.gate({ worktree: "/wt" });
  assert.ok(!noPnpm.checks_run.includes(Check.Biome));
  assert.match(noPnpm.checks_skipped.find((entry) => entry.name === Check.Biome).reason, /could not run pnpm/);
  assert.equal(noPnpm.findings.length, 0);
  const timedOut = gateFor({ diffText: diff("apps/app/a.tsx", ["const a = 1;"]), routes: [["biome", { status: 124, stdout: "", stderr: "" }]] }).gate.gate({ worktree: "/wt" });
  assert.match(timedOut.checks_skipped.find((entry) => entry.name === Check.Biome).reason, /stopped after 600s/);
  const noRules = gateFor({ diffText: diff("apps/app/a.tsx", ["const a = 1;"]), diffRulesFn: () => { throw new Error("not a vibe branch\nmore"); } }).gate.gate({ worktree: "/wt" });
  assert.equal(noRules.checks_skipped.find((entry) => entry.name === Check.DiffRules).reason, "diff-rules could not run: not a vibe branch");
  assert.ok(!noRules.checks_run.includes(Check.DiffRules));
});

test("an empty diff skips Biome with its reason: no finding and no biome run is not a Biome pass", () => {
  const report = gateFor({ diffText: "" }).gate.gate({ worktree: "/wt" });
  assert.equal(report.findings.length, 0);
  assert.ok(!report.checks_run.includes(Check.Biome));
  assert.equal(report.checks_skipped.find((entry) => entry.name === Check.Biome).reason, "no changed file is one Biome checks");
});

test("owner duplicates: a new export another file outside the change already exports is a finding; the change's own file is not", () => {
  const { gate } = gateFor({
    diffText: diff("apps/app/new.ts", ["export const formatDate = (d: Date) => d.toISOString();", "export const ab = 1;"], [], { status: "A" }),
    routes: [["grep -nE", (line) => (line.includes("formatDate") ? ok("packages/app/shared/dates.ts:7:export const formatDate = x\napps/app/new.ts:1:export const formatDate = y\n") : ok(""))]],
  });
  const report = gate.gate({ worktree: "/wt" });
  const duplicates = report.findings.filter((item) => item.check === Check.OwnerDuplicates);
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0].message, /already exported by packages\/app\/shared\/dates\.ts:7/);
  assert.equal(duplicates[0].file, "apps/app/new.ts");
  assert.equal(duplicates[0].line, 1);
});

test("a file over 1,000 lines is a high finding", () => {
  const long = `${"x\n".repeat(1200)}`;
  const report = gateFor({ diffText: diff("apps/app/big.ts", ["const a = 1;"]), sources: { "/wt/apps/app/big.ts": long } }).gate.gate({ worktree: "/wt" });
  const found = report.findings.find((item) => item.message.includes("1,000-line ceiling") || item.message.includes("1000-line ceiling"));
  assert.ok(found);
  assert.equal(found.severity, Severity.High);
});

test("the shape check rejects extra keys, a bad severity, a finding whose check did not run and a skip with no reason", () => {
  const good = { schema: FINDINGS_SCHEMA, head: HEAD, base: BASE, findings: [], checks_run: [], checks_skipped: [] };
  assert.deepEqual(findingsProblems(good), []);
  assert.match(findingsProblems({ ...good, extra: 1 }).join(), /top-level keys/);
  const item = { id: "i", check: "tokens", file: "a", line: 1, severity: "high", message: "m", evidence: "e" };
  assert.match(findingsProblems({ ...good, findings: [item] }).join(), /neither checks_run nor checks_skipped/);
  assert.deepEqual(findingsProblems({ ...good, findings: [item], checks_run: ["tokens"] }), []);
  assert.match(findingsProblems({ ...good, findings: [{ ...item, severity: "blocking" }], checks_run: ["tokens"] }).join(), /severity/);
  assert.match(findingsProblems({ ...good, findings: [{ ...item, line: 1.5 }], checks_run: ["tokens"] }).join(), /integer or null/);
  assert.match(findingsProblems({ ...good, checks_skipped: [{ name: "biome", reason: "" }] }).join(), /checks_skipped/);
});
