#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { probeCloudHostRuntime } from "./cloud-validation-host.mjs";
import { runBoundedDetailed } from "../../../skills/vibe/scripts/run-bounded.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const ELECTRON_VERSION = "43.8.4";
const ELECTRON_SMOKE = fileURLToPath(new URL("./cloud-capability-electron.cjs", import.meta.url));
const READINESS_MS = 25_000;
const CAPTURE_BYTES = 7000;
const DEFAULT_DATA_PARENT = "/var/lib";

function result(code, output, reason) {
  return { result: code === 0 ? "YES" : "NO", exitCode: code, output, ...(reason ? { reason } : {}) };
}

function fail(reason, output = "") { return result(null, output, reason); }

async function run(command, args, seconds) {
  try {
    const { code, output } = await runBoundedDetailed(command, args, { seconds, capture: true, captureBytes: CAPTURE_BYTES, drainGroup: true });
    return result(code, output, code === 124 ? "timed out" : null);
  } catch (error) { return fail(error.code ?? error.message); }
}

/** Measure the lane tools the cloud worker shell actually selects: zsh's configured packages and the exact tool versions. */
export async function measureLaneTools(command = run) {
  const probes = [
    // dpkg's own state, not `zsh --version`: an unpacked but unconfigured zsh still runs (r24 left both iU).
    ["zsh", "dpkg-query", ["-W", "-f=${Status}\\n", "zsh", "zsh-common"], /^install ok installed\ninstall ok installed$/],
    ["uv", "uv", ["--version"], /^uv [0-9]+\./],
    ["python313", "uv", ["run", "--offline", "--no-project", "--python", "3.13", "python", "--version"], /^Python 3\.13\.[0-9]+/],
    ["node24", "node", ["--version"], /^v24\.[0-9]+\.[0-9]+/],
    ["pnpm", "pnpm", ["--version"], /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/],
  ];
  const flags = {};
  for (const [name, binary, args, version] of probes) {
    const result = await command(binary, args, 10);
    flags[name] = result.result === "YES" && version.test(result.output.trim());
  }
  return flags;
}

/** Track the one dockerd child this probe created, including an early spawn error or natural exit. */
export function startDockerProbe(args, spawnChild = spawn, pause = sleep) {
  const child = spawnChild("dockerd", args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let terminal = null;
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data) => { output = (output + data).slice(-CAPTURE_BYTES); });
  const done = new Promise((resolve) => {
    const finish = (value) => {
      if (terminal) return;
      terminal = value;
      resolve(value);
    };
    child.once("error", (error) => finish(fail(error.code ?? error.message, output)));
    child.once("close", (code, signal) => finish(result(code, output, signal ? `stopped by ${signal}` : null)));
  });
  const signal = (name) => { if (!terminal && child.pid > 1 && child.exitCode === null && child.signalCode === null) child.kill(name); };
  const forwarded = () => signal("SIGTERM");
  process.on("SIGTERM", forwarded);
  process.on("SIGINT", forwarded);
  return {
    status: () => terminal,
    output: () => output,
    async stop() {
      try {
        signal("SIGTERM");
        if (!await Promise.race([done, pause(2500, null, { ref: false })])) signal("SIGKILL");
        return Boolean(await Promise.race([done, pause(1500, null, { ref: false })]));
      } finally {
        process.off("SIGTERM", forwarded);
        process.off("SIGINT", forwarded);
      }
    },
  };
}

