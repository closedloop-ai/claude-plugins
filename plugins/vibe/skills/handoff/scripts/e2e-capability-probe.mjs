#!/usr/bin/env node
// Read-only, value-free runtime and prerequisite probe for the verifier's
// private E2E capability evidence. It never launches an E2E scenario.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../vibe/scripts/session-record.mjs";
import { NO_DISPLAYLESS_ELECTRON, REQUIRED_CONTAINER_IDENTITY } from "./e2e-tier.mjs";

const GIB = 1024 ** 3;
const MIN_MEMORY_GIB = 20;
const MIN_DISK_GIB = 64;
const ENV_FILES = ["apps/api/.env.local", "apps/app/.env.local"];
const HARNESS_TOOLS = ["dbus-run-session", "xvfb-run", "gnome-keyring-daemon"];

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", errorCode: result.error?.code };
}

function present(worktree, key, env) {
  if (typeof env[key] === "string" && env[key].trim()) return true;
  return ENV_FILES.some((file) => {
    const absolute = path.join(worktree, file);
    if (!existsSync(absolute)) return false;
    return readFileSync(absolute, "utf8").split("\n").some((line) => {
      const found = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      const raw = found?.[1] === key ? found[2].replace(/^(['"])(.*)\1$/, "$2").trim() : "";
      return Boolean(raw && !raw.startsWith("#"));
    });
  });
}

/** Observe Docker, disk, existing identity-key presence and displayless harness without exposing values. */
export function probeE2eCapability({ worktree, commit, run = command, diskGiB, platform = process.platform, env = process.env }) {
  const version = run("docker", ["--version"]);
  const info = run("docker", ["info", "--format", "{{.MemTotal}}"]);
  const dagger = run("dagger", ["version"]);
  // A failed version command can still be an installed CLI. Only ENOENT
  // proves the executable is absent; daemon reachability is a separate fact.
  const dockerPresent = version.errorCode !== "ENOENT";
  const memoryBytes = Number(info.stdout.trim());
  const dockerReachable = dockerPresent && info.status === 0 && Number.isFinite(memoryBytes) && memoryBytes > 0;
  const memoryGiB = dockerReachable ? Number((memoryBytes / GIB).toFixed(1)) : 0;
  const freeDiskGiB = diskGiB ?? (() => {
    const stat = statfsSync(worktree);
    return Number(((Number(stat.bavail) * Number(stat.bsize)) / GIB).toFixed(1));
  })();
  const secretsSet = Object.fromEntries(REQUIRED_CONTAINER_IDENTITY.map((key) => [key, present(worktree, key, env)]));
  const missing = REQUIRED_CONTAINER_IDENTITY.filter((key) => !secretsSet[key]);
  const ready = dockerReachable && memoryGiB >= MIN_MEMORY_GIB && freeDiskGiB >= MIN_DISK_GIB;
  const harnessTools = Object.fromEntries(HARNESS_TOOLS.map((tool) => [tool, run("sh", ["-c", `command -v ${tool}`]).status === 0]));
  const displayless = platform === "linux" && Object.values(harnessTools).every(Boolean);
  return {
    probedCommit: commit,
    container: {
      dockerPresent, dockerReachable, memoryGiB, diskGiB: freeDiskGiB,
      minimumMemoryGiB: MIN_MEMORY_GIB, minimumDiskGiB: MIN_DISK_GIB,
      command: "docker --version; docker info --format {{.MemTotal}}; dagger version; statfs",
      ...(dagger.status === 0 ? { daggerCli: dagger.stdout.trim() } : {}),
      secretsSet, runnable: ready && missing.length === 0,
      ...(ready && missing.length ? { notRunnableReason: `${missing.join(", ")} unset` } : {}),
    },
    desktopHarness: { available: displayless,
      ...(!displayless ? { reason: NO_DISPLAYLESS_ELECTRON } : {}),
      probe: `${platform}; ${HARNESS_TOOLS.map((tool) => `${tool}=${harnessTools[tool]}`).join(", ")}` },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { worktree: { type: "string" }, head: { type: "string" } } });
    if (!values.worktree || !/^[a-f0-9]{40}$/.test(values.head ?? "")) {
      throw new Error("Usage: e2e-capability-probe.mjs --worktree <path> --head <full commit SHA>");
    }
    const before = git(values.worktree, ["rev-parse", "HEAD"]);
    if (before !== values.head) throw new Error("Capability probe HEAD does not match the requested commit.");
    const probe = probeE2eCapability({ worktree: values.worktree, commit: before });
    if (git(values.worktree, ["rev-parse", "HEAD"]) !== before) throw new Error("Capability probe HEAD moved during the read.");
    process.stdout.write(`${JSON.stringify({ ok: true, probe })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
