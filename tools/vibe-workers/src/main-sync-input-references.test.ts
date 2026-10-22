import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import ts from "typescript";
import { invokeSync, syncFixture, selectedReportFixture } from "./main-sync-test-fixtures.js";
import { inputExpressionReference, readInputModule, referenceMatches } from "./main-sync-input-references.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
const opaqueSchema = z.object({ purpose: z.string(), origin: z.object({ repository: z.literal("closedloop-ai/symphony-alpha"),
  commit: z.literal("3dd896dfcecd5b14940fbebe3a10f969bcb8c93e"), license: z.literal("Apache-2.0") }).strict(),
  files: z.array(z.object({ path: z.string(), gitBlob: z.string(), content: z.string() }).strict()) }).strict();

/** Exact committed TEST data exercises classifier syntax without executing the Source tests. */
function opaqueExample(path: string) {
  const data = opaqueSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/symphony-input-references.json", import.meta.url), "utf8")));
  for (const file of data.files) {
    const bytes = Buffer.from(file.content);
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(file.gitBlob);
  }
  const file = data.files.find((item) => item.path === path);
  if (!file) throw new Error("Missing opaque Source TEST reference");
  return file;
}

function setup(path: string, body: string) {
  const value = syncFixture(); fixtures.push(value);
  value.write(path, body);
  value.git(["add", path]); value.git(["commit", "-m", "Synthetic committed reference example"]);
  value.write(".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json", "{\"retainedDiagnostic\":true}\n");
  value.write(".closedloop-ai/vibe-plans/probes/retained.test.tsx", "throw new Error('private evidence must not execute');\n");
  return value;
}

function readiness(value: ReturnType<typeof syncFixture>) {
  const source = value.sourceTurn();
  try { return invokeSync(value, "inputs", source.context); } finally { source.finish(); }
}

