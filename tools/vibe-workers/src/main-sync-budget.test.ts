import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalMerge, invokeSync, syncFixture } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

// ISS-13321: pinned to the last deploy, every main merge widened the handoff typecheck by all of main's changes
// since then; the session's own diff against the captured main is what it checks, as Biome already does.
describe("production fixed validation budgets", () => {
  it.each(["selected", "empty"] as const)("permits the actually empty affected wrapper but requires %s typecheck of the session's diff against captured main", (pinned) => {
    const value = syncFixture(); fixtures.push(value);
    Object.assign(value.record.vercel, { lastDeployedCommit: value.baseCommit }); value.save();
    finalMerge(value);
    value.write("apps/app/feature.ts", "export const sessionFeature = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Session feature"]);
    value.git(["checkout", "main"]); value.write("apps/web/news.ts", "export const mainChange = true;\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main advanced"]); value.git(["push", "origin", "main"]);
    const mainSha = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "vibe/test"]);
    const original = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", original.replace("if (args.includes('--dry=json')) {", `
if(args[0]==='turbo'&&args[1]==='typecheck'&&args.includes('--dry=json')&&${pinned === "empty"}) {
 process.stdout.write(JSON.stringify({tasks:[]}));process.exit(0);
}
if(args[0]==='typecheck:affected') {process.stdout.write('NOTHING WAS TYPECHECKED; this is NOT coverage\\n');process.exit(0);}
if (args.includes('--dry=json')) {`));
    const publisher = value.start("redeploy", "handoff");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    value.git(["commit", "--no-edit"]);
    const source = value.sourceTurn("handoff");
    try {
      const result = invokeSync(value, "validate", source.context);
      expect(result.status, result.stdout).toBe(pinned === "selected" ? 0 : 1);
      if (pinned === "empty") expect(String(result.json?.error)).toMatch(/Pinned validation selected no tasks/);
    } finally { source.finish(); }
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(receipt.mainSha).toBe(mainSha);
    const calls = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "typecheck:affected")).toBe(true);
    const typechecks = calls.filter((args) => args[0] === "turbo" && args[1] === "typecheck");
    expect(typechecks.length).toBeGreaterThan(0);
    expect(typechecks.every((args) => args.includes(`--filter=...[${mainSha}]`))).toBe(true);
    if (pinned === "selected") {
      expect(typechecks.some((args) => !args.includes("--dry=json"))).toBe(true);
      expect(calls.some((args) => args[0] === "turbo" && args[1] === "test")).toBe(false);
    } else expect(receipt.validation).toBeUndefined();
    expect(receipt.pushedHead).toBeUndefined();
  }, 30000);
});
