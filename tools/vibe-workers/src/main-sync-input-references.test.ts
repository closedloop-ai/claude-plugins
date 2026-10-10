import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";

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
    const result = readiness(value);
    expect(result.status, `${row}: ${result.stdout}`).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/(?:private|retained report)/i);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } else expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
    expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
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
    const result = readiness(value);
    expect(result.status, `${row}: ${result.stdout}`).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/(?:private|retained report)/i);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } else expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
    expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
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
    const result = readiness(value);
    expect(result.status, result.stdout).toBe(1);
    expect(String(result.json?.error)).toMatch(/retained report/i);
    expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8")).toBe("{\"retainedFailure\":true}\n");
  }, 30000);

  it.each([
    ["RQ002 report template", "import {readFileSync} from 'node:fs';readFileSync(`${base}/.vitest/blob/${name}`);", true],
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
    const result = readiness(value);
    expect(result.status, result.stdout).toBe(blocked ? 1 : 0);
    if (blocked) {
      expect(String(result.json?.error)).toMatch(/retained report/i);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    }
    expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    expect(readFileSync(join(value.worktree, ".vitest/blob/blob.json"), "utf8")).toBe("{\"retainedFailure\":true}\n");
  }, 30000);
});