describe("receiver-bound production private references", () => {
  it.each(["relative", "absolute", "file URI", "HTTPS", "nonlocal host", "symbolic settings"] as const)(
    "preserves RQ012 URI serialization %s", row => {
    const { value, file } = alternativeFixture("new NodeURL(process.argv[2],import.meta.url)");
    let target = "public/sibling.txt";
    let candidate = "apps/app/public/sibling.txt";
    let expected = true;
    let unknownPrefix = false;
    if (row === "absolute") { target = join(value.worktree, "public/sibling.txt"); candidate = "public/sibling.txt"; }
    if (row === "file URI") { target = `file://${value.worktree}/public/sibling.txt`; candidate = "public/sibling.txt"; }
    if (row === "HTTPS" || row === "nonlocal host") {
      target = `${row === "HTTPS" ? "https" : "file"}://example.invalid/.closedloop-ai/vibe-plans/retained.json`;
      candidate = ".closedloop-ai/vibe-plans/retained.json";
      expected = false;
    }
    if (row === "symbolic settings") {
      target = "__VIBE_UNKNOWN_PATH__/.closedloop-ai/settings/__VIBE_UNKNOWN_PATH__";
      candidate = ".closedloop-ai/vibe-plans/retained.json";
      unknownPrefix = true;
      expected = false;
    }
    const constraint = { kind: "path" as const, value: target, base: "runtime" as const,
      possibleOnly: true, unknownPrefix, uncertainTerms: [target] };
    const source = readInputModule(value.worktree, file, { cwd: value.worktree, argv: ["node", file, { constraint }] });
    const result = inputExpressionReference(value.worktree, file, targetInitializer(source));
    expect(result ? referenceMatches(value.worktree, file, result, [candidate]) : false).toBe(expected);
    if (row === "HTTPS" || row === "nonlocal host") expect(result).toBeUndefined();
  });

  it.each([[false, true], [false, false], [true, true], [true, false]] as const)(
    "composes RQ012 private URI converter=%s with retained target=%s", (converter, retainedTarget) => {
    const operand = retainedTarget ? "process.argv[2]" : "path.join(process.argv[2],'public/sibling.txt')";
    const uri = `new NodeURL(${operand},import.meta.url)`;
    const { value, file, constraint } = alternativeFixture(converter ? `convert(${uri})` : uri, ".closedloop-ai/vibe-plans");
    const source = readInputModule(value.worktree, file, { cwd: value.worktree, argv: ["node", file, { constraint }] });
    const result = inputExpressionReference(value.worktree, file, targetInitializer(source));
    expect(result ? referenceMatches(value.worktree, file, result, [".closedloop-ai/vibe-plans/retained.json"]) : false).toBe(retainedTarget);
  });

  it.each([
    ["direct", "process.argv[2]", true],
    ["sibling", "path.join(process.argv[2],'public/sibling.txt')", false],
    ["report basename", "path.join(process.argv[2],'results.json')", true],
    ["const", "alias", true],
    ["helper sibling", "path.join(aliasHelper(),'public/sibling.txt')", false],
    ["imported", "operand", true],
    ["imported sibling", "path.join(operand,'public/sibling.txt')", false],
    ["repeated sibling", "path.join(process.argv[2],process.argv[2],'public/sibling.txt')", false],
    ["two-index sibling", "path.join(process.argv[2],process.argv[3],'public/sibling.txt')", false],
    ["known reset", "path.resolve(process.argv[2],'/public/sibling.txt')", false],
    ["URL", "new NodeURL(process.argv[2],import.meta.url)", true],
    ["URL sibling", "new NodeURL(path.join(process.argv[2],'public/sibling.txt'),import.meta.url)", false],
    ["converter", "convert(new NodeURL(process.argv[2],import.meta.url))", true],
    ["no target", "new NodeURL(process.argv[2],'https://example.invalid/base/')", false],
  ] as const)("composes RQ012 %s evaluated native alternatives", (_row, expression, expected) => {
    const { value, file, constraint } = alternativeFixture(expression);
    const environment = { cwd: value.worktree, argv: ["node", file, { constraint }, { constraint }] };
    const source = readInputModule(value.worktree, file, environment);
    const target = targetInitializer(source);
    const result = inputExpressionReference(value.worktree, file, target);
    expect(result ? referenceMatches(value.worktree, file, result, ["apps/desktop/playwright-report-e2e/results.json"]) : false).toBe(expected);
    const before = JSON.stringify(environment);
    inputExpressionReference(value.worktree, file, target);
    expect(JSON.stringify(environment)).toBe(before);
  });

  it("rejects RQ012 argument overflow before installing a cloned binding", () => {
    const { value, file, constraint } = alternativeFixture("process.argv[2]");
    const overflowing = { ...constraint, uncertainTerms: Array.from({ length: 33 }, (_, index) => `/work/repo/choice-${index}`) };
    const source = readInputModule(value.worktree, file, { cwd: "/work/repo", argv: ["node", file, { constraint: overflowing }] });
    const target = targetInitializer(source);
    expect(() => inputExpressionReference("/work/repo", file, target)).toThrow(RangeError);
    expect(() => inputExpressionReference("/work/repo", file, target)).toThrow(RangeError);
    const precise = readInputModule(value.worktree, file, { cwd: "/work/repo", argv: ["node", file, "/public/sibling.txt"] });
    expect(inputExpressionReference("/work/repo", file, targetInitializer(precise)))
      .toMatchObject({ value: "/public/sibling.txt", possibleOnly: false, unknownPrefix: false, uncertainTerms: [] });
  });

  it.each(["report", "private"] as const)("restores RQ012 same-source %s binding after successful composition", domain => {
    const { value, file, source, environment, candidate } = restorationFixture(domain, false);
    const target = targetInitializer(source);
    const after = targetInitializer(source, "after");
    expect(target.getSourceFile()).toBe(source);
    expect(after.getSourceFile()).toBe(source);
    const originalCallerObject = JSON.stringify(environment);
    const transformed = inputExpressionReference(value.worktree, file, target);
    expect(transformed ? referenceMatches(value.worktree, file, transformed, [candidate]) : false).toBe(false);
    for (let index = 0; index < 2; index++) {
      const restored = inputExpressionReference(value.worktree, file, after);
      expect(restored ? referenceMatches(value.worktree, file, restored, [candidate]) : false).toBe(true);
    }
    expect(JSON.stringify(environment)).toBe(originalCallerObject);
  }, 30000);

  it.each(["report", "private"] as const)("restores RQ012 same-source %s binding after installed-target overflow", domain => {
    const { value, file, source, environment, candidate } = restorationFixture(domain, true);
    const target = targetInitializer(source);
    const after = targetInitializer(source, "after");
    expect(target.getSourceFile()).toBe(source);
    expect(after.getSourceFile()).toBe(source);
    const originalCallerObject = JSON.stringify(environment);
    let failure: unknown;
    try { inputExpressionReference(value.worktree, file, target); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure).toMatchObject({ message: "Native target alternative bound exceeded" });
    for (let index = 0; index < 2; index++) {
      const restored = inputExpressionReference(value.worktree, file, after);
      expect(restored ? referenceMatches(value.worktree, file, restored, [candidate]) : false).toBe(true);
    }
    expect(JSON.stringify(environment)).toBe(originalCallerObject);
  }, 30000);

  it("retains RQ011 exact known native resolve versus join parity", () => {
    const input = "/work/repo/";
    const file = "apps/app/known-native.test.ts";
    const value = setup(file, `import path from 'node:path';const joining=path.join(${JSON.stringify(input)});const resolving=path.resolve(${JSON.stringify(input)});\n`);
    const source = readInputModule(value.worktree, file, { argv: [] });
    const statements = source.statements.filter(ts.isVariableStatement);
    const references = statements.map(statement => {
      const initializer = statement.declarationList.declarations[0]?.initializer;
      if (!initializer) throw new Error("Missing exact native initializer");
      return inputExpressionReference(value.worktree, file, initializer);
    });
    expect(join(input)).toBe(normalize(input));
    expect(references[0]).toMatchObject({ kind: "path", value: join(input), possibleOnly: false, unknownPrefix: false, uncertainTerms: [] });
    expect(references[1]).toMatchObject({ kind: "path", value: resolve(input), possibleOnly: false, unknownPrefix: false, uncertainTerms: [] });
  });

  it.each([
    ["namespace", "path.join(root,'.closedloop-ai','vibe-plans',name)", true, false, false],
    ["report directory", "path.join(root,'.vitest','blob',name)", false, true, false],
    ["specific stem", "path.join(root,dir,`acceptance-test-${name}.json`)", true, false, false],
    ["trailing rooted stem", "path.join(root+'/',dir,`acceptance-test-${name}.json`)", true, false, false],
    ["generic root", "path.join(root,dir,name)", false, false, false],
    ["generic type", "path.join(root,dir,`${name}.json`)", false, false, false],
    ["settings", "path.join(root,'.closedloop-ai','settings',name)", false, false, false],
    ["concrete reset", "path.resolve(root,'.closedloop-ai','vibe-plans',name,'/public/sibling.json')", false, false, false],
    ["private URI", "new NodeURL('file://'+process.cwd()+'/.closedloop-ai/%76ibe-plans/acceptance-test-checkpoint.json')", true, false, false],
    ["report converter", "convert('file://'+process.cwd()+'/.vitest/%62lob/blob.json')", false, true, false],
    ["URI sibling", "new NodeURL('file://'+process.cwd()+'/.closedloop-ai/%73ettings/current.json')", false, false, false],
    ["ordinary encoded string", "'file://'+process.cwd()+'/.closedloop-ai/%76ibe-plans/acceptance-test-checkpoint.json'", false, false, false],
    ["unsupported converter", "convert('https://example.invalid/.closedloop-ai/vibe-plans/acceptance-test-checkpoint.json')", false, false, true],
  ] as const)("preserves RQ011 complete %s constraints", (_row, expression, privateMatch, reportMatch, noTarget) => {
    const file = "apps/app/native-constraint.test.ts";
    const value = setup(file, `import path from 'node:path';import {URL as NodeURL,fileURLToPath as convert} from 'node:url';const root='/work/repo';function reader(dir,name){const target=${expression};}\n`);
    const source = readInputModule(value.worktree, file, { argv: [] });
    let initializer: ts.Expression | undefined;
    const inspect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "target") initializer = node.initializer;
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (!initializer) throw new Error("Missing complete native initializer");
    const reference = inputExpressionReference("/work/repo", file, initializer);
    if (noTarget) { expect(reference).toBeUndefined(); return; }
    if (!reference) throw new Error("Missing complete native reference");
    expect(referenceMatches("/work/repo", file, reference, [".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json"])).toBe(privateMatch);
    expect(referenceMatches("/work/repo", file, reference, [".vitest/blob/blob.json"])).toBe(reportMatch);
  });

  it.each([
    ["first join parents", "path.join(process.cwd(),'..','apps/desktop/playwright-report-e2e/results.json')", true],
    ["nonfirst join parents", "path.join('/work/repo/apps/desktop',process.cwd(),'..','..','..','playwright-report-e2e/results.json')", true],
    ["nonfirst resolve", "path.resolve('/work/repo/apps/desktop',process.cwd(),'..','apps/desktop/playwright-report-e2e/results.json')", true],
    ["relative-only resolve", "path.resolve('apps/desktop/playwright-report-e2e/results.json')", true],
    ["outer join erasure", "path.join(path.resolve('.'),'..','apps/desktop/playwright-report-e2e/results.json')", true],
    ["multiple possible slots", "path.join('/work/repo',process.cwd(),process.cwd(),'..','..','apps/desktop/playwright-report-e2e/results.json')", true],
    ["relative resolve parent overrun", "path.join(path.resolve('pkg'),'..','..','apps/desktop/playwright-report-e2e/results.json')", true],
    ["resolve last concrete reset", "path.resolve('/work/repo',process.cwd(),'pkg','/public/sibling.json')", false],
    ["resolve later possible", "path.resolve(process.cwd(),'/public',process.cwd(),'package.json')", true],
    ["join later absolute", "path.join(process.cwd(),'/public/sibling.json')", true],
    ["resolve absolute reset", "path.resolve(process.cwd(),'..','/public/sibling.json')", false],
    ["known native join", "path.join('/work/repo','apps/desktop/playwright-report-e2e/results.json')", false],
  ] as const)("retains RQ011 %s native value possibility", (_row, expression, possible) => {
    const file = "apps/app/native-value.test.ts";
    const value = setup(file, `import path from 'node:path';const target=${expression};\n`);
    const source = readInputModule(value.worktree, file, { argv: [] });
    const statement = source.statements.find(ts.isVariableStatement);
    const initializer = statement?.declarationList.declarations[0]?.initializer;
    if (!initializer) throw new Error("Missing synthetic native initializer");
    const reference = inputExpressionReference(value.worktree, file, initializer);
    expect(reference?.kind).toBe("path");
    if (reference?.kind !== "path") throw new Error("Missing native path reference");
    expect(reference.possibleOnly).toBe(possible);
    expect(reference.unknownPrefix).toBe(possible);
    if (_row === "nonfirst join parents") expect(referenceMatches("/work/repo", file, reference,
      ["apps/desktop/playwright-report-e2e/results.json"])).toBe(true);
  });

  it.each([
    ["absolute literal", ["/work/repo/report.json"], [], true],
    ["relative literal", ["../report.json"], [], true],
    ["absolute ancestor glob", ["/work/**/report.json"], [], true],
    ["relative glob", ["../*.json"], [], true],
    ["absolute ignore", ["../*.json"], ["/work/**/report.json"], false],
    ["relative ignore", ["/work/**/report.json"], ["../report.json"], false],
    ["mixed positives", ["/work/repo/sibling.json", "../report.json"], [], true],
    ["mixed ignores", ["/work/**/report.json", "../*.json"], ["/outside/*.json", "../report.json"], false],
    ["absolute sibling", ["/work/repo/sibling.json"], [], false],
    ["absolute external", ["/outside/**/report.json"], [], false],
    ["absolute lookalike", ["/work/repo-other/**/report.json"], [], false],
    ["absolute odd bang", ["!/work/**/report.json"], [], false],
    ["absolute even bang", ["!!/work/**/report.json"], [], true],
    ["relative odd bang", ["!../report.json"], [], false],
    ["relative even bang", ["!!../report.json"], [], true],
    ["relative extglob", ["../@(report|sibling).json"], [], true],
    ["empty positives", [], [], false],
  ] as const)("keeps RQ009 native collector %s domain", (_row, values, excludes, expected) => {
    expect(referenceMatches("/work/repo", "pkg/config.ts", { kind: "collector", values: [...values],
      excludes: [...excludes], base: "/work/repo/pkg", dot: true, unresolved: false }, ["report.json"]))
      .toBe(expected);
  });

  it.each([false, true])("keeps RQ009 private/report dot and unresolved decisions with dot=%s", dot => {
    const reference = { kind: "collector" as const, values: ["/work/**/*.json"], excludes: [], base: "/work/repo/pkg", dot, unresolved: false };
    expect(referenceMatches("/work/repo", "pkg/config.ts", reference, [".closedloop-ai/vibe-plans/retained.json"])).toBe(dot);
    expect(referenceMatches("/work/repo", "pkg/config.ts", reference, [".vitest/blob/report.json"])).toBe(dot);
    expect(referenceMatches("/work/repo", "pkg/config.ts", { ...reference, values: [], unresolved: true }, ["report.json"])).toBe(true);
  });

  it.each([
    ["RQ008 opaque aggregate", undefined, false],
    ["RQ008 rooted unknown fields", "function reader(dir,name){readFileSync(join(root,dir,name));}", false],
    ["RQ008 rooted type suffix", "function reader(dir,name){readFileSync(join(root,dir,`${name}.json`));}", false],
    ["RQ008 rooted namespace", "function reader(name){readFileSync(join(root,'.closedloop-ai','vibe-plans',name));}", true],
    ["RQ008 rooted report directory", "function reader(name){readFileSync(join(root,'.vitest','blob',name));}", true],
    ["RQ008 rooted specific name", "function reader(dir){readFileSync(join(root,dir,'acceptance-test-checkpoint.json'));}", true],
    ["RQ008 rooted specific stem", "function reader(dir,name){readFileSync(join(root,dir,`acceptance-test-${name}.json`));}", true],
    ["RQ008 rooted mixed targets", "function target(){if(flag)return join(root,dir,name);return join(root,'.closedloop-ai','vibe-plans',name);}readFileSync(target());", true],
    ["RQ008 rooted sibling", "function reader(name){readFileSync(join(root,'.closedloop-ai','settings',name));}", false],
    ["RQ008 root lookalike", "function reader(dir,name){readFileSync(join(root+'-other',dir,name));}", false],
    ["RQ008 outside root", "function reader(dir,name){readFileSync(join('/outside-checkout',dir,name));}", false],
    ["RQ008 lookalike uncertain namespace", "function reader(name){readFileSync(join(root+'-other','../'+root.split('/').at(-1),'.closedloop-ai','vibe-plans',name));}", true],
    ["RQ008 module import", "import '../../.closedloop-ai/vibe-plans/probes/retained.test.tsx';", true],
    ["RQ008 missing module import", "import '../../.closedloop-ai/vibe-plans/missing.json';", true],
    ["RQ008 URI rooted unknown", "function reader(dir,name){readFileSync(new URL(join(root,dir,name),import.meta.url));}", false],
    ["RQ008 URI rooted private", "function reader(name){readFileSync(new URL(join(root,'.closedloop-ai','vibe-plans',name),import.meta.url));}", true],
    ["RQ008 rooted extension glob", "import.meta.glob('**/*.json',{exhaustive:true});", true],
  ] as const)("classifies %s without using common-root containment as reference identity", (row, body, blocked) => {
    const example = body === undefined ? opaqueExample("scripts/coverage/aggregate.mjs") : undefined;
    const prefix = "import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {readFileSync} from 'node:fs';const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));";
    const value = setup(example?.path ?? "apps/app/reference.test.ts", example?.content ?? prefix + body);
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic comparison-root boundary"]);
    value.write(".vitest/blob/blob.json", "{\"retainedFailure\":true}\n");
    const result = row === "RQ008 rooted report directory" ? selectedReportFixture(value, "apps/app/reference.test.ts") : readiness(value);
    expect(result.status, `${row}: ${result.stdout}`).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/(?:private|retained report)/i);
      if (row === "RQ008 rooted report directory") expectNoReportCheck(value);
      else expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } else expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
    if (row !== "RQ008 rooted report directory") expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json"), "utf8"))
      .toBe("{\"retainedDiagnostic\":true}\n");
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8"))
      .toBe("{\"retainedFailure\":true}\n");
  }, 30000);

  it.each([
    ["RQ007 opaque generic Source reader", undefined, false],
    ["RQ007 generic typed suffix", "import path from 'node:path';import {readFileSync} from 'node:fs';function reader(dir,name){readFileSync(path.join(dir,`${name}.json`));}", false],
    ["RQ007 fully unconstrained", "import {readFileSync} from 'node:fs';function reader(value){readFileSync(value);}", false],
    ["RQ007 known sibling", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.closedloop-ai/settings/${name}.json`);", false],
    ["RQ007 private namespace", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.closedloop-ai/vibe-plans/${name}.json`);", true],
    ["RQ007 report directory", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.vitest/blob/${name}.json`);", true],
    ["RQ007 specific checkpoint basename", "import {readFileSync} from 'node:fs';readFileSync(`${base}/acceptance-test-checkpoint.json`);", true],
    ["RQ007 specific checkpoint stem", "import {readFileSync} from 'node:fs';readFileSync(`${base}/acceptance-test-${name}.json`);", true],
    ["RQ007 specific dotfile stem", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.acceptance-${name}.json`);", true],
    ["RQ007 mixed generic and private", "import {readFileSync} from 'node:fs';function target(){if(flag)return `${base}/${name}.json`;return `${base}/.closedloop-ai/vibe-plans/${name}`;}readFileSync(target());", true],
    ["RQ007 missing private import", "import '../../.closedloop-ai/vibe-plans/missing.json';", true],
    ["RQ007 extension glob", "import.meta.glob('**/*.json',{exhaustive:true});", true],
  ] as const)("classifies %s with both private and retained report candidates present", (row, body, blocked) => {
    const example = body === undefined ? opaqueExample("apps/desktop/test/activity-log-store.test.ts") : undefined;
    const value = setup(example?.path ?? "apps/app/reference.test.ts", example?.content ?? body ?? "");
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic generic reference boundary"]);
    value.write(".vitest/blob/blob.json", "{\"retainedFailure\":true}\n");
    value.write(".closedloop-ai/vibe-plans/.acceptance-test.json", "{\"retainedDiagnostic\":true}\n");
    const result = row === "RQ007 report directory" ? selectedReportFixture(value, "apps/app/reference.test.ts") : readiness(value);
    expect(result.status, `${row}: ${result.stdout}`).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/(?:private|retained report)/i);
      if (row === "RQ007 report directory") expectNoReportCheck(value);
      else expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } else expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
    if (row !== "RQ007 report directory") expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json"), "utf8"))
      .toBe("{\"retainedDiagnostic\":true}\n");
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8"))
      .toBe("{\"retainedFailure\":true}\n");
  }, 30000);

  it.each([
    "apps/api/__tests__/unit/request-error-code-inventory.test.ts",
    "apps/desktop/test/context-pack-materialization.test.ts",
  ])("does not invent a private reference from the exact Source TEST example %s", (path) => {
    const example = opaqueExample(path);
    const value = setup(example.path, example.content);
    const result = readiness(value);
    expect(result.status, result.stdout).toBe(0);
    expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json"), "utf8"))
      .toBe("{\"retainedDiagnostic\":true}\n");
    expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
  }, 30000);

  it.each([
    ["RS02 mixed positive", "import.meta.glob(['./public/*.ts','../../.closedloop-ai/vibe-plans/**/*.tsx','!./public/*.ts']);", true],
    ["RS03 excluded private", "import.meta.glob(['../../.closedloop-ai/vibe-plans/**/*.tsx','!../../.closedloop-ai/vibe-plans/**']);", false],
    ["RS03 negative only", "import.meta.glob(['!**/*.test.ts']);", false],
    ["RS04 importer relative", "import.meta.glob('../../.closedloop-ai/vibe-plans/**/*.tsx');", true],
    ["RS04 exhaustive false", "import.meta.glob('**/*.tsx');", false],
    ["RS04 exhaustive true", "import.meta.glob('**/*.tsx',{exhaustive:true});", true],
    ["RS04 base", "import.meta.glob('./probes/*.tsx',{base:'../../.closedloop-ai/vibe-plans'});", true],
    ["RS05 unresolved alias", "import.meta.glob('@private/*.tsx');", true],
    ["RS05 unresolved options", "import.meta.glob('./public/*.ts',options);", true],
    ["RS05 mixed dynamic member", "import.meta.glob(['./public/*.ts',unknownPattern]);", true],
    ["RS05 unknown current Vite option", "import.meta.glob('./public/*.ts',{caseSensitive:unknown});", true],
    ["RS07 split private", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.join(base,'.closedloop-ai','vibe-plans','probes','retained.test.tsx'));", true],
    ["RS08 join absolute fragment", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.join('public','/.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", false],
    ["RS08 resolve absolute reset", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.resolve('../../.closedloop-ai/vibe-plans','/public/sibling.txt'));", false],
    ["RS08 normalized private", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.join('../','../','.closedloop-ai/settings','../vibe-plans/probes/retained.test.tsx'));", true],
    ["RS09 encoding role", "import {readFileSync} from 'node:fs';readFileSync('./public.txt','.closedloop-ai/vibe-plans/probes/retained.test.tsx');", false],
    ["RS10 renamed builtin", "import {join as concat} from 'node:path';import {readFileSync as load} from 'node:fs';const target=concat('../..','.closedloop-ai','vibe-plans','probes','retained.test.tsx');load(target);", true],
    ["RS10 cycle relevant", "import path from 'node:path';import {readFileSync} from 'node:fs';const loop=loop;readFileSync(path.join(loop,'.closedloop-ai','vibe-plans','probes','retained.test.tsx'));", true],
    ["RS10 shadowed base", "import path from 'node:path';import {readFileSync} from 'node:fs';const base='./public';function reader(base){readFileSync(path.join(base,'.closedloop-ai','vibe-plans','probes','retained.test.tsx'));}", true],
    ["RS10 URL reader", "import {readFileSync} from 'node:fs';readFileSync(new URL('../../.closedloop-ai/vibe-plans/probes/retained.test.tsx',import.meta.url));", true],
    ["RS10 unresolved path factory", "import {readFileSync} from 'node:fs';readFileSync(makePath('../../.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", true],
    ["RS10 unresolved path alias", "import {join as combine} from 'unresolved-path-owner';import {readFileSync} from 'node:fs';readFileSync(combine(base,'.closedloop-ai','vibe-plans','probes','retained.test.tsx'));", true],
    ["RS10 URL bound target", "import {readFileSync} from 'node:fs';readFileSync(new URL('file://'+process.cwd()+'/.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", true],
    ["RS10 URL bound sibling", "import {readFileSync} from 'node:fs';readFileSync(new URL('file://'+process.cwd()+'/.closedloop-ai/settings/current.json'));", false],
    ["RS10 template private prefix", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.closedloop-ai/vibe-plans/${name}`);", true],
    ["RS10 template sibling prefix", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.closedloop-ai/settings/${name}`);", false],
    ["RQ002 cwd fs relative", "import {readFileSync} from 'node:fs';readFileSync('./.closedloop-ai/vibe-plans/probes/retained.test.tsx');", true],
    ["RQ002 cwd resolve", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.resolve('.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", true],
    ["RQ002 cwd sibling", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.resolve('.closedloop-ai/settings/current.json'));", false],
    ["RQ002 ambient temp", "import path from 'node:path';import os from 'node:os';import {readFileSync} from 'node:fs';readFileSync(path.join(os.tmpdir(),'.closedloop-ai','vibe-plans','probes','retained.test.tsx'));", true],
    ["RQ002 encoded URL alias", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('../../.closedloop-ai/%76ibe-plans/probes/retained.test.tsx',import.meta.url));", true],
    ["RQ002 nested URL base", "import {readFileSync} from 'node:fs';readFileSync(new URL('vibe-plans/probes/retained.test.tsx',new URL('../../.closedloop-ai/',import.meta.url)));", true],
    ["RQ002 encoded URL sibling", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('../../.closedloop-ai/%73ettings/current.json',import.meta.url));", false],
    ["RQ002 ordinary encoded string", "import {readFileSync} from 'node:fs';readFileSync('../../.closedloop-ai/%76ibe-plans/probes/retained.test.tsx');", false],
    ["RQ002 conditional helper", "import path from 'node:path';import {readFileSync} from 'node:fs';function getPath(){if(flag)return path.join(process.cwd(),'.closedloop-ai/vibe-plans/probes/retained.test.tsx');return '/public/sibling';}readFileSync(getPath());", true],
    ["RQ002 conditional URL helper", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function getPath(){if(flag)return new NodeURL('../../.closedloop-ai/%76ibe-plans/probes/retained.test.tsx',import.meta.url);return '/public/sibling';}readFileSync(getPath());", true],
    ["RQ002 simple helper", "import {readFileSync} from 'node:fs';function getPath(){return '/public/sibling';}readFileSync(getPath());", false],
    ["RQ002 nested unrelated helper", "import {readFileSync} from 'node:fs';function getPath(){function unused(){return '.closedloop-ai/vibe-plans/probes/retained.test.tsx';}return '/public/sibling';}readFileSync(getPath());", false],
    ["RQ003 shadowed dirname parameter", "import path from 'node:path';import {readFileSync} from 'node:fs';function reader(__dirname){readFileSync(path.join(__dirname,'.closedloop-ai/vibe-plans/probes/retained.test.tsx'));}", true],
    ["RQ003 shadowed dirname local", "import path from 'node:path';import {readFileSync} from 'node:fs';const __dirname=process.cwd();readFileSync(path.join(__dirname,'.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", true],
    ["RQ003 true dirname private", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.join(__dirname,'../..','.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", true],
    ["RQ003 true dirname sibling", "import path from 'node:path';import {readFileSync} from 'node:fs';readFileSync(path.join(__dirname,'public/sibling.txt'));", false],
    ["RQ003 symbolic encoded URL", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('file://'+process.cwd()+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));", true],
    ["RQ003 unknown URL base", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('../../.closedloop-ai/%76ibe-plans/probes/retained.test.tsx',base));", true],
    ["RQ003 symbolic URL sibling", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('file://'+process.cwd()+'/.closedloop-ai/%73ettings/current.json'));", false],
    ["RQ003 concrete unsupported URL", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('https://example.invalid/.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", false],
    ["RQ003 explicit URL converter private", "import {fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(convert('file://'+process.cwd()+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));", true],
    ["RQ003 explicit URL converter sibling", "import {fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(convert('file://'+process.cwd()+'/.closedloop-ai/%73ettings/current.json'));", false],
    ["RQ004 unsupported converter scheme", "import {fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(convert('https://example.invalid/.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", false],
    ["RQ004 unsupported converter host", "import {fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(convert('file://example.invalid/.closedloop-ai/vibe-plans/probes/retained.test.tsx'));", false],
    ["RQ005 unknown directory URL", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){readFileSync(new NodeURL('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));}", true],
    ["RQ005 unknown directory converter", "import {fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){readFileSync(convert('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));}", true],
    ["RQ005 unknown directory sibling", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){readFileSync(new NodeURL('file://'+base+'/.closedloop-ai/%73ettings/current.json'));}", false],
    ["RQ005 ordinary unknown URI string", "import {readFileSync} from 'node:fs';function reader(base){readFileSync('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx');}", false],
    ["RQ006 converter const URL", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){const target=convert(new NodeURL('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));readFileSync(new NodeURL(target,import.meta.url));}", true],
    ["RQ006 converter helper URL", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){function target(){return convert(new NodeURL('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));}readFileSync(new NodeURL(target(),import.meta.url));}", true],
    ["RQ006 converter resolve URL", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import path from 'node:path';import {readFileSync} from 'node:fs';function reader(base){const target=convert(new NodeURL('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));readFileSync(new NodeURL(path.resolve(target),import.meta.url));}", true],
    ["RQ006 converter URL sibling", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){const target=convert(new NodeURL('file://'+base+'/.closedloop-ai/%73ettings/current.json'));readFileSync(new NodeURL(target,import.meta.url));}", false],
    ["RQ006 converter URL unsupported base", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){const target=convert(new NodeURL('file://'+base+'/.closedloop-ai/%76ibe-plans/probes/retained.test.tsx'));readFileSync(new NodeURL(target,'https://example.invalid/base/'));}", false],
    ["RS11 direct private import", "import '../../.closedloop-ai/vibe-plans/probes/retained.test.tsx';", true],
    ["RS11 missing private", "import '../../.closedloop-ai/vibe-plans/probes/not-yet-present.ts';", true],
    ["RS11 sibling settings", "import '../../.closedloop-ai/settings/current.json';", false],
    ["RS12 non-Vite method", "const receiver={glob(){}};receiver.glob('**/*.tsx');", true],
  ] as const)("classifies %s at the actual input-readiness caller", (_row, body, blocked) => {
    const value = setup("apps/app/reference.test.ts", body);
    const result = readiness(value);
    expect(result.status, result.stdout).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/private.*(?:import|reader|collector)/i);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    }
    expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/probes/retained.test.tsx"), "utf8"))
      .toBe("throw new Error('private evidence must not execute');\n");
  }, 30000);

  it("RS13 blocks a complete retained-report target through the shared expression owner", () => {
    const value = setup("apps/app/reference.test.ts", "import path from 'node:path';import {readFileSync as load} from 'node:fs';load(path.join('../..','.vitest','blob','blob.json'));");
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic retained report"]);
    value.write(".vitest/blob/blob.json", "{\"retainedFailure\":true}\n");
    const result = selectedReportFixture(value, "apps/app/reference.test.ts");
    expect(result.status, result.stdout).toBe(1);
    expect(String(result.json?.error)).toMatch(/retained report/i);
    expectNoReportCheck(value);
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8")).toBe("{\"retainedFailure\":true}\n");
  }, 30000);

  it.each([
    ["RQ002 report template", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.vitest/blob/${name}`);", true],
    ["RQ011 complete report directory", "import path from 'node:path';import {readFileSync} from 'node:fs';const root=path.resolve(process.cwd());function reader(name){readFileSync(path.join(root,'.vitest','blob',name));}", true],
    ["RQ011 complete report stem", "import path from 'node:path';import {readFileSync} from 'node:fs';const root=path.resolve(process.cwd());function reader(dir,name){readFileSync(path.join(root,dir,`blob${name}.json`));}", true],
    ["RQ011 complete report sibling", "import path from 'node:path';import {readFileSync} from 'node:fs';const root=path.resolve(process.cwd());function reader(name){readFileSync(path.join(root,'.vitest','unrelated',name));}", false],
    ["RQ002 report sibling", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.vitest/unrelated/${name}`);", false],
    ["RQ002 report conditional helper", "import {readFileSync} from 'node:fs';function getPath(){if(flag)return '.vitest/blob/blob.json';return '/public/sibling';}readFileSync(getPath());", true],
    ["RQ002 report conditional URL helper", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function getPath(){if(flag)return new NodeURL('../../.vitest/%62lob/blob.json',import.meta.url);return '/public/sibling';}readFileSync(getPath());", true],
    ["RQ003 report symbolic URL", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('file://'+process.cwd()+'/.vitest/%62lob/blob.json'));", true],
    ["RQ003 report symbolic sibling", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';readFileSync(new NodeURL('file://'+process.cwd()+'/.vitest/%75nrelated/file.json'));", false],
    ["RQ005 report unknown directory URL", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){readFileSync(new NodeURL('file://'+base+'/.vitest/%62lob/blob.json'));}", true],
    ["RQ005 report unknown directory sibling", "import {URL as NodeURL} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){readFileSync(new NodeURL('file://'+base+'/.vitest/%75nrelated/file.json'));}", false],
    ["RQ006 report converter const URL", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){const target=convert(new NodeURL('file://'+base+'/.vitest/%62lob/blob.json'));readFileSync(new NodeURL(target,import.meta.url));}", true],
    ["RQ006 report converter helper URL", "import {URL as NodeURL,fileURLToPath as convert} from 'node:url';import {readFileSync} from 'node:fs';function reader(base){function target(){return convert(new NodeURL('file://'+base+'/.vitest/%62lob/blob.json'));}readFileSync(new NodeURL(target(),import.meta.url));}", true],
  ] as const)("classifies %s without consuming retained report bodies", (_row, body, blocked) => {
    const value = setup("apps/app/reference.test.ts", body);
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic retained report boundary"]);
    value.write(".vitest/blob/blob.json", "{\"retainedFailure\":true}\n");
    const result = selectedReportFixture(value, "apps/app/reference.test.ts");
    expect(result.status, result.stdout).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/retained report/i);
      expectNoReportCheck(value);
    }
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8")).toBe("{\"retainedFailure\":true}\n");
  }, 30000);

  it.each(["href", "url"] as const)("reads a %s-named local whose initializer ends in a .href property access", (name) => {
    // symphony-alpha scripts/lint/affected-test-lanes.ts: `const href = pathToFileURL(path.join(repoRoot, configPath)).href;`.
    // The `.href` member name is not a reference to the local `href`, so it is not a cycle.
    const file = "apps/app/native-member-name.test.ts";
    const value = setup(file, `import path from 'node:path';import{pathToFileURL}from'node:url';const ${name}=pathToFileURL(path.join(process.argv[2],'vitest.config.ts')).href;const target=${name};\n`);
    const constraint = { kind: "path" as const, value: "__VIBE_UNKNOWN_PATH__", base: "runtime" as const,
      possibleOnly: true, unknownPrefix: true, uncertainTerms: [join(value.worktree, "apps/app")] };
    const source = readInputModule(value.worktree, file, { cwd: value.worktree, argv: ["node", file, { constraint }] });
    const result = inputExpressionReference(value.worktree, file, targetInitializer(source));
    expect(result).toMatchObject({ kind: "path", possibleOnly: true });
    const control = setup(file, "import path from 'node:path';import{pathToFileURL}from'node:url';const location=pathToFileURL(path.join(process.argv[2],'vitest.config.ts')).href;const target=location;\n");
    const controlSource = readInputModule(control.worktree, file, { cwd: control.worktree, argv: ["node", file,
      { constraint: { ...constraint, uncertainTerms: [join(control.worktree, "apps/app")] } }] });
    const expected = inputExpressionReference(control.worktree, file, targetInitializer(controlSource));
    expect(JSON.stringify(result).replaceAll(value.worktree, "<root>")).toBe(JSON.stringify(expected).replaceAll(control.worktree, "<root>"));
  }, 30000);
});

function expectNoReportCheck(value: ReturnType<typeof syncFixture>) {
  const calls = value.calls().trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(calls.some(argv => argv[0] === "check:source-gates")).toBe(false);
  expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
}

/** Metadata comes from the same public native-expression producer as actual child argv. */
function alternativeFixture(expression: string, directory = "apps/desktop/playwright-report-e2e") {
  const file = "apps/app/native-alternatives.test.ts";
  const value = setup(file, `import path from 'node:path';import{URL as NodeURL,fileURLToPath as convert}from'node:url';import{operand}from'./operand.mjs';let base='/work/repo';let name='folder';const incoming=path.join(base,${JSON.stringify(directory)},name);const alias=process.argv[2];function aliasHelper(){return alias;}const target=${expression};\n`);
  value.write("apps/app/operand.mjs", "export const operand=process.argv[2];\n");
  value.git(["add", "apps/app/operand.mjs"]); value.git(["commit", "-m", "Synthetic native argument export"]);
  const source = readInputModule(value.worktree, file, { argv: [] });
  let initializer: ts.Expression | undefined;
  for (const statement of source.statements.filter(ts.isVariableStatement)) {
    const declaration = statement.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === "incoming") initializer = declaration.initializer;
  }
  if (!initializer) throw new Error("Missing native constraint source");
  const constraint = inputExpressionReference("/work/repo", file, initializer);
  if (constraint?.kind !== "path") throw new Error("Missing native argument constraint");
  return { value, file, constraint };
}

function targetInitializer(source: ts.SourceFile, name = "target") {
  for (const statement of source.statements.filter(ts.isVariableStatement)) {
    const declaration = statement.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration.initializer;
  }
  throw new Error("Missing native target");
}

/** Both decisions share one parsed source; the last clone alone cannot reach the retained candidate. */
function restorationFixture(domain: "report" | "private", targetOverflow: boolean) {
  const file = "apps/app/native-restoration.test.ts";
  const value = setup(file, "import path from 'node:path';const target=path.join(process.argv[2],'public/sibling.txt');const after=process.argv[2];\n");
  const candidate = domain === "report" ? "apps/desktop/playwright-report-e2e/results.json"
    : ".closedloop-ai/vibe-plans/acceptance-test-checkpoint.json";
  const alternatives = [join(value.worktree, candidate), ...Array.from({ length: targetOverflow ? 30 : 1 },
    (_, index) => join(value.worktree, "public", `choice-${index}.json`))];
  const constraint = { kind: "path" as const, value: "__VIBE_UNKNOWN_PATH__", base: "runtime" as const,
    possibleOnly: true, unknownPrefix: true, uncertainTerms: alternatives };
  const environment = { cwd: value.worktree, argv: ["node", file, { constraint }] };
  const source = readInputModule(value.worktree, file, environment);
  return { value, file, source, environment, candidate };
}
