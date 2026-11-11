import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReportClosure } from "./main-sync-report-closure.js";
import { verifyReportProducerInputs } from "./main-sync-report-inputs.js";
import { verifyPrivateInput } from "./main-sync-private-inputs.js";
import type { ReportExecution } from "./main-sync-report-execution.js";
import { fixture } from "./test-fixtures.js";
import { probeNativeGit } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup() {
  const value = fixture();
  fixtures.push(value);
  const git = (args: string[]) => execFileSync("git", args, { cwd: value.worktree, encoding: "utf8" }).trim();
  const write = (file: string, body: string) => {
    mkdirSync(dirname(join(value.worktree, file)), { recursive: true });
    writeFileSync(join(value.worktree, file), body);
  };
  const commit = () => { git(["add", "."]); git(["commit", "-m", "Committed closure fixture"]); };
  const execution = (): ReportExecution => ({ root: value.worktree, retainedRoot: value.worktree,
    headSha: git(["rev-parse", "HEAD"]), treeSha: git(["rev-parse", "HEAD^{tree}"]),
    owner: "origin-producer", cwd: value.worktree, argv: ["declared-producer-inputs"] });
  return { ...value, git, write, commit, execution };
}

/** Mirrors the acceptance preflight's 3,339 initial inputs plus a finite shared module graph. */
function largeSelection(retainedReader: boolean) {
  const value = setup();
  for (let index = 0; index < 3339; index++) {
    const app = index < 2639 ? "api" : "app";
    const dependency = String(index % 900).padStart(4, "0");
    value.write(`apps/${app}/app/route-${String(index).padStart(4, "0")}.ts`,
      `export { value } from '../../../packages/shared/unit-${dependency}.js';\n`);
  }
  for (let index = 0; index < 900; index++) {
    const body = retainedReader && index === 899
      ? "import {readFileSync} from 'node:fs'; readFileSync('apps/desktop/playwright-report-e2e/results.json','utf8');\n"
      : `export const value = ${index};\n`;
    value.write(`packages/shared/unit-${String(index).padStart(4, "0")}.ts`, body);
  }
  value.write(".gitignore", "apps/desktop/playwright-report-e2e/\n.closedloop-ai/vibe-plans/\n");
  value.commit();
  const report = "apps/desktop/playwright-report-e2e/results.json";
  value.write(report, "stale retained failure\n");
  return { ...value, report };
}

