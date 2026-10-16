import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAffectedTestWrapper, invokeSync, syncFixture, selectedReportFixture } from "./main-sync-test-fixtures.js";
import { buildInfoInputFixture, huskyInputFixture } from "./main-sync-input-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

function setupReportCapability(body: string) {
  const value = syncFixture();
  fixtures.push(value);
  value.write("apps/desktop/scripts/verdict.mjs", body);
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\napps/desktop/playwright-report-e2e/\n`);
  value.git(["add", "."]);
  value.git(["commit", "-m", "Synthetic committed report capability"]);
  value.write("apps/desktop/playwright-report-e2e/results.json", "retained failure must remain unchanged\n");
  return value;
}

describe("selected retained-report admission at production readiness", () => {
  it.each([false, true])("keeps global private protection with mixed report capability=%s", (mixed) => {
    const value = setupReportCapability("import {readFileSync} from 'node:fs';readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const marker = join(value.metadata, "private-boundary-child-ran");
    const bootstrapFile = "scripts/fixture-husky.cjs";
    value.write(bootstrapFile, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');\n${readFileSync(join(value.worktree, bootstrapFile), "utf8")}`);
    const privatePath = join(value.worktree, ".closedloop-ai/vibe-plans/retained.json");
    const reportPath = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const reportRead = mixed ? `fs.readFileSync(${JSON.stringify(reportPath)},'utf8');` : "";
    value.write("scripts/private-reader.mjs", `import fs from 'node:fs';${reportRead}fs.readFileSync(${JSON.stringify(privatePath)},'utf8');\n`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic unselected private reader"]);
    value.write(".closedloop-ai/vibe-plans/retained.json", "private fixture must remain unchanged\n");
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/private planning evidence is consumed/i);
      expect(readFileSync(privatePath, "utf8")).toBe("private fixture must remain unchanged\n");
      expect(readFileSync(reportPath, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it.each(["explicit-sibling", "default-retained", "unsupported-commonjs"] as const)("binds the selected reader's %s native operand", (kind) => {
    const value = setupReportCapability("import {readFileSync} from 'node:fs';readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const marker = join(value.metadata, "selected-operand-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const file = kind === "unsupported-commonjs" ? "scripts/operand-reader.cjs" : "scripts/operand-reader.mjs";
    const imports = kind === "unsupported-commonjs"
      ? "const fs=require('node:fs');const path=require('node:path');"
      : "import fs from 'node:fs';import path from 'node:path';";
    value.write(file, `${imports}\nconst target=process.argv[2]?path.resolve(process.argv[2]):${JSON.stringify(retained)};\nfs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(target,'utf8');\n`);
    const operand = kind === "default-retained" ? "" : " package.json";
    value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\nnode ${file}${operand}\nnode scripts/fixture-husky.cjs\n`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic selected native operand"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(kind === "explicit-sibling" ? 0 : 1);
      expect(existsSync(marker)).toBe(kind === "explicit-sibling");
      if (kind !== "explicit-sibling") expect(String(result.json?.error)).toMatch(/selected.*retained report/i);
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it.each(["literal-safe", "selected", "transitive", "unknown"] as const)("preflights %s bootstrap report use before its actual child", (kind) => {
    const value = setupReportCapability("import {readFileSync} from 'node:fs';readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const path = "scripts/fixture-husky.cjs";
    const body = readFileSync(join(value.worktree, path), "utf8");
    const marker = join(value.metadata, "bootstrap-report-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    let prefix = "";
    if (kind === "selected") prefix = `require('node:fs').readFileSync(${JSON.stringify(retained)},'utf8');\n`;
    if (kind === "transitive") {
      value.write("scripts/report-reader.cjs", `require('node:fs').readFileSync(${JSON.stringify(retained)},'utf8');\n`);
      prefix = "require('./report-reader.cjs');\n";
    }
    if (kind === "unknown") prefix = "require('node:fs').readFileSync(process.argv[2],'utf8');\n";
    value.write(path, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');\n${prefix}${body}`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic selected bootstrap reader"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(kind === "literal-safe" ? 0 : 1);
      expect(existsSync(marker)).toBe(kind === "literal-safe" || kind === "unknown");
      if (kind === "unknown") {
        expect(result.json?.error).toBe("Canonical generated-input producer failed: bash .closedloop-ai/loops-setup.sh; preserve private operation evidence");
        expect(result.json?.mainSync).toBeUndefined();
        expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      } else if (kind !== "literal-safe") {
        expect(String(result.json?.error)).toMatch(/selected.*(?:retained report|unresolved reader)/i);
        expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      }
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([
    ["RA01 nonselected default capability", "import {readFileSync} from 'node:fs';import path from 'node:path';const target=process.argv[2]?path.resolve(process.argv[2]):path.join(import.meta.dirname,'..','playwright-report-e2e','results.json');readFileSync(target,'utf8');"],
    ["RA01 nonselected exact retained capability", "import {readFileSync} from 'node:fs';readFileSync('../playwright-report-e2e/results.json','utf8');"],
  ])("preserves reports for %s without claiming that the reader is disjoint", (_row, body) => {
    const value = setupReportCapability(body);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(join(value.worktree, "apps/desktop/playwright-report-e2e/results.json"), "utf8"))
        .toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);
});

describe("canonical bootstrap health is not validation proof", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    "composes RQ012 URI operand converter=%s with retained target=%s", (converter, retainedTarget) => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq012-uri-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    value.write("operand.json/public/sibling.txt", "ordinary URI fixture\n");
    const operand = retainedTarget ? "process.argv[2]" : "path.join(process.argv[2],'public/sibling.txt')";
    const uri = `new NodeURL(${operand},import.meta.url)`;
    const target = converter ? `convert(${uri})` : uri;
    value.write("scripts/data-reader.mjs", `import fs from 'node:fs';import path from 'node:path';import{URL as NodeURL,fileURLToPath as convert}from'node:url';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${target},'utf8');\n`);
    const name = retainedTarget ? "results" : "../../../operand";
    value.write("scripts/driver.mjs", `import path from 'node:path';import{spawnSync}from'node:child_process';let base=process.cwd();let name=${JSON.stringify(name)};const incoming=path.join(base,'apps/desktop/playwright-report-e2e',\`${"${name}"}.json\`);const result=spawnSync('node',['scripts/data-reader.mjs',incoming],{encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n`);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nnode scripts/driver.mjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic native URI operand"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedTarget);
      expect(result.status, result.stdout).toBe(retainedTarget ? 1 : 0);
      if (retainedTarget) expect(String(result.json?.error)).toMatch(/retained report/i);
      else {
        expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(readFileSync(join(value.worktree, "operand.json/public/sibling.txt"), "utf8")).toBe("ordinary URI fixture\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([false, true])("discovers RQ012 imported native operand with retained target=%s", retainedTarget => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq012-imported-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    value.write("operand.json/public/sibling.txt", "ordinary imported fixture\n");
    value.write("scripts/operand.mjs", "export const operand=process.argv[2];\n");
    const target = retainedTarget ? "operand" : "path.join(operand,'public/sibling.txt')";
    value.write("scripts/data-reader.mjs", `import fs from 'node:fs';import path from 'node:path';import{operand}from'./operand.mjs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${target},'utf8');\n`);
    const name = retainedTarget ? "results" : "../../../operand";
    value.write("scripts/driver.mjs", `import path from 'node:path';import{spawnSync}from'node:child_process';let base=process.cwd();let name=${JSON.stringify(name)};const incoming=path.join(base,'apps/desktop/playwright-report-e2e',\`${"${name}"}.json\`);const result=spawnSync('node',['scripts/data-reader.mjs',incoming],{encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n`);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nnode scripts/driver.mjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic imported native operand"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedTarget);
      expect(result.status, result.stdout).toBe(retainedTarget ? 1 : 0);
      if (retainedTarget) expect(String(result.json?.error)).toMatch(/retained report/i);
      else {
        expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(readFileSync(join(value.worktree, "operand.json/public/sibling.txt"), "utf8")).toBe("ordinary imported fixture\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([false, true])("composes RQ012 native operand alternatives with retained target=%s", retainedTarget => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq012-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const child = retainedTarget ? "apps/desktop/playwright-report-e2e/results.json" : "public/sibling.txt";
    value.write("public/sibling.txt", "ordinary committed fixture\n");
    value.write("scripts/data-reader.mjs", `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(path.join(process.argv[2],${JSON.stringify(child)}),'utf8');\n`);
    value.write("scripts/driver.mjs", "import path from 'node:path';import{spawnSync}from'node:child_process';let base=process.cwd();let name='../../..';const incoming=path.join(base,'apps/desktop/playwright-report-e2e',name);const result=spawnSync('node',['scripts/data-reader.mjs',incoming],{encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n");
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nnode scripts/driver.mjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic complete native operand"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedTarget);
      expect(result.status, result.stdout).toBe(retainedTarget ? 1 : 0);
      if (retainedTarget) expect(String(result.json?.error)).toMatch(/retained report/i);
      else {
        expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(readFileSync(join(value.worktree, "public/sibling.txt"), "utf8")).toBe("ordinary committed fixture\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([true, false])("binds RQ011 URI loader at possible runtime root with retained input=%s", retainedInput => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq011-uri-loader-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const child = retainedInput ? "apps/desktop/playwright-report-e2e/results.json" : "package.json";
    value.write("loader.mjs", `import fs from 'node:fs';import {URL as NodeURL} from 'node:url';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(new NodeURL('file://'+process.cwd()+${JSON.stringify("/" + child)}),'utf8');\n`);
    value.write("scripts/loader.mjs", "export {};\n");
    value.write("scripts/harmless.mjs", "export {};\n");
    value.write("scripts/driver.mjs", "import{spawnSync}from'node:child_process';const result=spawnSync('node',['scripts/harmless.mjs'],{env:{...process.env,NODE_OPTIONS:'--import ./loader.mjs'},encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n");
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nDIRECTORY=.\ncd \"$DIRECTORY\"\nnode scripts/driver.mjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic possible root URI loader"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (retainedInput) expect(String(result.json?.error)).toMatch(/retained report/i);
      else {
        expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each(["symbolic-loader", "absolute-loader", "absolute-child-reset", "relative-child-cwd", "private-loader",
    "nonfirst-join", "nonfirst-resolve", "nested-relative-resolve", "nonfirst-private-join", "multislot-join",
    "multislot-private-join"] as const)("binds RQ010 %s runtime context", kind => {
    for (const retainedInput of [true, false]) {
      const value = setupReportCapability("export {};\n");
      const marker = join(value.metadata, "rq010-runtime-loader-ran");
      const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
      const privatePath = ".closedloop-ai/vibe-plans/loader.json";
      const privateInput = ["private-loader", "nonfirst-private-join", "multislot-private-join"].includes(kind);
      if (privateInput) value.write(privatePath, "private fixture must remain unchanged\n");
      let child = "package.json";
      if (retainedInput) child = privateInput ? privatePath : "apps/desktop/playwright-report-e2e/results.json";
      value.write("loader.mjs", "export {};\n");
      let operand = `path.join(process.cwd(),'..',${JSON.stringify(child)})`;
      if (["nonfirst-join", "nonfirst-private-join", "multislot-join", "multislot-private-join"].includes(kind)) {
        const slots = kind.startsWith("multislot") ? 2 : 1;
        const parents = Array.from({ length: slots * (value.worktree.split("/").filter(Boolean).length + 1) }, () => "'..'");
        const possible = Array.from({ length: slots }, () => "process.cwd()");
        operand = `path.join(${JSON.stringify(value.worktree)},${possible.join(",")},${parents.join(",")},${JSON.stringify(child)})`;
      }
      if (kind === "nonfirst-resolve") operand = `path.resolve('/known-prefix',process.cwd(),'..',${JSON.stringify(child)})`;
      if (kind === "nested-relative-resolve") operand = `path.join(path.resolve('.'),'..',${JSON.stringify(child)})`;
      value.write("scripts/loader.mjs", `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${operand},'utf8');\n`);
      value.write("scripts/harmless.mjs", "export {};\n");
      let option = "'--import ./loader.mjs'";
      if (kind === "symbolic-loader") option = "'--import '+base+'loader.mjs'";
      if (kind === "absolute-loader") option = JSON.stringify(`--import ${join(value.worktree, "scripts/loader.mjs")}`);
      let cwd = "";
      if (kind === "absolute-child-reset") cwd = `cwd:${JSON.stringify(join(value.worktree, "scripts"))},`;
      if (kind === "relative-child-cwd") cwd = "cwd:'.',";
      value.write("scripts/driver.mjs", `import{spawnSync}from'node:child_process';let base='./';const result=spawnSync('node',['harmless.mjs'],{${cwd}env:{...process.env,NODE_OPTIONS:${option}},encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n`);
      value.write("scripts/loader-check.sh", "#!/bin/sh\nset -eu\nDIRECTORY=scripts\ncd \"$DIRECTORY\"\nnode driver.mjs\n");
      const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
      pkg.scripts["check:source-gates"] = "sh scripts/loader-check.sh";
      value.write("package.json", JSON.stringify(pkg));
      const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
      value.write("../bin/pnpm", runner.replace("const command = args[0];", "if(args[0]==='check:source-gates'){const r=require('node:child_process').spawnSync('sh',['scripts/loader-check.sh'],{cwd:process.cwd(),encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}\nconst command = args[0];"));
      value.git(["add", "."]); value.git(["commit", "-m", "Synthetic loader runtime context"]);
      const result = selectedReportFixture(value);
      expect(existsSync(marker), `${kind}/${retainedInput}: ${result.stdout}`).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (retainedInput) expect(String(result.json?.error)).toMatch(privateInput ? /private planning/i : /retained report/i);
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      if (privateInput) expect(readFileSync(join(value.worktree, privatePath), "utf8")).toBe("private fixture must remain unchanged\n");
    }
  }, 60000);

  it.each([true, false])("binds RQ010 explicit loader after dynamic cd with retained input=%s", retainedInput => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq010-loader-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const target = retainedInput ? retained : join(value.worktree, "package.json");
    value.write("loader.mjs", "export {};\n");
    value.write("scripts/loader.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`);
    value.write("scripts/harmless.mjs", "export {};\n");
    value.write("scripts/driver.mjs", "import{spawnSync}from'node:child_process';const result=spawnSync('node',['harmless.mjs'],{env:{...process.env,NODE_OPTIONS:'--import ./loader.mjs'},encoding:'utf8'});if(result.error)throw result.error;process.exitCode=result.status;\n");
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nDIRECTORY=scripts\ncd \"$DIRECTORY\"\nnode driver.mjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic explicit loader CWD"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (!retainedInput) expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each(["absolute-literal", "relative-literal", "ancestor-glob", "mixed-positive", "absolute-exclude",
    "relative-exclude", "sibling", "external", "lookalike"].flatMap(kind => [[kind, true], [kind, false]] as const))("binds RQ009 %s collector with private input=%s", (kind, privateInput) => {
    {
      const value = setupReportCapability("export {};\n");
      const marker = join(value.metadata, "rq009-selected-collector-ran");
      const relativeTarget = privateInput ? ".closedloop-ai/vibe-plans/retained.json" : "apps/desktop/playwright-report-e2e/results.json";
      const target = join(value.worktree, relativeTarget);
      if (privateInput) value.write(relativeTarget, "private fixture must remain unchanged\n");
      const blocked = ["absolute-literal", "relative-literal", "ancestor-glob", "mixed-positive"].includes(kind);
      let include = [target];
      let exclude: string[] = [];
      const ancestorPattern = join(value.base, "**", privateInput ? "retained.json" : "results.json");
      if (kind === "relative-literal") include = [relativeTarget];
      if (kind === "ancestor-glob") include = [ancestorPattern];
      if (kind === "mixed-positive") include = [join(value.worktree, "sibling.json"), relativeTarget];
      if (kind === "absolute-exclude") { include = [relativeTarget]; exclude = [ancestorPattern]; }
      if (kind === "relative-exclude") { include = [ancestorPattern]; exclude = [relativeTarget]; }
      if (kind === "sibling") include = [join(value.worktree, "sibling.json")];
      if (kind === "external") include = [join(value.base, "outside", "**", "*.json")];
      if (kind === "lookalike") include = [`${value.worktree}-other/**/*.json`];
      value.write("vitest.config.mjs", `export default {test:{include:${JSON.stringify(include)},exclude:${JSON.stringify(exclude)}}};\n`);
      const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
      pkg.scripts["check:source-gates"] = "vitest run --config vitest.config.mjs";
      value.write("package.json", JSON.stringify(pkg));
      const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
      value.write("../bin/pnpm", runner.replace("const command = args[0];", `const command = args[0];if(command==='check:source-gates')fs.writeFileSync(${JSON.stringify(marker)},'ran');`));
      value.git(["add", "."]); value.git(["commit", "-m", "Synthetic collector domains"]);
      const result = selectedReportFixture(value);
      expect(existsSync(marker), result.stdout).toBe(!blocked);
      expect(result.status, `${kind}/${privateInput}: ${result.stdout}`).toBe(blocked ? 1 : 0);
      if (blocked) expect(String(result.json?.error)).toMatch(privateInput ? /private planning/i : /retained report/i);
      expect(readFileSync(target, "utf8")).toBe(privateInput ? "private fixture must remain unchanged\n" : "retained failure must remain unchanged\n");
    }
  }, 60000);

  it.each(["known-C", "known-dir", "unknown-C", "unknown-dir", "relative-C", "relative-dir",
    "absolute-C", "absolute-dir", "filter", "run", "implicit", "exec-node", "exec-shell", "exec-config", "child-selected"] as const)("binds RQ008 pnpm %s actual selected context", kind => {
    for (const retainedInput of [true, false]) {
      const value = setupReportCapability("export {};\n");
      const marker = join(value.metadata, "rq008-pnpm-context-ran");
      const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
      const target = retainedInput ? retained : join(value.worktree, "package.json");
      const reader = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`;
      value.write("scripts/data-reader.mjs", reader);
      value.write("scripts/runner.sh", "#!/bin/sh\nnode data-reader.mjs\n");
      value.write("scripts/vitest.config.mjs", reader);
      value.write("apps/a/data-reader.mjs", reader);
      value.write("apps/a/package.json", JSON.stringify({ name: "a", scripts: { health: "node data-reader.mjs" } }));
      const exactSelection = kind.endsWith("-C") || kind.endsWith("-dir") || kind === "filter";
      value.write("apps/unused/unused.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
      value.write("apps/unused/package.json", JSON.stringify({ name: "unused", scripts: { [exactSelection ? "health" : "unused"]: "node unused.mjs" } }));
      value.write("scripts/driver.mjs", "import path from 'node:path';import{spawnSync}from'node:child_process';let base=path.join(import.meta.dirname,'../apps/a');const result=spawnSync('pnpm',['run','health'],{cwd:base});if(result.status!==0)process.exitCode=1;\n");
      let setup = "DIRECTORY=.\ncd \"$DIRECTORY\"\n";
      let command = "pnpm run health";
      if (kind.includes("-C") || kind.includes("-dir")) {
        const option = kind.endsWith("-C") ? "-C" : "--dir";
        let directory = "apps/a";
        if (kind.startsWith("known")) setup = "";
        if (kind.startsWith("relative")) { setup = "DIRECTORY=apps\ncd \"$DIRECTORY\"\n"; directory = "a"; }
        if (kind.startsWith("absolute")) { setup = "DIRECTORY=apps/unused\ncd \"$DIRECTORY\"\n"; directory = join(value.worktree, "apps/a"); }
        command = `pnpm ${option} ${JSON.stringify(directory)} run health`;
      } else if (kind === "filter") {
        setup = "DIRECTORY=apps/unused\ncd \"$DIRECTORY\"\n";
        command = "pnpm --filter a run health";
      } else if (kind === "implicit") command = "pnpm health";
      else if (kind.startsWith("exec-")) {
        setup = "DIRECTORY=scripts\ncd \"$DIRECTORY\"\n";
        if (kind === "exec-node") command = "pnpm exec node data-reader.mjs";
        else if (kind === "exec-shell") command = "pnpm exec sh runner.sh";
        else command = "pnpm exec vitest run --config vitest.config.mjs";
      } else if (kind === "child-selected") { setup = ""; command = "node scripts/driver.mjs"; }
      value.write("scripts/contexts.sh", `#!/bin/sh\nset -eu\n${setup}${command}\n`);
      const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
      pkg.scripts.health = "node scripts/data-reader.mjs";
      if (kind === "child-selected") {
        value.write("scripts/nonreport.mjs", "export {};\n");
        pkg.scripts.health = "node scripts/nonreport.mjs";
      }
      pkg.scripts["check:source-gates"] = "sh scripts/contexts.sh";
      value.write("package.json", JSON.stringify(pkg));
      value.write("../bin/vitest", `#!${process.execPath}\nconst{spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,['vitest.config.mjs'],{cwd:process.cwd()});if(result.error)throw result.error;process.exit(result.status??1);\n`);
      chmodSync(join(value.bin, "vitest"), 0o700);
      const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
      const dispatch = `{const child=require('node:child_process');const path=require('node:path');let cwd=process.cwd();let i=0;while(args[i]==='-C'||args[i]==='--dir'||args[i]==='--filter'){if(args[i]==='--filter')cwd=path.join(${JSON.stringify(value.worktree)},'apps/a');else cwd=path.resolve(cwd,args[i+1]);i+=2;}let program;let operands;if(args[i]==='exec'&&['data-reader.mjs','runner.sh','run'].includes(args[i+2])){program=args[i+1];operands=args.slice(i+2);}else if(args[i]==='health'||args[i]==='run'&&args[i+1]==='health'){const words=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')).scripts.health.split(' ');program=words[0];operands=words.slice(1);}else if(args[0]==='check:source-gates'){program='sh';operands=['scripts/contexts.sh'];}if(program){const r=child.spawnSync(program,operands,{cwd,encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}}`;
      value.write("../bin/pnpm", runner.replace("const args = process.argv.slice(2);", `const args = process.argv.slice(2);${dispatch}`));
      value.git(["add", "."]); value.git(["commit", "-m", "Synthetic native pnpm context"]);
      const result = selectedReportFixture(value);
      expect(existsSync(marker), `${kind}/${retainedInput}: ${result.stdout}`).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (retainedInput) expect(String(result.json?.error)).toMatch(/retained report/i);
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    }
  }, 60000);

  it.each(["shell", "config", "config-default", "tsconfig", "child-shell", "child-pnpm"] as const)("binds RQ008 uncertain %s family before its actual child", kind => {
    for (const retainedInput of [true, false]) {
      const value = setupReportCapability("export {};\n");
      huskyInputFixture(value);
      const marker = join(value.metadata, "rq008-family-ran");
      const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
      const target = retainedInput ? retained : join(value.worktree, "package.json");
      const reader = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`;
      value.write("scripts/data-reader.mjs", reader);
      value.write("scripts/runner.sh", "#!/bin/sh\nset -eu\nnode data-reader.mjs\n");
      value.write("scripts/vitest.config.mjs", reader);
      value.write("scripts/tsconfig.json", JSON.stringify({ files: [target] }));
      value.write("../bin/vitest", `#!${process.execPath}\nconst{spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,['vitest.config.mjs'],{cwd:process.cwd(),encoding:'utf8'});if(result.error)throw result.error;process.exit(result.status??1);\n`);
      value.write("../bin/tsc", `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');for(const file of JSON.parse(fs.readFileSync('tsconfig.json','utf8')).files)fs.readFileSync(file,'utf8');\n`);
      chmodSync(join(value.bin, "vitest"), 0o700);
      chmodSync(join(value.bin, "tsc"), 0o700);
      const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
      pkg.scripts.health = "node scripts/data-reader.mjs";
      value.write("package.json", JSON.stringify(pkg));
      const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
      value.write("../bin/pnpm", runner.replace("const args = process.argv.slice(2);", "const args = process.argv.slice(2);if(args[0]==='run'&&args[1]==='health'){const r=require('node:child_process').spawnSync(process.execPath,['scripts/data-reader.mjs'],{cwd:process.cwd(),encoding:'utf8'});if(r.error)throw r.error;process.exit(r.status??1);}"));
      let command = "sh runner.sh";
      if (kind === "config") command = "vitest run --config vitest.config.mjs";
      if (kind === "config-default") command = "vitest run";
      if (kind === "tsconfig") command = "tsc --project tsconfig.json";
      if (kind.startsWith("child-")) {
        const program = kind === "child-shell" ? "sh" : "pnpm";
        const args = kind === "child-shell" ? ["runner.sh"] : ["run", "health"];
        const cwd = kind === "child-shell" ? "path.join(import.meta.dirname)" : "path.join(import.meta.dirname,'..')";
        value.write("scripts/driver.mjs", `import path from 'node:path';import{spawnSync}from'node:child_process';let base=${cwd};const result=spawnSync(${JSON.stringify(program)},${JSON.stringify(args)},{cwd:base});if(result.status!==0)process.exitCode=1;\n`);
        command = "node driver.mjs";
      }
      value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nDIRECTORY=scripts\ncd "$DIRECTORY"\n${command}\n`);
      value.git(["add", "."]); value.git(["commit", "-m", "Synthetic uncertain supported family"]);
      const source = value.sourceTurn("build");
      try {
        const result = invokeSync(value, "inputs", source.context);
        expect(existsSync(marker), `${kind}/${retainedInput}: ${result.stdout}`).toBe(!retainedInput);
        expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
        if (!retainedInput) expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
        expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      } finally { source.finish(); }
    }
  }, 60000);

  it.each([true, false])("preserves RQ007 uncertain-CWD native pnpm lifecycle with retained input=%s", retainedInput => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq007-pnpm-lifecycle-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const target = retainedInput ? retained : join(value.worktree, "package.json");
    value.write("scripts/lifecycle-reader.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`);
    const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
    pkg.scripts.preinstall = "node scripts/lifecycle-reader.mjs";
    value.write("package.json", JSON.stringify(pkg));
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\nDIRECTORY=.\ncd \"$DIRECTORY\"\npnpm install --frozen-lockfile\n");
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const args = process.argv.slice(2);", "const args = process.argv.slice(2);if(args[0]==='install'){const r=require('node:child_process').spawnSync(process.execPath,['scripts/lifecycle-reader.mjs'],{cwd:process.cwd(),encoding:'utf8'});if(r.error)throw r.error;process.exit(r.status??1);}"));
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic uncertain native lifecycle"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker), result.stdout).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (!retainedInput) expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([["absolute-reset", true], ["absolute-reset", false], ["conditional-reset", true], ["conditional-reset", false],
    ["native-cwd", true], ["native-cwd", false], ["native-private", true], ["native-private", false]] as const)("keeps RQ007 %s native context with retained input=%s", (kind, retainedInput) => {
    const value = setupReportCapability("export {};\n");
    const marker = join(value.metadata, "rq007-cwd-consumer-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const privatePath = ".closedloop-ai/vibe-plans/native-cwd.json";
    const native = kind.startsWith("native");
    const child = retainedInput ? kind === "native-private" ? privatePath : "apps/desktop/playwright-report-e2e/results.json" : "package.json";
    const operand = native ? `path.join(process.cwd(),${JSON.stringify(child)})`
      : JSON.stringify(retainedInput ? retained : join(value.worktree, "package.json"));
    const reader = `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${operand},'utf8');\n`;
    if (kind === "native-private") value.write(privatePath, "{\"private\":true}\n");
    let script = `DIRECTORY=scripts\ncd "$DIRECTORY"\n`;
    if (native) script = `DIRECTORY=${JSON.stringify(value.worktree)}\ncd "$DIRECTORY"\n`;
    if (kind === "absolute-reset") {
      value.write("data-reader.mjs", reader);
      script += `cd ${JSON.stringify(value.worktree)}\nnode data-reader.mjs\n`;
    } else {
      value.write("scripts/data-reader.mjs", reader);
      if (kind === "conditional-reset") script += `if false; then\ncd ${JSON.stringify(value.worktree)}\nfi\n`;
      script += native ? "node scripts/data-reader.mjs\n" : "node data-reader.mjs\n";
    }
    value.write("scripts/cwd-check.sh", `#!/bin/sh\nset -eu\n${script}`);
    const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
    pkg.scripts["check:source-gates"] = "bash scripts/cwd-check.sh";
    value.write("package.json", JSON.stringify(pkg));
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const command = args[0];", `if(args[0]==='check:source-gates'){const r=require('node:child_process').spawnSync('bash',['scripts/cwd-check.sh'],{cwd:process.cwd(),encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}\nconst command = args[0];`));
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic RQ007 native CWD context"]);
    const result = selectedReportFixture(value);
    expect(existsSync(marker), result.stdout).toBe(!retainedInput);
    expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
    expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    if (kind === "native-private") expect(readFileSync(join(value.worktree, privatePath), "utf8")).toBe("{\"private\":true}\n");
  }, 30000);

  it.each([["chain", true], ["chain", false], ["chain-cd", true], ["chain-cd", false],
    ["operand", true], ["operand", false], ["operand-alias", true], ["operand-alias", false],
    ["loader", true], ["loader", false], ["loader-symbolic", true], ["loader-symbolic", false],
    ["exports", true], ["exports", false], ["exports-main", true], ["exports-main", false],
    ["exports-conditions", true], ["exports-conditions", false],
    ["exports-require", true], ["exports-require", false], ["exports-subpath", true], ["exports-subpath", false],
    ["chain-dynamic-cd", true], ["chain-dynamic-cd", false],
    ["chain-multiline-cd", true], ["chain-multiline-cd", false], ["chain-relative-cd", true], ["chain-relative-cd", false]] as const)("preserves RQ006 %s selected entry with retained input=%s", (kind, retainedInput) => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "rq006-actual-consumer-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const target = retainedInput ? retained : join(value.worktree, "package.json");
    const reader = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`;
    let setup = "node scripts/fixture-husky.cjs\n";
    if (kind.startsWith("chain")) {
      value.write("scripts/data-reader.mjs", reader);
      value.write("../bin/custom-tool", "#!/bin/sh\nexit 0\n");
      chmodSync(join(value.bin, "custom-tool"), 0o700);
      if (kind === "chain-cd") setup += "cd scripts && custom-tool && node data-reader.mjs 'quoted && argument'\n";
      else if (kind === "chain-dynamic-cd") setup += "DIRECTORY=scripts\ncd \"$DIRECTORY\" && node data-reader.mjs\n";
      else if (kind === "chain-multiline-cd") setup += "DIRECTORY=scripts\ncd \"$DIRECTORY\"\nnode data-reader.mjs\n";
      else if (kind === "chain-relative-cd") {
        value.write("scripts/nested/data-reader.mjs", reader);
        setup += "DIRECTORY=scripts\ncd \"$DIRECTORY\"\ncd nested\nnode data-reader.mjs\n";
      }
      else setup += "custom-tool && node scripts/data-reader.mjs\n";
    } else if (kind.startsWith("operand")) {
      const operand = kind === "operand-alias" ? "const argument=process.argv[2];function target(){return argument;}fs.readFileSync(target(),'utf8');" : "fs.readFileSync(process.argv[2],'utf8');";
      value.write("scripts/data-reader.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');${operand}\n`);
      const child = retainedInput ? "apps/desktop/playwright-report-e2e/results.json" : "package.json";
      value.write("scripts/driver.mjs", `import path from 'node:path';import {spawnSync} from 'node:child_process';let base=${JSON.stringify(value.worktree)};const result=spawnSync('node',['scripts/data-reader.mjs',path.join(base,${JSON.stringify(child)})]);if(result.status!==0)process.exitCode=1;\n`);
      setup += "node scripts/driver.mjs\n";
    } else if (kind.startsWith("loader")) {
      value.write("scripts/loader.mjs", reader);
      value.write("scripts/assert-e2e-results.mjs", "import fs from 'node:fs';fs.readFileSync(process.argv[2],'utf8');\n");
      value.write("scripts/driver.mjs", `import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';const SCRIPT='scripts/assert-e2e-results.mjs';function drive(payload){const dir=mkdtempSync(path.join(tmpdir(),'owned-fixture-'));const file=path.join(dir,'results.json');if(payload!==null){writeFileSync(file,payload);}try{return spawnSync('node',[SCRIPT,file],{cwd:path.join(import.meta.dirname,'..'),env:{...process.env,NODE_OPTIONS:'--import ./scripts/loader.mjs'},encoding:'utf8'});}finally{rmSync(dir,{recursive:true,force:true});}}const result=drive('fresh');if(result.status!==0)process.exitCode=1;\n`);
      if (kind === "loader-symbolic") {
        const file = "scripts/driver.mjs";
        value.write(file, readFileSync(join(value.worktree, file), "utf8")
          .replace("const SCRIPT=", "let base=path.join(import.meta.dirname,'..');const SCRIPT=")
          .replace("NODE_OPTIONS:'--import ./scripts/loader.mjs'", "NODE_OPTIONS:'--import '+path.join(base,'scripts/loader.mjs')"));
      }
      setup += "node scripts/driver.mjs\n";
    } else {
      value.write("packages/a/package.json", JSON.stringify({ name: "@repo/a", type: "module", exports: "./src/index.mjs" }));
      value.write("packages/a/src/index.mjs", reader);
      if (kind === "exports-main") value.write("packages/a/package.json", JSON.stringify({ name: "@repo/a", type: "module", main: "./src/index.mjs" }));
      if (kind === "exports-conditions") {
        value.write("packages/a/src/require.cjs", `const fs=require('node:fs');fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
        value.write("packages/a/package.json", JSON.stringify({ name: "@repo/a", type: "module", exports: { ".": { import: "./src/index.mjs", require: "./src/require.cjs" } } }));
      }
      if (kind === "exports-require") {
        value.write("packages/a/src/index.cjs", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(${JSON.stringify(target)},'utf8');\n`);
        value.write("packages/a/package.json", JSON.stringify({ name: "@repo/a", exports: { ".": { import: "./src/unused.mjs", require: "./src/index.cjs" } } }));
        value.write("packages/a/src/unused.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
      }
      if (kind === "exports-subpath") value.write("packages/a/package.json", JSON.stringify({ name: "@repo/a", type: "module", exports: { "./reader": "./src/index.mjs" } }));
      value.write("packages/unused/package.json", JSON.stringify({ name: "@repo/unused", type: "module", exports: "./src/index.mjs" }));
      value.write("packages/unused/src/index.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
      const file = "scripts/fixture-husky.cjs";
      value.write(file, `${readFileSync(join(value.worktree, file), "utf8")}\nfs.mkdirSync('node_modules/@repo',{recursive:true});fs.symlinkSync(require('node:path').join(process.cwd(),'packages/a'),'node_modules/@repo/a','dir');\n`);
      value.write("scripts/driver.mjs", kind === "exports-require" ? "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);require('@repo/a');\n"
        : kind === "exports-subpath" ? "import '@repo/a/reader';\n" : "import '@repo/a';\n");
      setup += "node scripts/driver.mjs\n";
    }
    value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\n${setup}`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic RQ006 consumer boundary"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker)).toBe(!retainedInput);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      if (retainedInput) expect(String(result.json?.error)).toMatch(/retained report|report execution.*unproved/i);
      else expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each(["root-read", "root-leading", "root-conflicting", "importer-read", "run-pre", "run-post", "run-disabled", "run-unknown", "run-includes", "dev-root", "importer-cwd", "ordinary", "standalone", "ignore"] as const)("binds declared pnpm %s lifecycle before its actual install child", (kind) => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "pnpm-lifecycle-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const blocked = ["root-read", "root-leading", "root-conflicting", "importer-read", "run-pre", "run-post", "run-unknown", "dev-root", "importer-cwd"].includes(kind);
    value.write("pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    value.write("scripts/lifecycle-reader.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    value.write("apps/a/lifecycle-reader.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    value.write("apps/b/lifecycle-reader.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    value.write("apps/a/package.json", JSON.stringify({ name: "a", scripts: { postinstall: kind === "importer-read" ? "node lifecycle-reader.mjs" : "echo ordinary" } }));
    value.write("apps/b/package.json", JSON.stringify({ name: "b", scripts: { postinstall: kind === "ordinary" ? "echo ordinary" : "node lifecycle-reader.mjs" } }));
    const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
    if (kind.startsWith("root-")) pkg.scripts.postinstall = "node scripts/lifecycle-reader.mjs";
    if (kind.startsWith("run-")) {
      pkg.scripts.install = kind === "run-includes" ? "echo preinstall" : "echo ordinary";
      pkg.scripts[kind === "run-post" ? "postinstall" : "preinstall"] = "node scripts/lifecycle-reader.mjs";
    }
    if (kind === "dev-root") pkg.scripts["pnpm:devPreinstall"] = "node scripts/lifecycle-reader.mjs";
    if (kind === "importer-cwd") {
      value.write("same-name.mjs", "export {};\n");
      value.write("apps/a/same-name.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
      pkg.scripts.postinstall = "node same-name.mjs";
      value.write("apps/a/package.json", JSON.stringify({ name: "a", scripts: { postinstall: "node same-name.mjs" } }));
    }
    value.write("package.json", JSON.stringify(pkg));
    let command = "pnpm install --frozen-lockfile";
    if (kind.startsWith("run-")) command = "pnpm run install";
    if (kind === "run-disabled") command = "pnpm --enable-pre-post-scripts=false run install";
    if (kind === "run-unknown") command = "pnpm --enable-pre-post-scripts=unknown run install";
    if (kind === "dev-root") command = "pnpm --dir apps/a --ignore-workspace=false install";
    if (kind === "standalone") command = "pnpm --dir apps/a --ignore-workspace install";
    if (kind === "ignore") command = "pnpm install --ignore-scripts";
    if (kind === "root-leading") command = "pnpm --offline install";
    if (kind === "root-conflicting") command = "pnpm install --ignore-scripts=false --ignore-scripts=true";
    value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\n${command}\nnode scripts/fixture-husky.cjs\n`);
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const args = process.argv.slice(2);", `const args = process.argv.slice(2);if(args.includes('install')){fs.writeFileSync(${JSON.stringify(marker)},'ran');if(${JSON.stringify(blocked)}){fs.readFileSync(${JSON.stringify(retained)},'utf8');}process.exit(0);}`));
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic declared install lifecycle"]);
    const source = value.sourceTurn("build");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(existsSync(marker)).toBe(!blocked);
      expect(result.status, result.stdout).toBe(blocked ? 1 : 0);
      if (blocked) expect(String(result.json?.error)).toMatch(/retained report/i);
      else expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it("refuses retained data in an actual discovery import before the selector child", () => {
    const value = setupReportCapability("export {};\n");
    const marker = join(value.metadata, "report-discovery-child-ran");
    const file = "scripts/lint/affected-test-lanes.ts";
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    value.write(file, `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n${readFileSync(join(value.worktree, file), "utf8")}`);
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const args = process.argv.slice(2);", `const args = process.argv.slice(2);if(args[0]==='exec'&&args[1]==='node')fs.writeFileSync(${JSON.stringify(marker)},'ran');`));
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic discovery report input"]);
    // Owning lane discovery runs only in the handoff matrix.
    const prepare = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); }
    finally { prepare.finish(); }
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "validate", source.context);
      expect(existsSync(marker)).toBe(false);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/retained report/i);
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each([["typecheck", false], ["typecheck", true], ["test", false], ["test", true]] as const)("checks actual selected %s task entries with retained input=%s", (task, retainedInput) => {
    const value = setupReportCapability("export {};\n");
    const marker = join(value.metadata, "selected-task-check-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    value.write("apps/app/package.json", JSON.stringify({ name: "app", scripts: { typecheck: "fixture", test: "fixture", [task]: "node selected-reader.mjs" } }));
    value.write("apps/app/selected-reader.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retainedInput ? retained : join(value.worktree, "package.json"))},'utf8');\n`);
    value.write("apps/unused/package.json", JSON.stringify({ name: "unused", scripts: { [task]: "node retained-reader.mjs" } }));
    value.write("apps/unused/retained-reader.mjs", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const command = args[0];", `const command = args[0];if(command===${JSON.stringify(`${task}:affected`)})fs.writeFileSync(${JSON.stringify(marker)},'ran');`));
    if (task === "test") {
      installAffectedTestWrapper(value);
    }
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic selected task report boundary"]);
    const source = value.sourceTurn("handoff");
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); }
    finally { source.finish(); }
    const prepare = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); }
    finally { prepare.finish(); }
    const validation = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "validate", validation.context);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      expect(existsSync(marker)).toBe(!retainedInput);
      if (retainedInput) expect(String(result.json?.error)).toMatch(/retained report/i);
      else expect(result.json?.mainSync).toMatchObject({ status: "DONE", publicationReady: true });
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { validation.finish(); }
  }, 30000);

  it.each([["direct", false], ["direct", true], ["collected", false], ["collected", true]] as const)("assesses the actual selected %s runner config with retained input=%s", (kind, retainedInput) => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const marker = join(value.metadata, "selected-config-runner-ran");
    const include = kind === "direct" && retainedInput ? "apps/desktop/playwright-report-e2e/results.json" : "apps/app/**/*.test.ts";
    value.write("vitest.config.ts", `export default {test:{include:[${JSON.stringify(include)}],exclude:['apps/app/excluded.test.ts']}};\n`);
    if (kind === "collected") {
      const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
      value.write("apps/app/selected.test.ts", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retainedInput ? retained : join(value.worktree, "package.json"))},'utf8');\n`);
      value.write("apps/app/excluded.test.ts", `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    }
    const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
    pkg.scripts["check:source-gates"] = "vitest run --config vitest.config.ts";
    value.write("package.json", JSON.stringify(pkg));
    const runner = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", runner.replace("const command = args[0];",
      `const command = args[0];if(command==='check:source-gates')fs.writeFileSync(${JSON.stringify(marker)},'ran');`));
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic selected runner config"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
    } finally { source.finish(); }
    const prepare = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); }
    finally { prepare.finish(); }
    const validation = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "validate", validation.context);
      expect(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      expect(existsSync(marker)).toBe(!retainedInput);
      if (retainedInput) expect(String(result.json?.error)).toMatch(/retained report/i);
      else expect(result.json?.mainSync).toMatchObject({ status: "DONE", publicationReady: true });
    } finally { validation.finish(); }
  }, 30000);

  it.each(["missing", "written", "quarantine", "rebound", "escape", "extra-write", "no-finally"] as const)("keeps a same-call %s fixture nonretained and noncoverage", (kind) => {
    const value = setupReportCapability("export {};\n");
    huskyInputFixture(value);
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const marker = join(value.metadata, "same-call-fixture-ran");
    const allowed = ["missing", "written", "quarantine"].includes(kind);
    value.write("scripts/assert-e2e-results.mjs", `import fs from 'node:fs';import path from 'node:path';\nconst target=process.argv[2]?path.resolve(process.argv[2]):${JSON.stringify(retained)};\nif(!fs.existsSync(target))process.exitCode=3;else{fs.readFileSync(target,'utf8');const sibling=path.join(path.dirname(target),'dd-quarantine.json');if(fs.existsSync(sibling))fs.readFileSync(sibling,'utf8');}\n`);
    const target = kind === "rebound" ? `let file=${JSON.stringify(retained)};` : `const file=path.join(dir,${JSON.stringify(kind === "escape" ? "../results.json" : "results.json")});`;
    const extra = kind === "extra-write" ? "writeFileSync(path.join(dir,'../outside.json'),'escaped');" : "";
    const cleanup = kind === "no-finally" ? "" : "finally{rmSync(dir,{recursive:true,force:true});}";
    const invocation = kind === "no-finally" ? "return spawnSync('node',[SCRIPT,file],{encoding:'utf8'});" : `try{return spawnSync('node',[SCRIPT,file],{encoding:'utf8'});}${cleanup}`;
    value.write("scripts/fixture-report.mjs", `import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';\nconst SCRIPT='scripts/assert-e2e-results.mjs';writeFileSync(${JSON.stringify(marker)},'ran');\nfunction drive(payload,quarantine){const dir=mkdtempSync(path.join(tmpdir(),'owned-report-fixture-'));${target}if(payload!==null){writeFileSync(file,payload);}if(quarantine){writeFileSync(path.join(dir,'dd-quarantine.json'),JSON.stringify(quarantine));}${extra}${invocation}}\nconst result=drive(${kind === "missing" ? "null" : "'current fixture'"},${kind === "quarantine" ? "{}" : "undefined"});if(result.status!==${kind === "missing" ? "3" : "0"}){console.error(result.stderr);process.exitCode=1;}\n`);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-report.mjs\nnode scripts/fixture-husky.cjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic same-call report fixture"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(allowed ? 0 : 1);
      expect(existsSync(marker)).toBe(allowed);
      if (allowed) {
        expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      } else {
        expect(String(result.json?.error)).toMatch(/retained report|report\/replay/i);
        expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each(["nested-retained", "nested-replay", "meaningful-unknown"] as const)("refuses %s in otherwise ordinary health before its child", (kind) => {
    const value = setupReportCapability("import fs from 'node:fs';fs.readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const marker = join(value.metadata, "mixed-health-child-ran");
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    value.write("scripts/data-reader.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');fs.readFileSync(process.argv[2],'utf8');\n`);
    let selected = "";
    if (kind === "nested-retained") selected = `import {spawnSync} from 'node:child_process';spawnSync('node',['scripts/data-reader.mjs',${JSON.stringify(retained)}]);`;
    else if (kind === "nested-replay") selected = "import {spawnSync} from 'node:child_process';spawnSync('node',['scripts/assert-e2e-results.mjs']);";
    else selected = "import fs from 'node:fs';import path from 'node:path';fs.readFileSync(path.join(process.argv[2],'apps/desktop/playwright-report-e2e/results.json'),'utf8');";
    value.write("scripts/mixed-health.mjs", selected);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nif [ -f package.json ]; then\nnode scripts/mixed-health.mjs\nfi\nnode scripts/fixture-husky.cjs\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic mixed report consumer"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status).toBe(1);
      expect(String(result.json?.error)).toMatch(/retained report|report\/replay/i);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
    } finally { source.finish(); }
  }, 30000);

  it.each(["import", "read"] as const)("refuses a declared generator's report %s before producing code", (kind) => {
    const value = setupReportCapability("import fs from 'node:fs';fs.readFileSync('../playwright-report-e2e/results.json','utf8');");
    const generated = buildInfoInputFixture(value);
    const path = "apps/desktop/scripts/write-build-info-lib.mjs";
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const marker = join(value.metadata, "report-code-input-ran");
    value.write("apps/desktop/playwright-report-e2e/results.json", '{"retainedFailure":true}\n');
    const original = readFileSync(join(value.worktree, path), "utf8");
    const data = kind === "import" ? `import payload from '../playwright-report-e2e/results.json' with {type:'json'};`
      : `import {readFileSync as readRetained} from 'node:fs';readRetained(${JSON.stringify(retained)},'utf8');`;
    value.write(path, `${data}\nimport {writeFileSync as markProbe} from 'node:fs';markProbe(${JSON.stringify(marker)},'ran');\n${original}\n`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic report-derived generated source"]);
    const before = readFileSync(join(value.worktree, generated.output));
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status).toBe(1);
      expect(readFileSync(join(value.worktree, generated.output))).toEqual(before);
      expect(existsSync(marker)).toBe(false);
      expect(String(result.json?.error)).toMatch(/retained report/i);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("runs ordinary procedural setup without minting coverage or publication from its stdout", () => {
    const value = setupReportCapability("import fs from 'node:fs';fs.readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const marker = join(value.metadata, "ordinary-setup-ran");
    const script = "scripts/fixture-husky.cjs";
    value.write(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');\n${readFileSync(join(value.worktree, script), "utf8")}\nconsole.log('{"coverage":"PASS","commandCount":999}');\n`);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nif [ -f package.json ]; then\nnode scripts/fixture-husky.cjs\nfi\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic ordinary procedural bootstrap"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
      const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
      expect(state.validation).toBeUndefined();
      expect(state.previous).toBeUndefined();
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
    const publisher = value.start("redeploy", "handoff");
    try {
      const prepared = invokeSync(value, "prepare", publisher.context);
      expect(prepared.status, prepared.stdout).toBe(0);
    } finally { publisher.finish(); }
    const next = value.start("redeploy", "handoff");
    try {
      const pushed = invokeSync(value, "push", next.context);
      expect(pushed.status).toBe(1);
      expect(String(pushed.json?.error)).toMatch(/validation proof is missing or stale/i);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    } finally { next.finish(); }
  }, 30000);

  it.each((["import", "require"] as const).flatMap(mode => [
    ...(["literal", "const", "paren", "helper"] as const).flatMap(form => [true, false]
      .map(retainedInput => ({ mode, form: form as string, retainedInput }))),
    { mode, form: "unselected", retainedInput: false },
  ]))("CK001 $mode $form selected relative leaf retained=$retainedInput", ({ mode, form, retainedInput }) => {
    const value = setupReportCapability("import {readFileSync} from 'node:fs';readFileSync('../playwright-report-e2e/results.json','utf8');");
    huskyInputFixture(value);
    const retained = join(value.worktree, "apps/desktop/playwright-report-e2e/results.json");
    const marker = join(value.metadata, "known-module-leaf-ran");
    const extension = mode === "import" ? "mjs" : "cjs";
    const leaf = `scripts/known-leaf.${extension}`;
    const specifier = `./known-leaf.${extension}`;
    const main = `scripts/known-main.${extension}`;
    const header = mode === "import" ? "import {readFileSync,writeFileSync} from 'node:fs';"
      : "const {readFileSync,writeFileSync}=require('node:fs');";
    value.write(leaf, `${header}\nwriteFileSync(${JSON.stringify(marker)},'ran');readFileSync(process.argv[2],'utf8');\n`);
    let binding = "";
    let operand = JSON.stringify(specifier);
    if (form === "helper") {
      binding = `function selected(){return ${JSON.stringify(specifier)};}\n`;
      operand = "selected()";
    } else if (form !== "literal") {
      binding = `const selected=${JSON.stringify(specifier)};\n`;
      operand = form === "paren" ? "(selected)" : "selected";
    }
    const selectedCall = mode === "import" ? `await import(${operand});` : `require(${operand});`;
    value.write(main, `${binding}${selectedCall}\n`);
    if (form === "unselected") {
      value.write("scripts/unselected-retained-leaf.mjs", `import {readFileSync} from 'node:fs';readFileSync(${JSON.stringify(retained)},'utf8');\n`);
    }
    const argument = retainedInput ? retained : join(value.worktree, "package.json");
    value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\nnode ${main} ${JSON.stringify(argument)}\nnode scripts/fixture-husky.cjs\n`);
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic known relative selected module"]);
    const privatePath = join(value.worktree, ".closedloop-ai/vibe-plans/retained.json");
    value.write(".closedloop-ai/vibe-plans/retained.json", "private fixture must remain unchanged\n");
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect.soft(result.status, result.stdout).toBe(retainedInput ? 1 : 0);
      expect.soft(existsSync(marker)).toBe(!retainedInput);
      if (retainedInput) {
        expect.soft(String(result.json?.error)).toMatch(/selected.*retained report/i);
        expect.soft(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      } else {
        expect.soft(result.json?.mainSync).toMatchObject({ phase: "input-readiness", status: "DONE" });
        const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
        expect(state.validation).toBeUndefined();
        expect(state.previous).toBeUndefined();
      }
      expect(readFileSync(retained, "utf8")).toBe("retained failure must remain unchanged\n");
      expect(readFileSync(privatePath, "utf8")).toBe("private fixture must remain unchanged\n");
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    } finally { source.finish(); }
  }, 30000);
});
