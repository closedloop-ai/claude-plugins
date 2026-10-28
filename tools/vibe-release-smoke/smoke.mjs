#!/usr/bin/env node
// The vibe release smoke (ISS-13315). Installs the vibe and closedloop-core plugins exactly as
// committed at --ref into a throwaway Codex home, starts a real session through the ChatGPT
// app's bundled Codex app server with the app's default permissions (approval policy
// on-request, workspace-write sandbox, no network), sends "$vibe <request>", and checks that
// the first reply's setup check shows the installed versions and a completed latest-version
// check. Unit tests and evals feed script output in the prompt; this runs the real thing.
//
// Usage: node tools/vibe-release-smoke/smoke.mjs [--ref HEAD] [--codex <cli>] [--request <text>]
//          [--timeout-ms 420000] [--max-seconds 90] [--keep]
// Exit 0 on a pass, 1 on a failure, 2 when the smoke could not run at all.
//
// A required release step, not a CI check: it needs the ChatGPT app signed in, which CI
// runners are not (operator ruling, ISS-13315). Run it on the final commit of every change
// to plugins/vibe before it merges (AGENTS.md, CONTRIBUTING.md).
//
// The person's part is played by this script: it allows commands that run the installed vibe
// plugin's startup check (the "Allow once" the person clicks), lets the two read-only
// connection calls (ClosedLoop get-me, closedloop-graph sync_status) through, and declines
// every other approval, so the run changes nothing outside its throwaway home. The throwaway
// home is created under the real home folder, never under /tmp or $TMPDIR, because the
// sandbox can write there and would hide a write the sandbox refuses on a real machine.
// Only Codex's sign-in (auth.json) and the two ClosedLoop connection blocks of config.toml
// are copied in; nothing is printed from them, and the home is deleted afterwards.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assessFirstReply, findSetupBlock } from "./first-reply.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const MARKETPLACE = "closedloop-ai";
const PLUGINS = ["closedloop-core", "vibe"];
const CONNECTION_BLOCKS = ["[mcp_servers.closedloop]", "[mcp_servers.closedloop-graph]"];
const READ_ONLY_TOOLS = new Set(["closedloop/get-me", "closedloop-graph/sync_status"]);
const KEEP_ENV = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM"];
const SETTLE_MS = 20_000;

const { values } = parseArgs({
  options: {
    ref: { type: "string", default: "HEAD" },
    codex: { type: "string", default: BUNDLED_CODEX },
    request: { type: "string", default: "pick up where I left off" },
    "timeout-ms": { type: "string", default: "420000" },
    "max-seconds": { type: "string", default: "90" },
    keep: { type: "boolean", default: false },
  },
});

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const realCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

if (!existsSync(values.codex)) {
  finish(2, { status: "not-run", reason: `no Codex CLI at ${values.codex}; install the ChatGPT app or pass --codex` });
}
if (!existsSync(path.join(realCodexHome, "auth.json"))) {
  finish(2, { status: "not-run", reason: `Codex is not signed in on this machine (${realCodexHome}/auth.json is missing)` });
}

const commit = git("rev-parse", `${values.ref}^{commit}`);
const built = Object.fromEntries(PLUGINS.map((name) => [name, {
  version: JSON.parse(git("show", `${commit}:plugins/${name}/.codex-plugin/plugin.json`)).version,
  tree: git("rev-parse", `${commit}:plugins/${name}`),
}]));
const root = mkdtempSync(path.join(os.homedir(), ".vibe-release-smoke-"));
const home = path.join(root, "home");
const codexHome = path.join(home, ".codex");
const market = path.join(root, "marketplace");
const workspace = path.join(home, "Documents", "Codex", "vibe-release-smoke");
let report;
try {
  report = await runSmoke();
} catch (error) {
  report = { status: "not-run", reason: error.message };
} finally {
  if (!values.keep) {
    rmSync(root, { recursive: true, force: true });
  }
}
finish(report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2, report);

