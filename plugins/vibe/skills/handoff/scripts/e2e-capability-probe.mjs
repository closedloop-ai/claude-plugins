#!/usr/bin/env node
// Read-only, value-free runtime and prerequisite probe for the verifier's
// private E2E capability evidence. It never launches an E2E scenario.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NO_DISPLAYLESS_ELECTRON, requiredContainerIdentity, RUNNER_HOST, runnerPath, runSelectedRemoteProbe, shellQuote } from "./e2e-tier.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { repositoryLayout } from "../../vibe/scripts/area-paths.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { withStableSource } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { scriptExitCode } = await vibeCore("lib/vibe/scripts/provider.mjs");

const GIB = 1024 ** 3;
const MIN_MEMORY_GIB = 20;
const MIN_DISK_GIB = 64;
const HARNESS_TOOLS = ["dbus-run-session", "xvfb-run", "gnome-keyring-daemon"];
const PROBE_SCRIPT = fileURLToPath(import.meta.url);
const TREE = /^[a-f0-9]{40}$/;

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", errorCode: result.error?.code };
}

function present(worktree, key, env) {
  if (typeof env[key] === "string" && env[key].trim()) return true;
  return (repositoryLayout().e2eEnvFiles ?? []).some((file) => {
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
export function probeE2eCapability({ worktree, commit, run = command, diskGiB, platform = process.platform, env = process.env, host = hostname() }) {
  return withStableSource(worktree, () => {
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
    const secretsSet = Object.fromEntries(requiredContainerIdentity().map((key) => [key, present(worktree, key, env)]));
    const missing = requiredContainerIdentity().filter((key) => !secretsSet[key]);
    const ready = dockerReachable && memoryGiB >= MIN_MEMORY_GIB && freeDiskGiB >= MIN_DISK_GIB;
    const harnessTools = Object.fromEntries(HARNESS_TOOLS.map((tool) => [tool, run("sh", ["-c", `command -v ${tool}`]).status === 0]));
    const displayless = platform === "linux" && Object.values(harnessTools).every(Boolean);
    // Host, tree and location let a gate on another machine bind this probe by Git tree and re-probe here.
    return {
      probedCommit: commit, host, gitTree: git(worktree, ["rev-parse", "--verify", `${commit}^{tree}`]),
      runnerWorktree: realpathSync(git(worktree, ["rev-parse", "--show-toplevel"])), probeScript: PROBE_SCRIPT,
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
  }, { head: commit });
}

/**
 * Re-run this probe on the recorded host through the selected-runner ssh route, at its recorded worktree only
 * while that worktree's HEAD still has `gitTree`. The caller compares the result; this machine is never probed.
 */
export function remoteCapabilityProbe({ host, runnerWorktree, probeScript, gitTree }, runProbe = runSelectedRemoteProbe) {
  if (typeof host !== "string" || !RUNNER_HOST.test(host) || !runnerPath(runnerWorktree) || !runnerPath(probeScript)
    || !probeScript.endsWith("/e2e-capability-probe.mjs") || !TREE.test(gitTree ?? "")) throw new Error("remote capability probe needs a recorded host, worktree, probe script and Git tree");
  const worktree = shellQuote(runnerWorktree);
  const result = runProbe({ host, command: `cd ${worktree} && test "$PWD" = ${worktree} && test "$(git rev-parse 'HEAD^{tree}')" = ${gitTree}`
    + ` && node ${shellQuote(probeScript)} --worktree ${worktree} --head "$(git rev-parse HEAD)" --host ${shellQuote(host)}` });
  const reports = result?.exitCode === 0 && typeof result.output === "string" ? result.output.split(/\r?\n/).flatMap(line => {
    try { const parsed = JSON.parse(line); return parsed?.ok === true && parsed.probe ? [parsed.probe] : []; }
    catch { return []; }
  }) : [];
  if (reports.length !== 1) throw new Error(`remote capability probe on ${host} did not report one probe`);
  return reports[0];
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { worktree: { type: "string" }, head: { type: "string" }, host: { type: "string" } } });
    if (!values.worktree || !/^[a-f0-9]{40}$/.test(values.head ?? "") || (values.host !== undefined && !RUNNER_HOST.test(values.host))) {
      throw new Error("Usage: e2e-capability-probe.mjs --worktree <path> --head <full commit SHA> [--host <ssh name of this machine; default its hostname>]");
    }
    const before = git(values.worktree, ["rev-parse", "HEAD"]);
    if (before !== values.head) throw new Error("Capability probe HEAD does not match the requested commit.");
    const probe = probeE2eCapability({ worktree: values.worktree, commit: before, ...(values.host ? { host: values.host } : {}) });
    if (git(values.worktree, ["rev-parse", "HEAD"]) !== before) throw new Error("Capability probe HEAD moved during the read.");
    process.stdout.write(`${JSON.stringify({ ok: true, probe })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = scriptExitCode(error, 1);
  }
}