describe("selected closure scale and evidence boundaries", () => {
  it("commits a shared fixture without ambient Git author configuration", () => {
    const value = setup();
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[name];
    execFileSync("git", ["-c", "user.useConfigOnly=true", "commit", "--allow-empty", "-m", "Commit without ambient identity"],
      { cwd: value.worktree, env, stdio: "ignore" });
    expect(execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: value.worktree, env, encoding: "utf8" }).trim())
      .toBe("Fixture <fixture@example.invalid>");
  });

  it("keeps an imported stylesheet as data rather than parsing it as an executable module", () => {
    const value = setup();
    value.write("selected.ts", "import './style.css'; export const value = 1;\n");
    value.write("style.css", ".fixture { color: blue; }\n");
    value.commit();
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["selected.ts"])).not.toThrow();
  });

  it.each([".closedloop-ai/vibe-plans/plan.md", ".closedloop-ai/vibe-plans/plan.mjs"])(
    "still refuses a selected import of committed private planning evidence: %s", plan => {
      const value = setup();
      value.write("selected.ts", `import './${plan}'; export const value = 1;\n`);
      value.write(plan, "export {};\n");
      value.commit();
      expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["selected.ts"]))
        .toThrow(/selected entry is not public committed source/);
    });

  it("accepts 3,339 initial inputs expanding to 4,239 legitimate committed modules", () => {
    const value = largeSelection(false);
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer",
      ["apps/api/app", "apps/app/app"])).not.toThrow();
    expect(readFileSync(join(value.worktree, value.report), "utf8")).toBe("stale retained failure\n");
  }, 120000);

  it("still rejects a selected retained-report reader beyond the former 4,096-entry cutoff", () => {
    const value = largeSelection(true);
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer",
      ["apps/api/app", "apps/app/app"])).toThrow(/Selected committed reader consumes retained report evidence: packages\/shared\/unit-0899.ts/);
    expect(readFileSync(join(value.worktree, value.report), "utf8")).toBe("stale retained failure\n");
  }, 120000);

  it.each(["argv", "cwd"] as const)("keeps distinct native %s contexts for the same module", kind => {
    const value = setup();
    value.write("reader.mjs", "import {readFileSync} from 'node:fs'; import path from 'node:path'; readFileSync(path.resolve(process.argv[2]),'utf8');\n");
    value.commit();
    const safe = { file: "reader.mjs", context: { kind: "known" as const, path: value.worktree }, argv: ["node", "reader.mjs", "results.json"] };
    const retained = kind === "argv"
      ? { ...safe, argv: ["node", "reader.mjs", "apps/desktop/playwright-report-e2e/results.json"] }
      : { ...safe, context: { kind: "known" as const, path: join(value.worktree, "apps/desktop/playwright-report-e2e") } };
    expect(() => verifyReportClosure(value.execution(), [safe])).not.toThrow();
    expect(() => verifyReportClosure(value.execution(), [safe, retained])).toThrow(/consumes retained report evidence/);
  });

  it("keeps a finite bound on distinct execution contexts", () => {
    const value = setup();
    value.write("empty.mjs", "export {};\n");
    value.commit();
    const entries = Array.from({ length: 4097 }, (_, index) => ({ file: "empty.mjs",
      context: { kind: "known" as const, path: value.worktree }, argv: ["node", "empty.mjs", String(index)] }));
    expect(() => verifyReportClosure(value.execution(), entries)).toThrow(/selected closure context bound/);
  }, 120000);

  it("keeps global private-input protection for an unselected consumer", () => {
    const value = setup();
    value.write("selected.mjs", "export {};\n");
    value.write("unselected.mjs", "import {readFileSync} from 'node:fs'; readFileSync('.closedloop-ai/vibe-plans/checkpoint.md','utf8');\n");
    value.write(".gitignore", ".closedloop-ai/vibe-plans/\n");
    value.commit();
    value.write(".closedloop-ai/vibe-plans/checkpoint.md", "private checkpoint must remain unchanged\n");
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["selected.mjs"])).not.toThrow();
    expect(() => verifyPrivateInput(value.worktree, ".closedloop-ai/vibe-plans/checkpoint.md", value.execution().headSha))
      .toThrow(/Private planning evidence is consumed/);
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/checkpoint.md"), "utf8"))
      .toBe("private checkpoint must remain unchanged\n");
  });

  it.each([false, true])("reads the committed tree once for 400 workspace imports (retained reader: %s)", retainedReader => {
    // ISS-12305 readiness: the next-api walk spawned git 8,822 times (a full ls-tree per @repo import, one per module) and took 615 s.
    const value = setup();
    for (let index = 0; index < 400; index++) {
      value.write(`apps/api/app/route-${String(index).padStart(3, "0")}.ts`, "export { value } from '@repo/shared';\n");
    }
    value.write("packages/shared/package.json", JSON.stringify({ name: "@repo/shared", main: "index.ts" }));
    value.write("packages/other/package.json", JSON.stringify({ name: "@repo/other" }));
    value.write("packages/shared/index.ts", retainedReader
      ? "import {readFileSync} from 'node:fs'; export const value = readFileSync('apps/desktop/playwright-report-e2e/results.json','utf8');\n"
      : "export const value = 1;\n");
    value.commit();
    const probe = probeNativeGit(value);
    try {
      const walk = () => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["apps/api/app"]);
      if (retainedReader) expect(walk).toThrow(/Selected committed reader consumes retained report evidence: packages\/shared\/index.ts/);
      else expect(walk).not.toThrow();
      expect(probe.calls().length).toBeLessThanOrEqual(8);
    } finally { probe.restore(); }
  }, 120000);

  /** The shape of symphony-alpha's pixel-core/compare.mjs (#9744): it reads back only the results file it writes into its caller's directory. */
  const ownOutputReader = (directory: string) => [
    "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const RESULTS_FILE = 'results.json';",
    `function previous(outDir) { const path = join(${directory}, RESULTS_FILE); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []; }`,
    "export function compareRuns({ outDir }) { mkdirSync(outDir, { recursive: true }); const results = previous(outDir);",
    "  writeFileSync(join(outDir, RESULTS_FILE), JSON.stringify(results)); return results; }",
    "",
  ].join("\n");

  function retainedReport(module: string) {
    const value = setup();
    value.write("packages/control/src/vibe-shots/pixel-core/compare.mjs", module);
    value.write(".gitignore", "apps/desktop/playwright-report-e2e/\n");
    value.commit();
    value.write("apps/desktop/playwright-report-e2e/results.json", "stale retained failure\n");
    return value;
  }

  it("admits a module that reads back its own results file under its caller's directory", () => {
    const value = retainedReport(ownOutputReader("outDir"));
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["packages/control"])).not.toThrow();
  });

  it("still refuses a reader that names the retained report's directory under an unbound root", () => {
    const value = retainedReport(ownOutputReader("outDir, 'playwright-report-e2e'"));
    expect(() => verifyReportProducerInputs(value.worktree, value.worktree, "origin-producer", ["packages/control"]))
      .toThrow(/Selected committed reader consumes retained report evidence: packages\/control\/src\/vibe-shots\/pixel-core\/compare.mjs/);
  });
});
