import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentModels } from "./agent-models.ts";

/** vibe 1.1.69 and later ship their hooks, and the modules those run, in this plugin (ISS-13869). */
const HOOKS_PLUGIN = "vibe-core";

/** Run-owned bytes of the pinned main plugin and its declared core dependency. */
export interface PluginSnapshot {
  sha: string;
  vibeDir: string;
  coreDir: string;
  /** vibe-core, when the pinned tree has it. */
  hooksDir?: string;
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
  hooksDir?: string;
  claudeHooksRoot?: string;
}

function manifestVersion(path: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("eval-release-version-invalid");
  }
  return value.version;
}

/** Whether the tree at `sha` has the vibe-core plugin. */
function hasHooksPlugin(repo: string, sha: string): boolean {
  return spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}:plugins/${HOOKS_PLUGIN}`]).status === 0;
}

/** Claude Code's install layout under `runRoot`: cache roots plus the registry vibe's resolver reads. */
function claudeCacheRoot(runRoot: string, name: string, version: string): string {
  return join(runRoot, "claude-cache", "plugins", "cache", "closedloop-ai", name, version);
}

function writeClaudeRegistry(runRoot: string, roots: Record<string, string | undefined>): void {
  const plugins = Object.fromEntries(Object.entries(roots).filter(([, root]) => root !== undefined)
    .map(([name, root]) => [`${name}@closedloop-ai`, [{ scope: "user", installPath: root, version: basename(root!) }]]));
  writeFileSync(join(runRoot, "claude-cache", "plugins", "installed_plugins.json"), `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
}

