import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MainSyncError } from "./main-sync-contracts.js";
import { mainSyncFailure } from "./main-sync-failure.js";
import { bundleDirectory } from "./test-fixtures.js";

const LEASE = "4f6c2a7e-1d3b-4c5a-9e8f-0a1b2c3d4e5f";
const OPERATIONAL = /^Main-sync stopped on an operational error \(.+\); preserve the operation and inspect its owned evidence$/;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function thrown(action: () => unknown) {
  try { action(); }
  catch (error) { return error; }
  throw new Error("Expected the action to throw");
}

describe("mainSyncFailure", () => {
  it("keeps a canonical refusal's own status and message", () => {
    expect(mainSyncFailure(new MainSyncError("Input readiness belongs to another owned session", "NEEDS_CHANGE")))
      .toEqual({ status: "NEEDS_CHANGE", error: "Input readiness belongs to another owned session" });
  });

  it("refuses a schema-invalid context by key path and issue code without echoing its values", () => {
    const error = thrown(() => z.object({ context: z.object({ lease: z.string().uuid(), runtime: z.enum(["codex", "claude"]) }).strict() })
      .parse({ context: { lease: `${LEASE}x`, runtime: LEASE } }));
    expect(error).toBeInstanceOf(z.ZodError);
    expect(mainSyncFailure(error)).toEqual({ status: "BLOCKED", error: "Main-sync context or private evidence is invalid "
      + "(schema: context.lease invalid_string, context.runtime invalid_enum_value); preserve the operation and inspect its owned evidence" });
  });

  it("refuses malformed private JSON at its read site without echoing its bytes", () => {
    const error = thrown(() => JSON.parse(`{"lease":"${LEASE}"`));
    expect(error).toBeInstanceOf(SyntaxError);
    const failure = mainSyncFailure(error);
    expect(failure.status).toBe("BLOCKED");
    expect(failure.error).toMatch(/^Main-sync context or private evidence is invalid \(malformed JSON at main-sync-failure\.test\.ts:\d+\); preserve/);
    expect(failure.error).not.toContain(LEASE);
  });

  it("names a missing private file by code, syscall and file name", () => {
    const directory = mkdtempSync(join(tmpdir(), "vibe-failure-"));
    directories.push(directory);
    const failure = mainSyncFailure(thrown(() => lstatSync(join(directory, "vibe-record-turn.lock", "native-owner.json"))));
    expect(failure.status).toBe("BLOCKED");
    expect(failure.error).toMatch(OPERATIONAL);
    expect(failure.error).toContain("Error ENOENT during lstat on native-owner.json at main-sync-failure.test.ts:");
    expect(failure.error).not.toContain(directory);
  });

  it("names a package resolution failure by its code instead of the generic invalid-evidence refusal", () => {
    const directory = mkdtempSync(join(tmpdir(), "vibe-failure-"));
    directories.push(directory);
    execFileSync(process.execPath, ["--eval", "const fs=require('node:fs');fs.mkdirSync('node_modules/husky',{recursive:true});"
      + "fs.writeFileSync('node_modules/husky/package.json',JSON.stringify({name:'husky',version:'9.1.7',type:'module',exports:'./index.js'}));"
      + "fs.writeFileSync('package.json','{}');"], { cwd: directory });
    const error = thrown(() => createRequire(join(directory, "package.json")).resolve("husky/package.json"));
    const failure = mainSyncFailure(error);
    expect(failure.error).toMatch(OPERATIONAL);
    expect(failure.error).toContain("Error ERR_PACKAGE_PATH_NOT_EXPORTED at main-sync-failure.test.ts:");
    expect(failure.error).not.toContain(directory);
  });

  it("names a failed subprocess by its command words and exit without its stderr", () => {
    const error = thrown(() => execFileSync("git", ["ls-remote", join(tmpdir(), `missing-${LEASE}`, "repo.git")], {
      cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }));
    expect(String(error)).toContain(LEASE);
    const failure = mainSyncFailure(error);
    expect(failure.error).toMatch(OPERATIONAL);
    expect(failure.error).toMatch(/\(subprocess git ls-remote exited \d+ at main-sync-failure\.test\.ts:\d+\)/);
    expect(failure.error).not.toContain(LEASE);
  }, 30000);

  it("surfaces the precise reason for an authored operational error", () => {
    expect(mainSyncFailure(new Error("--worktree is required.\nsecond line")).error)
      .toMatch(/^Main-sync stopped on an operational error \(Error: --worktree is required\. at main-sync-failure\.test\.ts:\d+\); /);
    expect(mainSyncFailure("plain string").error).toContain("(non-Error exception)");
  });

  it("reports a missing worktree argument from the main-sync CLI", () => {
    const result = spawnSync(process.execPath, [join(bundleDirectory, "../vibe-sessions.mjs"), "main-sync-inputs"], {
      input: JSON.stringify({ context: { lease: LEASE } }), encoding: "utf8", timeout: 20000 });
    expect(result.status).toBe(1);
    const output = z.object({ ok: z.literal(false), status: z.literal("BLOCKED"), error: z.string() }).parse(JSON.parse(result.stdout));
    expect(output.error).toMatch(/^Main-sync stopped on an operational error \(Error: --worktree is required\. at vibe-sessions\.mjs:\d+\); /);
    expect(result.stdout).not.toContain(LEASE);
  }, 30000);
});
