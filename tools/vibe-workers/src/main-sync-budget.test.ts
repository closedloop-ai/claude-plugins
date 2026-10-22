import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncFixture, invokeSync } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("production fixed validation budgets", () => {
  it.each(["selected", "empty"] as const)("permits the actually empty affected wrapper but requires %s deployment-pinned typecheck", (pinned) => {
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
    // The deployment-pinned matrix runs only at handoff since build deploys run the commit-hook checks alone.
    const publisher = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    const source = value.sourceTurn("handoff");
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
      expect(calls.some((args) => args[0] === "turbo" && args[1] === "test")).toBe(false);
      const wrapper = receipt.validation.commands.find((item: { argv: string[] }) => item.argv[1] === "typecheck:affected");
      expect(JSON.parse(readFileSync(`${wrapper.log}.selection.json`, "utf8")).tasks).toEqual([]);
      expect(readFileSync(wrapper.log, "utf8")).toContain("NOT coverage");
    } else expect(receipt.validation).toBeUndefined();
    expect(receipt.pushedHead).toBeUndefined();
  }, 30000);
});
