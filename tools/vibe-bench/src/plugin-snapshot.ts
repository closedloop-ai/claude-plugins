import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentModels } from "./agent-models.ts";

/** Run-owned bytes of the pinned main plugin and its declared core dependency. */
export interface PluginSnapshot {
  sha: string;
  vibeDir: string;
  coreDir: string;
  agentModels: Record<string, string>;
}

/** Immutable released plugin bytes plus the cache-shaped root used by Claude. */
export interface PluginReleaseArchive {
  sha: string;
  version: string;
  archiveRoot: string;
  vibeDir: string;
  coreDir: string;
  claudeVibeRoot: string;
  claudeCoreRoot: string;
}

function manifestVersion(path: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("eval-release-version-invalid");
  }
  return value.version;
}

/** Archive one exact release and build the cache-shaped direct roots required by Claude migration. */
export function archivePluginRelease(repo: string, ref: string, runRoot: string,
  expectedVersion?: string): PluginReleaseArchive {
  if (!/^[a-f0-9]{40}$/.test(ref) || existsSync(runRoot)) throw new Error("eval-release-input-invalid");
  const sha = execFileSync("git", ["-C", repo, "rev-parse", `${ref}^{commit}`],
    { encoding: "utf8" }).trim();
  if (sha !== ref) throw new Error("eval-release-ref-mismatch");
  mkdirSync(runRoot, { recursive: true });
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha,
    ".claude-plugin/marketplace.json", "plugins/vibe", "plugins/closedloop-core", "CHANGELOG.md"],
  { maxBuffer: 80 * 1024 * 1024 });
  const unpack = spawnSync("tar", ["-xf", "-"], { cwd: runRoot, input: archive, encoding: "utf8" });
  if (unpack.status !== 0) throw new Error(`eval-release-archive-failed:${unpack.stderr ?? "unknown"}`);
  const vibeDir = realpathSync(join(runRoot, "plugins/vibe"));
  const coreDir = realpathSync(join(runRoot, "plugins/closedloop-core"));
  const version = manifestVersion(join(vibeDir, ".claude-plugin/plugin.json"));
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new Error("eval-release-version-mismatch");
  }
  const codexVersion = manifestVersion(join(vibeDir, ".codex-plugin/plugin.json"));
  if (codexVersion !== version || !readFileSync(join(runRoot, "CHANGELOG.md"), "utf8")
    .split("\n").includes(`### vibe v${version}`)) throw new Error("eval-release-contract-invalid");
  const claudeVibeRoot = join(runRoot, "claude-cache", "vibe", version);
  const coreVersion = manifestVersion(join(coreDir, ".claude-plugin/plugin.json"));
  const claudeCoreRoot = join(runRoot, "claude-cache", "closedloop-core", coreVersion);
  mkdirSync(join(claudeVibeRoot, ".."), { recursive: true });
  mkdirSync(join(claudeCoreRoot, ".."), { recursive: true });
  cpSync(vibeDir, claudeVibeRoot, { recursive: true, errorOnExist: true, force: false });
  cpSync(coreDir, claudeCoreRoot, { recursive: true, errorOnExist: true, force: false });
  if (realpathSync(join(claudeVibeRoot, "..")) !== realpathSync(join(runRoot, "claude-cache", "vibe")) ||
      basename(realpathSync(claudeVibeRoot)) !== version) {
    throw new Error("eval-release-root-layout-invalid");
  }
  return { sha, version, archiveRoot: realpathSync(runRoot), vibeDir, coreDir,
    claudeVibeRoot: realpathSync(claudeVibeRoot), claudeCoreRoot: realpathSync(claudeCoreRoot) };
}

/** Use the sealed candidate plugin bytes only for the current transition target. */
export function archiveSnapshotTarget(repo: string, ref: string, runRoot: string,
  snapshot: PluginSnapshot, expectedVersion: string): PluginReleaseArchive {
  if (snapshot.sha !== ref || snapshotPluginVersion(snapshot) !== expectedVersion) {
    throw new Error("eval-current-snapshot-identity-invalid");
  }
  const release = archivePluginRelease(repo, ref, runRoot);
  const coreVersion = manifestVersion(join(snapshot.coreDir, ".claude-plugin/plugin.json"));
  const oldCoreVersion = manifestVersion(join(release.coreDir, ".claude-plugin/plugin.json"));
  const claudeVibeRoot = join(runRoot, "claude-cache/vibe", expectedVersion);
  const claudeCoreRoot = join(runRoot, "claude-cache/closedloop-core", coreVersion);
  for (const [source, archive, cache] of [
    [snapshot.vibeDir, release.vibeDir, claudeVibeRoot],
    [snapshot.coreDir, release.coreDir, claudeCoreRoot],
  ]) {
    rmSync(archive, { recursive: true });
    if (existsSync(cache)) rmSync(cache, { recursive: true });
    cpSync(source, archive, { recursive: true, errorOnExist: true, force: false });
    cpSync(source, cache, { recursive: true, errorOnExist: true, force: false });
  }
  if (release.version !== expectedVersion) rmSync(release.claudeVibeRoot, { recursive: true });
  if (oldCoreVersion !== coreVersion) rmSync(release.claudeCoreRoot, { recursive: true });
  return { ...release, version: expectedVersion, claudeVibeRoot: realpathSync(claudeVibeRoot),
    claudeCoreRoot: realpathSync(claudeCoreRoot) };
}

/** Read the candidate version from its sealed plugin snapshot, not the older HEAD manifest. */
export function snapshotPluginVersion(snapshot: PluginSnapshot): string {
  const version = manifestVersion(join(snapshot.vibeDir, ".claude-plugin/plugin.json"));
  if (manifestVersion(join(snapshot.vibeDir, ".codex-plugin/plugin.json")) !== version) {
    throw new Error("eval-current-snapshot-version-mismatch");
  }
  return version;
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
