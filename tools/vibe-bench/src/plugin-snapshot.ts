import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentModels } from "./agent-models.ts";

/** Run-owned bytes of the pinned main plugin and its declared core dependency. */
export interface PluginSnapshot {
  sha: string;
  vibeDir: string;
  coreDir: string;
  agentModels: Record<string, string>;
}

function archivePlugins(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("benchmark-plugin-sha-invalid");
  const snapshotDir = join(runRoot, "plugin-snapshot");
  if (existsSync(snapshotDir)) throw new Error("benchmark-plugin-snapshot-exists");
  mkdirSync(snapshotDir, { recursive: true });
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", expectedSha,
    "plugins/vibe", "plugins/closedloop-core"], { maxBuffer: 80 * 1024 * 1024 });
  const unpack = spawnSync("tar", ["-xf", "-"], { cwd: snapshotDir, input: archive, encoding: "utf8" });
  if (unpack.status !== 0) throw new Error(`benchmark-plugin-archive-failed:${unpack.stderr ?? "unknown"}`);
  // Native evaluators resolve macOS aliases such as /tmp to /private/tmp in
  // their artifacts. Keep the launch and evidence identity physical too.
  const vibeDir = realpathSync(join(snapshotDir, "plugins/vibe"));
  const coreDir = realpathSync(join(snapshotDir, "plugins/closedloop-core"));
  const vibeManifest = JSON.parse(readFileSync(join(vibeDir, ".claude-plugin/plugin.json"), "utf8")) as {
    name?: string; dependencies?: string[];
  };
  const coreManifest = JSON.parse(readFileSync(join(coreDir, ".claude-plugin/plugin.json"), "utf8")) as { name?: string };
  if (vibeManifest.name !== "vibe" || !vibeManifest.dependencies?.includes("closedloop-core") ||
      coreManifest.name !== "closedloop-core" || !statSync(vibeDir).isDirectory()) {
    throw new Error("benchmark-plugin-snapshot-contract-invalid");
  }
  const models = agentModels(vibeDir);
  writeFileSync(join(snapshotDir, "snapshot.json"), `${JSON.stringify({ sha: expectedSha,
    vibeVersion: JSON.parse(readFileSync(join(vibeDir, ".claude-plugin/plugin.json"), "utf8")).version,
    coreVersion: JSON.parse(readFileSync(join(coreDir, ".claude-plugin/plugin.json"), "utf8")).version,
    agentModels: models,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  sealSnapshotRepository(snapshotDir);
  return { sha: expectedSha, vibeDir, coreDir, agentModels: models };
}

/**
 * Give the run-owned archive a stable Git selection boundary for the shared
 * symlink-confined copier. The synthetic commit contains only bytes already
 * selected from the source tree and never replaces the recorded source SHA.
 */
function sealSnapshotRepository(snapshotDir: string): void {
  execFileSync("git", ["init", "-q", "-b", "snapshot", snapshotDir]);
  execFileSync("git", ["-C", snapshotDir, "add", "."]);
  execFileSync("git", ["-C", snapshotDir, "-c", "user.name=vibe-bench",
    "-c", "user.email=vibe-bench@invalid.local", "commit", "-qm", "Seal benchmark snapshot"]);
  if (execFileSync("git", ["-C", snapshotDir, "status", "--porcelain"],
    { encoding: "utf8" }).trim()) throw new Error("benchmark-plugin-snapshot-dirty");
}

/** Archive one exact committed branch tree rather than copying a dirty checkout or cache. */
export function snapshotPluginsAtHead(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  if (execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }).trim()) throw new Error("benchmark-plugin-checkout-dirty");
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  if (actual !== expectedSha) throw new Error("benchmark-plugin-head-moved");
  return archivePlugins(repo, expectedSha, runRoot);
}

/** Copy the selected tracked and nonignored bytes from an uncommitted push-ready tree. */
export function snapshotPluginsAtWorktree(repo: string, expectedSha: string,
  runRoot: string): PluginSnapshot {
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("benchmark-plugin-sha-invalid");
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  if (actual !== expectedSha) throw new Error("benchmark-plugin-head-moved");
  const snapshotDir = join(runRoot, "plugin-snapshot");
  if (existsSync(snapshotDir)) throw new Error("benchmark-plugin-snapshot-exists");
  mkdirSync(join(snapshotDir, "plugins"), { recursive: true });
  const copier = join(repo, "plugins/vibe/skills/vibe/scripts/tested-head.mjs");
  for (const name of ["vibe", "closedloop-core"]) {
    execFileSync(process.execPath, [copier, "copy", join(repo, "plugins", name),
      join(snapshotDir, "plugins", name)], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  }
  const vibeDir = realpathSync(join(snapshotDir, "plugins/vibe"));
  const coreDir = realpathSync(join(snapshotDir, "plugins/closedloop-core"));
  const vibeManifest = JSON.parse(readFileSync(join(vibeDir, ".claude-plugin/plugin.json"), "utf8")) as {
    name?: string; dependencies?: string[];
  };
  const coreManifest = JSON.parse(readFileSync(join(coreDir, ".claude-plugin/plugin.json"), "utf8")) as {
    name?: string;
  };
  if (vibeManifest.name !== "vibe" || !vibeManifest.dependencies?.includes("closedloop-core") ||
      coreManifest.name !== "closedloop-core") throw new Error("benchmark-plugin-snapshot-contract-invalid");
  const models = agentModels(vibeDir);
  writeFileSync(join(snapshotDir, "snapshot.json"), `${JSON.stringify({ sha: expectedSha,
    mode: "worktree", agentModels: models }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  sealSnapshotRepository(snapshotDir);
  return { sha: expectedSha, vibeDir, coreDir, agentModels: models };
}

/** Archive the latest accepted nightly, which may precede documentation-only main commits. */
export function snapshotMainPlugins(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "origin/main^{commit}"],
    { encoding: "utf8" }).trim();
  const ancestry = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", expectedSha, actual]);
  if (ancestry.status !== 0) throw new Error("benchmark-plugin-nightly-not-on-main");
  return archivePlugins(repo, expectedSha, runRoot);
}