async function dockerDriver(driver, dir, { command, start, socketExists, wait, now }) {
  mkdirSync(dir);
  const socket = path.join(dir, "docker.sock");
  const url = `unix://${socket}`;
  const host = ["--host", url];
  const args = [...host, "--data-root", path.join(dir, "data"), "--exec-root", path.join(dir, "exec"), "--pidfile", path.join(dir, "daemon.pid"),
    ...(driver === "vfs" ? ["--storage-driver", "vfs"] : [])];
  let daemon;
  try { daemon = start(args); }
  catch (error) { return { daemon: fail(error.code ?? error.message), helloWorld: fail("daemon did not start") }; }
  let readiness = fail("the private Docker socket never became ready");
  let started;
  let helloWorld;
  let stopped;
  try {
    const deadline = now() + READINESS_MS;
    while (!daemon.status() && now() < deadline) {
      if (socketExists(socket)) {
        readiness = await command("docker", [...host, "info"], 3);
        if (readiness.result === "YES" || readiness.reason === "ENOENT") break;
      }
      await wait(200);
    }
    const healthy = readiness.result === "YES" && !daemon.status();
    const ended = daemon.status();
    started = healthy ? result(0, daemon.output() + readiness.output)
      : { ...fail(ended?.reason ?? readiness.reason ?? "Docker daemon readiness timed out", daemon.output() + readiness.output),
        exitCode: ended?.exitCode ?? readiness.exitCode ?? null };
    helloWorld = healthy ? await command("docker", [...host, "run", "--rm", "hello-world"], 75) : fail("daemon did not become ready");
  } finally {
    stopped = await daemon.stop();
  }
  return { daemon: started, helloWorld, cleanup: stopped ? "YES" : "NO" };
}

/** Observe fixed capability commands only. Absent capabilities are measured outcomes, with every command captured. */
export async function probeCloudCapabilities({ directory, defaultDirectory = path.join(directory, "overlay-default"), command = run, start = startDockerProbe, socketExists = existsSync, wait = sleep,
  now = Date.now } = {}) {
  const dependencies = { command, start, socketExists, wait, now };
  const compose = await command("docker", ["compose", "version"], 10);
  const defaultDriver = await dockerDriver("default", defaultDirectory, dependencies);
  if (defaultDriver.cleanup === "NO") {
    return { defaultDriver, compose, vfsDriver: { daemon: fail("previous owned daemon did not stop"), helloWorld: fail("vfs did not run") },
      electron: { version: fail("previous owned daemon did not stop"), window: fail("Electron did not run") } };
  }
  const vfsDriver = await dockerDriver("vfs", path.join(directory, "vfs"), dependencies);
  const electronArgs = ["-a", "pnpm", `--package=electron@${ELECTRON_VERSION}`, "dlx", "electron"];
  let version = await command("xvfb-run", [...electronArgs, "--version"], 120);
  if (version.result === "YES" && !version.output.includes(`v${ELECTRON_VERSION}`)) version = fail("Electron did not report its pinned version", version.output);
  let window = version.result === "YES"
    ? await command("xvfb-run", [...electronArgs, ELECTRON_SMOKE], 90)
    : fail("the pinned Electron version did not start under Xvfb");
  if (window.result === "YES" && !window.output.includes("Electron loaded about:blank on its virtual display")) {
    window = fail("Electron did not report loading about:blank", window.output);
  }
  return { defaultDriver, compose, vfsDriver, electron: { version, window } };
}

/**
 * Name why each failed private Docker daemon or hello-world run failed, in one line short enough to stay in the lane's
 * stdout tail ahead of the runtime report: its recorded reason, else the last line it printed.
 */
export function capabilityReasonLine({defaultDriver,vfsDriver}) {
  const outcomes={defaultDaemon:defaultDriver.daemon,defaultHello:defaultDriver.helloWorld,vfsDaemon:vfsDriver.daemon,vfsHello:vfsDriver.helloWorld};
  const reasons={};
  for (const [name,outcome] of Object.entries(outcomes)) {
    if (outcome?.result !== "NO" || (name.endsWith("Hello") && reasons[name.replace("Hello","Daemon")])) continue;
    const last=String(outcome.output ?? "").trim().split("\n").at(-1) ?? "";
    reasons[name]=String(outcome.reason || last || `exit ${outcome.exitCode}`).replace(/\s+/g," ").slice(-40);
  }
  return "CLOUD_CAPABILITY_REASONS "+JSON.stringify(reasons);
}

/**
 * Remove the probe's private daemon state after its report is out. A failed removal is reported on its own line and
 * never replaces the measured report or the lane's exit status: the files sit under .git in a throwaway checkout.
 */
