import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncFixture, validateFixture, invokeSync } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("production fixed validation budgets", () => {
  it.each(["selected", "empty"] as const)("permits the actually empty affected wrapper but requires %s deployment-pinned coverage", (pinned) => {
    const value = syncFixture(); fixtures.push(value);
    Object.assign(value.record.vercel, { lastDeployedCommit: value.baseCommit }); value.save();
    value.write("apps/app/absorbed.ts", "export const absorbedFeature = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic feature absorbed by main"]);
    const absorbed = value.git(["rev-parse", "HEAD"]);
    value.git(["push", "origin", "HEAD:main"]);
    const original = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", original.replace("if (args.includes('--dry=json')) {", `
if(args[0]==='turbo'&&args[1]==='typecheck'&&args.includes('--dry=json')&&(${pinned === "empty" ? "true" : `args.includes(${JSON.stringify(`--filter=...[${absorbed}]`)})`})) {
 process.stdout.write(JSON.stringify({tasks:[]}));process.exit(0);
}
if(args[0]==='typecheck:affected') {process.stdout.write('NOTHING WAS TYPECHECKED; this is NOT coverage\\n');process.exit(0);}
if (args.includes('--dry=json')) {`));
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "validate", source.context);
      expect(result.status, result.stdout).toBe(pinned === "selected" ? 0 : 1);
      if (pinned === "empty") expect(String(result.json?.error)).toMatch(/Pinned validation selected no tasks/);
    } finally { source.finish(); }
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    const calls = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "typecheck:affected")).toBe(true);
    const pin = `--filter=...[${value.baseCommit}]`;
    if (pinned === "selected") {
      expect(calls.some((args) => args[0] === "turbo" && args[1] === "typecheck" && args.includes(pin) && !args.includes("--dry=json"))).toBe(true);
      expect(calls.some((args) => args[0] === "turbo" && args[1] === "test" && args.includes(pin) && !args.includes("--dry=json"))).toBe(true);
      const wrapper = receipt.validation.commands.find((item: { argv: string[] }) => item.argv[1] === "typecheck:affected");
      expect(JSON.parse(readFileSync(`${wrapper.log}.selection.json`, "utf8")).tasks).toEqual([]);
      expect(readFileSync(wrapper.log, "utf8")).toContain("NOT coverage");
    } else expect(receipt.validation).toBeUndefined();
    expect(receipt.pushedHead).toBeUndefined();
  }, 30000);

  it("binds affected and last-deployment-pinned aggregate budgets to their distinct actual selections", () => {
    const value = syncFixture(); fixtures.push(value);
    value.write("apps/desktop/src/main/change.ts", "export const desktop = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic earlier Desktop change"]);
    const deployed = value.git(["rev-parse", "HEAD"]);
    Object.assign(value.record.vercel, { lastDeployedCommit: deployed }); value.save();
    value.write("apps/app/later.ts", "export const later = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic later frontend change"]);
    const original = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", original.replace("if (args.includes('--dry=json')) {", `
if(args.includes('--dry=json') && args.includes(${JSON.stringify(`--filter=...[${value.baseCommit}]`)})) {
 process.stdout.write(JSON.stringify({tasks:[{taskId:'desktop#test',package:'desktop'},{taskId:'app#test',package:'app'}]}));process.exit(0);
}
if (args.includes('--dry=json')) {`));
    expect(validateFixture(value).status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    const affected = receipt.validation.commands.find((item: { argv: string[] }) => item.argv[1] === "test:affected");
    const pinned = receipt.validation.commands.find((item: { argv: string[] }) => item.argv[1] === "turbo" && item.argv[2] === "test");
    expect(affected.timeoutMs).toBe((3 * 22 + 3 * 30 + 30) * 60 * 1000);
    expect(pinned.timeoutMs).toBe(3 * 22 * 60 * 1000);
  }, 30000);

  it("records Root's bounded FULL local lint-scripts budget without changing case or CI deadlines", () => {
    const value = syncFixture(); fixtures.push(value);
    value.write("apps/api/change.ts", "export const backend = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic backend scope"]);
    const result = validateFixture(value, "handoff");
    expect(result.status, result.stdout).toBe(0);
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    const full = receipt.validation.commands.find((item: { argv: string[] }) => item.argv.join(" ") === "pnpm test:lint");
    expect(full.timeoutMs).toBe(30 * 60 * 1000);
  }, 30000);
});
