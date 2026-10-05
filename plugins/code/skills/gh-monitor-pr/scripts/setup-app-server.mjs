#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) {
    const timeoutSuffix = options.timeout ? ` after ${options.timeout}ms` : "";
    throw new Error(`${command} ${args.join(" ")} failed${timeoutSuffix}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Parse setup without relying on a new environment-variable contract. */
export function parseSetupArgs(argv, threadId = process.env.CODEX_THREAD_ID) {
  if (argv.length === 0) return { command: "setup", surface: "desktop", threadId: null };
  let command = "setup";
  let surface = null;
  let explicitThreadId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "cli" || value === "desktop") surface = value;
    else if (value === "probe") command = "probe";
    else if (value === "--surface") surface = argv[++index];
    else if (value === "--thread-id") explicitThreadId = argv[++index];
    else throw new Error(`Unknown setup argument: ${value}`);
  }
  surface ||= "desktop";
  if (!new Set(["desktop", "cli"]).has(surface)) throw new Error("--surface must be desktop or cli");
  const resolvedThreadId = explicitThreadId || threadId || null;
  if ((surface === "cli" || command === "probe") && !resolvedThreadId) {
    throw new Error("CLI setup and explicit probes require --thread-id (or the existing CODEX_THREAD_ID)");
  }
  return { command, surface, threadId: resolvedThreadId };
}

function paths() {
  const home = homedir();
  const codexRoot = process.env.CODEX_HOME || join(home, ".codex");
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    home,
    codexRoot,
    codex: join(codexRoot, "packages", "standalone", "current", "codex"),
    helper: join(scriptDirectory, "app-server-notify.js"),
    startScript: join(scriptDirectory, "app-server-start.zsh"),
    socket: join(codexRoot, "app-server-control", "app-server-control.sock"),
    runtimeDirectory: join(codexRoot, "pr-monitors"),
  };
}

function verifyDaemon(codex, socket) {
  const version = JSON.parse(run(codex, ["app-server", "daemon", "version"], { timeout: 10_000 }));
  if (version.status !== "running" ||
      version.managedCodexVersion !== version.appServerVersion ||
      !existsSync(socket)) {
    throw new Error("The managed App Server did not create a compatible Unix socket after setup");
  }
  return version;
}

function runToCompletion(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        rejectRun(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code ?? `on signal ${signal || "unknown"}`}`));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

/** Await the notifier's complete bounded RPC lifecycle without a shorter parent deadline. */
export async function probeThread({ codex, helper, socket }, threadId, dependencies = {}) {
  const output = await (dependencies.run || runToCompletion)(process.execPath, [
    helper,
    "--socket", socket,
    "--thread-id", threadId,
    "--probe-only",
    "--wait-seconds", "15",
    "--transport", "proxy",
    "--codex", codex,
  ]);
  const probe = JSON.parse(output);
  if (probe.result !== "probed") throw new Error(`Invalid App Server probe result: ${output}`);
  return probe;
}

async function setupCli(resourcePaths, threadId) {
  run(resourcePaths.codex, ["app-server", "daemon", "bootstrap"], { timeout: 30_000 });
  run("/bin/zsh", [resourcePaths.startScript, "cli"], { timeout: 30_000 });
  const daemon = verifyDaemon(resourcePaths.codex, resourcePaths.socket);
  const probe = await probeThread(resourcePaths, threadId);
  if (probe.threadStatus !== "active" || !probe.activeTurnId) {
    throw new Error(
      `CLI thread ${threadId} is ${probe.threadStatus || "unknown"}, not active in the managed daemon; ` +
      "resume this exact root through the daemon and run CLI setup again from its active turn",
    );
  }
  return {
    status: "configured",
    surface: "cli",
    daemon,
    socket: resourcePaths.socket,
    probe,
    nextStep: "Start the monitor from an active turn in this exact CLI root with --owner-surface cli.",
  };
}

function setupDesktop(resourcePaths) {
  if (process.platform !== "darwin") {
    throw new Error("Automatic Desktop App Server setup is currently supported only on macOS");
  }
  const launchAgents = join(resourcePaths.home, "Library", "LaunchAgents");
  const label = "local.codex.gh-monitor-pr-app-server";
  const plist = join(launchAgents, `${label}.plist`);
  const stdoutLog = join(resourcePaths.runtimeDirectory, "app-server.stdout.log");
  const stderrLog = join(resourcePaths.runtimeDirectory, "app-server.stderr.log");
  mkdirSync(resourcePaths.runtimeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });

  run("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_WS_URL"]);
  run("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_USE_LOCAL_DAEMON", "1"]);
  run(resourcePaths.codex, ["app-server", "daemon", "bootstrap"], { timeout: 30_000 });
  run(resourcePaths.codex, ["app-server", "daemon", "start"], { timeout: 30_000 });

  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-l</string>
    <string>${xml(resourcePaths.startScript)}</string>
    <string>desktop</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrLog)}</string>
</dict>
</plist>
`;
  const temporaryPlist = `${plist}.${process.pid}.tmp`;
  writeFileSync(temporaryPlist, plistBody, { mode: 0o600 });
  renameSync(temporaryPlist, plist);
  const domain = `gui/${process.getuid()}`;
  spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { encoding: "utf8" });
  run("/bin/launchctl", ["bootstrap", domain, plist]);
  run("/bin/zsh", [resourcePaths.startScript, "desktop"], { timeout: 30_000 });
  return {
    status: "configured",
    surface: "desktop",
    daemon: verifyDaemon(resourcePaths.codex, resourcePaths.socket),
    socket: resourcePaths.socket,
    desktopEnvironment: "CODEX_APP_SERVER_USE_LOCAL_DAEMON=1",
    persistence: plist,
    nextStep: "Quit ChatGPT completely and reopen it once so Desktop joins the managed local daemon.",
  };
}

async function main() {
  const options = parseSetupArgs(process.argv.slice(2));
  const resourcePaths = paths();
  for (const [label, path] of [["managed standalone Codex executable", resourcePaths.codex], ["App Server starter", resourcePaths.startScript], ["notification helper", resourcePaths.helper]]) {
    if (!existsSync(path)) throw new Error(`The ${label} is missing: ${path}`);
  }
  let result;
  if (options.command === "probe") {
    const daemon = verifyDaemon(resourcePaths.codex, resourcePaths.socket);
    result = {
      status: "probed",
      surface: options.surface,
      daemon,
      socket: resourcePaths.socket,
      probe: await probeThread(resourcePaths, options.threadId),
    };
  } else if (options.surface === "cli") {
    result = await setupCli(resourcePaths, options.threadId);
  } else {
    result = setupDesktop(resourcePaths);
  }
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`gh-monitor-pr setup: ${error.message}`);
    process.exitCode = 1;
  });
}
