// plugin-version.mjs when vibe-core cannot be loaded. Codex installs no plugin
// dependency, so a vibe update there can arrive without vibe-core, and with it
// the record and identity modules plugin-version.mjs runs on. This answers the
// startup commands from what is still here, never importing vibe-core: `check`
// and `status` report vibe-core as missing (outdated) with the command that adds
// it and exit 0 with their usual JSON, `choose` accepts the person's answer, and
// `update --choice update`, run only after the person said update, runs that
// command; a bare `update` refuses. Nothing is recorded, because the record modules
// are what is missing; the next check after the install records as usual.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { Layout, pluginInstall } from "../../../shared/plugin-roots.mjs";
import { vibeCoreProblem, VIBE_CORE_INSTALL } from "../../../shared/vibe-core.mjs";
import { findCli } from "./plugin-cli.mjs";
import { codexHookApproval, HookApproval, hookApprovalLine } from "./vibe-core-hooks.mjs";

export const Choice = Object.freeze({ Update: "update", Proceed: "proceed" });
export const Connection = Object.freeze({ Connected: "connected", NotConnected: "not-connected" });

const CLAUDE = "claude";
const CODEX = "codex";
const LABEL = Object.freeze({ [CLAUDE]: "Claude Code", [CODEX]: "Codex" });
const UPDATE_TIMEOUT_MS = 180_000;
const OPTIONS = Object.freeze({
  runtime: { type: "string" }, choice: { type: "string" }, by: { type: "string" }, closedloop: { type: "string" },
  graph: { type: "string" }, state: { type: "string" }, worktree: { type: "string" }, conversation: { type: "string" },
  claude: { type: "string" }, codex: { type: "string" }, "latest-base": { type: "string" }, "timeout-ms": { type: "string" },
});

/** Runs plugin-version.mjs's command line without vibe-core (`problem` from vibeCoreProblem); returns the exit code. */
export async function runWithoutVibeCore(argv, problem, env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: false });
  const command = positionals[0] ?? "check";
  const harness = harnessOf(values.runtime, env);
  const cli = values[harness] ?? findCli(harness, env);
  const fix = fixCommand(harness, cli, problem);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (command === "check" || command === "status") {
    const connections = { closedloop: values.closedloop, graph: values.graph };
    const block = Object.values(connections).every((value) => Object.values(Connection).includes(value))
      ? { print: true, block: setupBlock(harness, problem, connections, fix) } : {};
    if (command === "status" && !block.print) {
      print({ ok: false, error: "--closedloop and --graph must each be connected or not-connected, from this conversation's own get-me and sync_status calls" });
      return 1;
    }
    print(command === "status" ? block : { ...missingRecord(harness, cli, problem, fix), ...block });
    return 0;
  }
  if (command === "choose") {
    if (!Object.values(Choice).includes(values.choice)) {
      print({ ok: false, error: "choose needs --choice update or --choice proceed" });
      return 1;
    }
    print({ ok: true, choice: values.choice, recorded: false, reason: `${problem.message}; nothing is recorded until vibe-core is installed` });
    return 0;
  }
  if (command === "update") {
    // Without vibe-core nothing records the person's answer, so the update carries it itself.
    if (values.choice !== Choice.Update) {
      print({ ok: false, error: `the person has not chosen to update here; once they say update, run update --choice update (it runs ${fix.join(" ")})` });
      return 1;
    }
    const result = await addVibeCore(harness, cli, fix);
    print(result);
    return result.status === "updated" ? 0 : 1;
  }
  print({ ok: false, error: problem.message });
  return 1;
}

/** The harness this vibe runs in: the install's own layout, else --runtime, else the harness the environment names. */
function harnessOf(runtime, env) {
  const layout = pluginInstall(import.meta.url).layout;
  if (layout === Layout.Claude || layout === Layout.Codex) return layout;
  if (runtime === CLAUDE || runtime === CODEX) return runtime;
  return env.CODEX_THREAD_ID ? CODEX : CLAUDE;
}

function fixCommand(harness, cli, problem) {
  if (harness === CODEX) return [cli ?? "codex", "plugin", "add", "vibe-core@closedloop-ai"];
  return [cli ?? "claude", "plugin", problem.outdated ? "update" : "install", "vibe-core@closedloop-ai"];
}

/** check's usual JSON, with vibe-core the one outdated (missing) plugin. */
function missingRecord(harness, cli, problem, fix) {
  const plugin = { name: "vibe-core", id: "vibe-core@closedloop-ai", version: null, missing: true, latest: null, status: "outdated" };
  return {
    status: "outdated", harnesses: [{ harness, cli, installed: true, plugins: [plugin] }],
    outdated: [{ harness, plugin: "vibe-core", installed: null, latest: null, missing: true }],
    versions: problem.outdated ? `vibe-core: you have ${problem.installed ?? "(no version)"}, this vibe needs ${problem.minimum} or newer` : "vibe-core: not installed",
    reason: problem.message, fix: fix.join(" "),
  };
}

function setupBlock(harness, problem, connections, fix) {
  const label = LABEL[harness];
  let state;
  let line;
  if (problem.outdated) {
    state = `vibe-core ${problem.installed ?? "(no version)"} is older than this vibe needs (>= ${problem.minimum})`;
    line = `vibe's guards cannot load it: run \`${fix.join(" ")}\``;
  } else {
    state = "vibe-core not installed";
    line = harness === CODEX ? hookApprovalLine({ state: HookApproval.Missing })
      : `vibe-core is not installed in Claude Code, so vibe's guards cannot run there: run \`${VIBE_CORE_INSTALL.claude}\``;
  }
  const word = (value) => (value === Connection.Connected ? "connected" : "not connected");
  return ["Setup check", `- ${label}: ${state}`, `- ${label}: ${line}`,
    `- ClosedLoop connection: ${word(connections.closedloop)}`, `- closedloop-graph connection: ${word(connections.graph)}`].join("\n");
}

/** Runs the add command and reports it in update's usual shape; in Codex, names an approval the new hooks need. */
async function addVibeCore(harness, cli, fix) {
  let reason = null;
  try {
    execFileSync(fix[0], fix.slice(1), { encoding: "utf8", timeout: UPDATE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    reason = `${fix.slice(0, 4).join(" ")} failed: ${String(error.stderr || error.message).trim().split("\n")[0]}`;
  }
  const still = vibeCoreProblem();
  const updated = !reason && !still;
  const result = {
    status: updated ? "updated" : "failed",
    plugins: [{ harness, plugin: "vibe-core", before: null, after: updated ? "installed" : null, latest: null,
      status: updated ? "updated" : "not-updated", ...(updated ? {} : { reason: reason ?? still.message }) }],
    restart: updated ? [harness] : [], commands: [fix.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word}'`)).join(" ")],
  };
  if (updated && harness === CODEX && cli) {
    const approval = hookApprovalLine(await codexHookApproval(cli, path.resolve(".")));
    if (approval) result.hookApproval = approval;
  }
  return result;
}