export function removeProbeState(root, { remove = rmSync, write = (line) => process.stdout.write(line) } = {}) {
  try {
    remove(root, { recursive: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch (error) {
    write(`CLOUD_CAPABILITY_CLEANUP ${JSON.stringify({ removed: false, path: root, error: String(error?.code ?? error?.message ?? error) })}\n`);
    return false;
  }
}

/**
 * Whether a lane can start Docker the way the committed bootstrap entry point does: a running daemon, or a plain
 * root dockerd with the default storage driver that answers and runs hello-world. The vfs fallback is measured
 * and reported, but it is not how the entry point starts Docker, so it never proves bootstrap.
 */
export function dockerBootstrapMeasured({ compose, defaultDriver }, docker) {
  return compose.result === "YES" && (docker.result === "YES" ||
    (defaultDriver.daemon.result === "YES" && defaultDriver.helloWorld.result === "YES"));
}

/** Emit the measured outcomes separately from private command logs so a clipped tool preview preserves each verdict. */
export function capabilityStatusLine({defaultDriver,vfsDriver,compose,electron}) {
  return "CLOUD_CAPABILITY_STATUS "+JSON.stringify({defaultDaemon:defaultDriver.daemon.result,defaultHello:defaultDriver.helloWorld.result,
    vfsDaemon:vfsDriver.daemon.result,vfsHello:vfsDriver.helloWorld.result,compose:compose.result,
    electronVersion:electron.version.result,electronWindow:electron.window.result});
}

if (isEntryPoint(import.meta.url)) {
  if (process.argv.length !== 2 || process.platform !== "linux" || process.env.CLAUDE_CODE_REMOTE !== "true") {
    process.stderr.write("CLOUD_CAPABILITY_UNAVAILABLE: use the fixed cloud-capabilities lane on Claude cloud Linux with no arguments\n");
    process.exitCode = 78;
  } else {
    const root = mkdtempSync(path.join(process.cwd(), ".git", "vibe-cloud-capabilities-"));
    // The default driver's private data root sits on the default data root's filesystem: overlay cannot stack on the
    // checkout's own overlay mount, which a plain dockerd never uses.
    const defaultRoot = mkdtempSync(path.join(DEFAULT_DATA_PARENT, "vibe-docker-probe-"));
    try {
      const outcome = await probeCloudCapabilities({ directory: root, defaultDirectory: path.join(defaultRoot, "overlay-default") });
      process.stdout.write(`CLOUD_CAPABILITIES ${JSON.stringify(outcome)}\n`);
      if ([outcome.defaultDriver, outcome.vfsDriver].some(({ cleanup }) => cleanup === "NO")) {
        process.stdout.write(capabilityStatusLine(outcome)+"\n");
        process.exitCode = 78;
      }
      else {
        const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
        const host = probeCloudHostRuntime(root);
        const docker = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 10);
        const checks = { ...host.checks, ...await measureLaneTools(), docker: docker.result === "YES" && outcome.compose.result === "YES",
          dockerBootstrap: dockerBootstrapMeasured(outcome, docker),
          display: outcome.electron.version.result === "YES" && outcome.electron.window.result === "YES" };
        process.stdout.write(`CLOUD_HOST_DETAILS ${JSON.stringify(host.details)}\n`);
        process.stdout.write(capabilityStatusLine(outcome)+"\n");
        process.stdout.write(capabilityReasonLine(outcome)+"\n");
        process.stdout.write(`CLOUD_HOST_RUNTIME ${JSON.stringify({ commit, checks })}\n`);
      }
    } catch (error) {
      // The lane keeps only stdout tails, so a crash is named there as well as on stderr.
      process.stdout.write(`CLOUD_CAPABILITY_ERROR ${JSON.stringify(String(error?.stack ?? error).slice(0, 1500))}\n`);
      throw error;
    } finally {
      // Preserve files for a daemon whose stop could not be confirmed.
      if (process.exitCode !== 78) { removeProbeState(root); removeProbeState(defaultRoot); }
    }
  }
}
