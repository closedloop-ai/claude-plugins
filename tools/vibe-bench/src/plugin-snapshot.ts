import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  const vibeDir = join(snapshotDir, "plugins/vibe");
  const coreDir = join(snapshotDir, "plugins/closedloop-core");
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
  return { sha: expectedSha, vibeDir, coreDir, agentModels: models };
}

/** Archive one exact committed branch tree rather than copying a dirty checkout or cache. */
export function snapshotPluginsAtHead(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  if (execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }).trim()) throw new Error("benchmark-plugin-checkout-dirty");
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  if (actual !== expectedSha) throw new Error("benchmark-plugin-head-moved");
  return archivePlugins(repo, expectedSha, runRoot);
}

/** Archive exact current-main Git objects for the start-to-PR baseline. */
export function snapshotMainPlugins(repo: string, expectedSha: string, runRoot: string): PluginSnapshot {
  const actual = execFileSync("git", ["-C", repo, "rev-parse", "origin/main^{commit}"], { encoding: "utf8" }).trim();
  if (actual !== expectedSha) throw new Error("benchmark-plugin-main-moved");
  return archivePlugins(repo, expectedSha, runRoot);
}
