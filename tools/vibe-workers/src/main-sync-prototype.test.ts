import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("owned prototype publication", () => {
  it.each(["prototype/test","vibe/test"])("runs canonical prototype checks only as the same writer and admits its share tuple, not an app request (%s)", (branch) => {
    const value = syncFixture();
    fixtures.push(value);
    if (branch !== "vibe/test") value.git(["branch", "-m", branch]);
    const recordFile = join(value.metadata, "vibe-session.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    record.branch = branch;
    if (branch === "vibe/test") record.kind = "prototype";
    record.mode = null;
    record.vercel = null;
    writeFileSync(recordFile, JSON.stringify(record));
    value.write("apps/prototypes/app/p/test/decisions.md", "# Decisions\n- existing decision\n");
    value.write("apps/prototypes/lib/registry.generated.ts", "export const prototypes = [];\n");
    value.write(".claude/skills/prototype-approve/scripts/read-decision-log.mjs",
      "import {readFileSync} from 'node:fs'; if (!readFileSync(process.argv[2], 'utf8').startsWith('# Decisions')) process.exit(1);\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Owned prototype fixture"]);
    // The prototype matrix runs at handoff; a build share runs the commit-hook checks alone.
    const prepare = value.start("share", "handoff");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const source = value.sourceTurn("handoff");
    try { expect(invokeSync(value, "validate", source.context).status).toBe(0); } finally { source.finish(); }
    const calls = value.calls().trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toContainEqual(["--filter", "prototypes", "generate:registry"]);
    expect(calls).toContainEqual(["--filter", "prototypes", "typecheck"]);
    expect(calls).toContainEqual(["--filter", "prototypes", "test"]);
    const share = value.start("share", "handoff");
    try {
      expect(invokeSync(value, "share", share.context).status).toBe(0);
      expect(invokeSync(value, "request", share.context).status).toBe(1);
      expect(invokeSync(value, "push", share.context).status).toBe(0);
      const head = value.git(["rev-parse","HEAD"]);
      record.prototype = { slug:record.slug, deployedCommit:head, verifiedAt:new Date().toISOString(), previewUrl:"https://fixture-proof.vercel.app/p/test" };
      writeFileSync(recordFile,JSON.stringify(record));
      const repeated = invokeSync(value,"share",share.context);
      expect(repeated.json?.mainSync).toMatchObject({alreadyPublished:true,headSha:head});
    } finally { share.finish(); }
  }, 20000);
});