async function runSmoke() {
  for (const dir of [codexHome, market, workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  chmodSync(codexHome, 0o700);
  copyFileSync(path.join(realCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
  chmodSync(path.join(codexHome, "auth.json"), 0o600);
  const connections = connectionBlocks(path.join(realCodexHome, "config.toml"));
  writeFileSync(path.join(codexHome, "config.toml"), connections.text, { mode: 0o600 });
  execFileSync("/bin/sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", REPO, commit, market]);

  const env = isolatedEnv(connections.envNames);
  const codex = (...args) => execFileSync(values.codex, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  codex("plugin", "marketplace", "add", market);
  for (const name of PLUGINS) {
    codex("plugin", "add", `${name}@${MARKETPLACE}`);
  }
  const installed = JSON.parse(codex("plugin", "list", "--json")).installed
    .filter((row) => row.marketplaceName === MARKETPLACE)
    .map((row) => ({ name: row.name, version: row.version }));
  const skill = path.join(codexHome, "plugins", "cache", MARKETPLACE, "vibe", built.vibe.version, "skills", "vibe", "SKILL.md");
  if (!existsSync(skill)) {
    throw new Error(`the installed vibe skill is not at ${skill}`);
  }
  const startupScript = path.join(path.dirname(skill), "scripts", "plugin-version.mjs");
  const turn = await driveTurn({ env, skill, startupScript });
  const expected = {
    harness: "Codex",
    versions: Object.fromEntries(PLUGINS.map((name) => [name, built[name].version])),
    maxSeconds: Number(values["max-seconds"]),
  };
  const failures = assessFirstReply({ messages: turn.messages, commands: turn.commands, expected });
  const block = findSetupBlock(turn.messages);
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    commit,
    built,
    installed,
    codex: codex("--version").trim(),
    connections: connections.found,
    setupCheck: block ? { seconds: Number(block.message.t), lines: block.lines } : null,
    firstReply: turn.messages,
    commands: turn.commands.map(({ command, exitCode, approval, output, t }) => ({ t, command, exitCode, approval, output: String(output ?? "").slice(0, 600) })),
    approvals: turn.approvals,
    turnStatus: turn.status,
  };
}

/** The [mcp_servers.closedloop] and [mcp_servers.closedloop-graph] blocks, and the env var names their bearer settings read. */
function connectionBlocks(configFile) {
  const source = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const blocks = source.split(/^(?=\[)/m).filter((block) => CONNECTION_BLOCKS.includes(block.split("\n")[0].trim()));
  const text = blocks.map((block) => `${block.trimEnd()}\n`).join("\n");
  const envNames = [...text.matchAll(/^\s*\w*env_var\s*=\s*"([A-Z0-9_]+)"/gm)].map((match) => match[1]);
  return { text, envNames, found: blocks.map((block) => block.split("\n")[0].trim()) };
}

/** Only what Codex and its shell commands need; never the caller's Claude Code or Codex session ids. */
function isolatedEnv(envNames) {
  const env = { HOME: home, CODEX_HOME: codexHome };
  for (const name of [...KEEP_ENV, ...envNames]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

async function driveTurn({ env, skill, startupScript }) {
  const child = spawn(values.codex, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const started = Date.now();
  const seconds = () => Number(((Date.now() - started) / 1000).toFixed(1));
  const pending = new Map();
  const messages = [];
  const commands = new Map();
  const approvals = [];
  let nextId = 1;
  let status = "running";
  let settle;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const answer = (message) => {
    const params = message.params ?? {};
    if (message.method === "item/commandExecution/requestApproval") {
      const allow = String(params.command ?? "").includes(startupScript);
      approvals.push({ t: seconds(), command: params.command, reason: params.reason ?? null, decision: allow ? "accept" : "decline" });
      const entry = commands.get(params.itemId);
      if (entry) entry.approval = allow ? "accept" : "decline";
      send({ id: message.id, result: { decision: allow ? "accept" : "decline" } });
    } else if (message.method === "mcpServer/elicitation/request") {
      const tool = `${params.serverName}/${params._meta?.tool_name ?? toolFromMessage(params.message)}`;
      const allow = READ_ONLY_TOOLS.has(tool);
      approvals.push({ t: seconds(), tool, decision: allow ? "accept" : "decline" });
      send({ id: message.id, result: { action: allow ? "accept" : "decline", content: allow ? {} : null, _meta: null } });
    } else {
      approvals.push({ t: seconds(), method: message.method, decision: "decline" });
      send({ id: message.id, result: { decision: "decline" } });
    }
  };
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      answer(message);
      return;
    }
    const item = message.params?.item ?? {};
    if (item.type === "commandExecution") {
      const entry = commands.get(item.id) ?? { t: seconds(), command: item.command };
      if (message.method === "item/completed") {
        Object.assign(entry, { exitCode: item.exitCode ?? null, status: item.status, output: item.aggregatedOutput ?? "" });
      }
      commands.set(item.id, entry);
    } else if (item.type === "agentMessage" && message.method === "item/completed") {
      messages.push({ t: seconds(), phase: item.phase ?? null, text: item.text ?? "" });
      if (!settle && findSetupBlock(messages)) {
        settle = setTimeout(resolveDone, SETTLE_MS);
      }
    } else if (message.method === "turn/completed") {
      status = message.params?.turn?.status ?? "completed";
      resolveDone();
    }
  });
  await request("initialize", { clientInfo: { name: "vibe_release_smoke", title: null, version: "1" }, capabilities: null });
  send({ method: "initialized" });
  const thread = await request("thread/start", { cwd: workspace, approvalPolicy: "on-request", sandbox: "workspace-write" });
  const threadId = thread.thread.id;
  const turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: `$vibe ${values.request}`, text_elements: [] }, { type: "skill", name: "vibe:vibe", path: skill }],
  });
  const timer = setTimeout(() => {
    status = "timed-out";
    resolveDone();
  }, Number(values["timeout-ms"]));
  await done;
  clearTimeout(timer);
  clearTimeout(settle);
  if (status === "running") {
    status = "stopped-after-setup-check";
    await Promise.race([request("turn/interrupt", { threadId, turnId: turn.turn.id }).catch(() => {}), delay(5_000)]);
  }
  child.kill();
  return { messages, commands: [...commands.values()], approvals, status };
}

function toolFromMessage(text) {
  return /run tool "([^"]+)"/.exec(String(text ?? ""))?.[1] ?? "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finish(code, result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}
