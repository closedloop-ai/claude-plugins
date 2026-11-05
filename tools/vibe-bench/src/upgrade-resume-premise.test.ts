import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evalCaseCatalog } from "./eval-selection.ts";
import { classifyUpgradeCaseAvailability, runUpgradeResumeCases } from "./upgrade-resume-eval.ts";

const REPO = realpathSync(join(import.meta.dirname, "../../.."));

test("ISS-13720 unchanged case uses the released 1.1.41 writer offline", () => {
  const item = evalCaseCatalog(join(REPO, "plugins/vibe"))
    .find((candidate) => candidate.id === "upgrade-resume-unchanged-definition");
  assert.ok(item?.nightlyPrior);
  assert.equal(item.nightlyPrior.version, "1.1.41");
  const current = readFileSync(join(REPO, "plugins/vibe/agents/vibe-change-worker.md"));
  const targetDigest = createHash("sha256").update(current).digest("hex");
  const availability = classifyUpgradeCaseAvailability({ item,
    priorDigest: item.nightlyPrior.writerDigestSha256, targetDigest });
  assert.equal(availability.available,
    targetDigest === item.nightlyPrior.writerDigestSha256);
  if (!availability.available) assert.match(availability.reason ?? "", /NO_VALID_PRIOR/);
  const writer397 = classifyUpgradeCaseAvailability({ item,
    priorDigest: item.nightlyPrior.writerDigestSha256,
    targetDigest: "5ac2801b399bbd39edd971ba6fca01f9c206bdbf7fd8c9aabbc4fd4f03e06e76" });
  assert.equal(writer397.available, true);
  assert.throws(() => classifyUpgradeCaseAvailability({ item,
    priorDigest: "f".repeat(64), targetDigest }),
  /nightly-prior-digest-mismatch:upgrade-resume-unchanged-definition/);
});

test("ISS-13720 false unchanged premise records unavailable without a model launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-no-valid-prior-"));
  try {
    const repo = join(root, "repo");
    const vibe = join(repo, "plugins/vibe");
    const core = join(repo, "plugins/closedloop-core");
    mkdirSync(join(vibe, ".claude-plugin"), { recursive: true });
    mkdirSync(join(vibe, ".codex-plugin"), { recursive: true });
    mkdirSync(join(vibe, "agents"), { recursive: true });
    mkdirSync(join(core, ".claude-plugin"), { recursive: true });
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    writeFileSync(join(repo, ".claude-plugin/marketplace.json"), "{}\n");
    writeFileSync(join(core, ".claude-plugin/plugin.json"),
      `${JSON.stringify({ name: "closedloop-core", version: "1.6.2" })}\n`);
    const writeVibeVersion = (version: string) => {
      const manifest = `${JSON.stringify({ name: "vibe", version, dependencies: ["closedloop-core"] })}\n`;
      writeFileSync(join(vibe, ".claude-plugin/plugin.json"), manifest);
      writeFileSync(join(vibe, ".codex-plugin/plugin.json"), manifest);
    };
    writeVibeVersion("1.1.39");
    const priorWriter = "---\nname: vibe-change-worker\n---\nprior\n";
    writeFileSync(join(vibe, "agents/vibe-change-worker.md"), priorWriter);
    writeFileSync(join(repo, "CHANGELOG.md"), "### vibe v1.1.39\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=vibe-eval", "-c",
      "user.email=vibe-eval@invalid.local", "commit", "-qm", "prior"]);
    const priorRef = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    writeVibeVersion("1.1.40");
    writeFileSync(join(vibe, "agents/vibe-change-worker.md"), `${priorWriter}changed\n`);
    writeFileSync(join(repo, "CHANGELOG.md"), "### vibe v1.1.40\n\n### vibe v1.1.39\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=vibe-eval", "-c",
      "user.email=vibe-eval@invalid.local", "commit", "-qm", "current"]);
    const currentRef = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    const executable = (name: string, version: string) => {
      const path = join(root, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    };
    const caseId = "upgrade-resume-unchanged-definition";
    const suites = await runUpgradeResumeCases({ repo, pluginSha: currentRef,
      currentSnapshot: { sha: currentRef, vibeDir: realpathSync(vibe),
        coreDir: realpathSync(core), agentModels: {} }, runRoot: join(root, "run"),
      claudeExecutable: executable("claude", "2.1.318 (Claude Code)"),
      codexExecutable: executable("codex", "codex-cli 0.163.0"),
      cases: [{ id: caseId, skill: "vibe", contentHash: "a".repeat(64), deterministic: true,
        kind: "upgrade-resume", definition: "unchanged", nightlyPrior: {
          version: "1.1.39", ref: priorRef,
          writerDigestSha256: createHash("sha256").update(priorWriter).digest("hex"),
        }, transitions: [] }], runtimes: ["claude", "codex"] });
    for (const runtime of ["claude", "codex"] as const) {
      const suite = suites[runtime];
      assert.equal(suite?.passed, 0);
      assert.equal(suite?.failed, 0);
      assert.equal(suite?.unavailable, 1);
      assert.match(suite?.cases[0]?.unavailableReason ?? "", /NO_VALID_PRIOR/);
      assert.equal(existsSync(join(root, "run", runtime, caseId, "attempts")), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