/** Archive one exact release and build the cache-shaped direct roots required by Claude migration. */
export function archivePluginRelease(repo: string, ref: string, runRoot: string,
  expectedVersion?: string): PluginReleaseArchive {
  if (!/^[a-f0-9]{40}$/.test(ref) || existsSync(runRoot)) throw new Error("eval-release-input-invalid");
  const sha = execFileSync("git", ["-C", repo, "rev-parse", `${ref}^{commit}`],
    { encoding: "utf8" }).trim();
  if (sha !== ref) throw new Error("eval-release-ref-mismatch");
  mkdirSync(runRoot, { recursive: true });
  const withHooks = hasHooksPlugin(repo, sha);
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha,
    ".claude-plugin/marketplace.json", "plugins/vibe", "plugins/closedloop-core",
    ...(withHooks ? [`plugins/${HOOKS_PLUGIN}`] : []), "CHANGELOG.md"],
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
  const claudeVibeRoot = claudeCacheRoot(runRoot, "vibe", version);
  const coreVersion = manifestVersion(join(coreDir, ".claude-plugin/plugin.json"));
  const claudeCoreRoot = claudeCacheRoot(runRoot, "closedloop-core", coreVersion);
  const hooksDir = withHooks ? realpathSync(join(runRoot, "plugins", HOOKS_PLUGIN)) : undefined;
  const claudeHooksRoot = hooksDir
    ? claudeCacheRoot(runRoot, HOOKS_PLUGIN, manifestVersion(join(hooksDir, ".claude-plugin/plugin.json"))) : undefined;
  for (const [source, root] of [[vibeDir, claudeVibeRoot], [coreDir, claudeCoreRoot], [hooksDir, claudeHooksRoot]]) {
    if (source === undefined || root === undefined) continue;
    mkdirSync(dirname(root), { recursive: true });
    cpSync(source, root, { recursive: true, errorOnExist: true, force: false });
  }
  writeClaudeRegistry(runRoot, { vibe: claudeVibeRoot, "closedloop-core": claudeCoreRoot, [HOOKS_PLUGIN]: claudeHooksRoot });
  if (realpathSync(dirname(claudeVibeRoot)) !== realpathSync(dirname(claudeCacheRoot(runRoot, "vibe", version))) ||
      basename(realpathSync(claudeVibeRoot)) !== version) {
    throw new Error("eval-release-root-layout-invalid");
  }
  return { sha, version, archiveRoot: realpathSync(runRoot), vibeDir, coreDir,
    claudeVibeRoot: realpathSync(claudeVibeRoot), claudeCoreRoot: realpathSync(claudeCoreRoot),
    ...(hooksDir && claudeHooksRoot ? { hooksDir, claudeHooksRoot: realpathSync(claudeHooksRoot) } : {}) };
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
  const claudeVibeRoot = claudeCacheRoot(runRoot, "vibe", expectedVersion);
  const claudeCoreRoot = claudeCacheRoot(runRoot, "closedloop-core", coreVersion);
  const hooksVersion = snapshot.hooksDir ? manifestVersion(join(snapshot.hooksDir, ".claude-plugin/plugin.json")) : undefined;
  const hooksDir = snapshot.hooksDir ? join(runRoot, "plugins", HOOKS_PLUGIN) : undefined;
  const claudeHooksRoot = hooksVersion ? claudeCacheRoot(runRoot, HOOKS_PLUGIN, hooksVersion) : undefined;
  for (const [source, archive, cache] of [
    [snapshot.vibeDir, release.vibeDir, claudeVibeRoot],
    [snapshot.coreDir, release.coreDir, claudeCoreRoot],
    [snapshot.hooksDir, hooksDir, claudeHooksRoot],
  ]) {
    if (source === undefined || archive === undefined || cache === undefined) continue;
    if (existsSync(archive)) rmSync(archive, { recursive: true });
    if (existsSync(cache)) rmSync(cache, { recursive: true });
    mkdirSync(dirname(cache), { recursive: true });
    cpSync(source, archive, { recursive: true, errorOnExist: true, force: false });
    cpSync(source, cache, { recursive: true, errorOnExist: true, force: false });
  }
  if (release.version !== expectedVersion) rmSync(release.claudeVibeRoot, { recursive: true });
  if (oldCoreVersion !== coreVersion) rmSync(release.claudeCoreRoot, { recursive: true });
  if (release.claudeHooksRoot && release.claudeHooksRoot !== claudeHooksRoot && existsSync(release.claudeHooksRoot)) {
    rmSync(release.claudeHooksRoot, { recursive: true });
  }
  writeClaudeRegistry(runRoot, { vibe: claudeVibeRoot, "closedloop-core": claudeCoreRoot, [HOOKS_PLUGIN]: claudeHooksRoot });
  return { ...release, version: expectedVersion, claudeVibeRoot: realpathSync(claudeVibeRoot),
    claudeCoreRoot: realpathSync(claudeCoreRoot),
    ...(hooksDir && claudeHooksRoot ? { hooksDir: realpathSync(hooksDir), claudeHooksRoot: realpathSync(claudeHooksRoot) } : {}) };
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
    "plugins/vibe", "plugins/closedloop-core", ...(hasHooksPlugin(repo, expectedSha) ? [`plugins/${HOOKS_PLUGIN}`] : [])],
  { maxBuffer: 80 * 1024 * 1024 });
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
  return { sha: expectedSha, vibeDir, coreDir, ...snapshotHooksDir(snapshotDir), agentModels: models };
}

/** vibe-core in a snapshot, when the snapshot has it. */
function snapshotHooksDir(snapshotDir: string): { hooksDir?: string } {
  const hooksDir = join(snapshotDir, "plugins", HOOKS_PLUGIN);
  return existsSync(hooksDir) ? { hooksDir: realpathSync(hooksDir) } : {};
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
  for (const name of ["vibe", "closedloop-core", ...(existsSync(join(repo, "plugins", HOOKS_PLUGIN)) ? [HOOKS_PLUGIN] : [])]) {
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
  return { sha: expectedSha, vibeDir, coreDir, ...snapshotHooksDir(snapshotDir), agentModels: models };
}

/** Archive the latest accepted nightly, which may precede documentation-only main commits. */
export function snapshotMainPlugins(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "origin/main^{commit}"],
    { encoding: "utf8" }).trim();
  const ancestry = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", expectedSha, actual]);
  if (ancestry.status !== 0) throw new Error("benchmark-plugin-nightly-not-on-main");
  return archivePlugins(repo, expectedSha, runRoot);
}
