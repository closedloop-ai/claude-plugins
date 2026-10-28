#!/usr/bin/env node
// The startup version check for vibe and fleet-orchestrator sessions
// (operator rulings, 2026-10-16 and 2026-10-27). It finds every closedloop-ai
// plugin installed on this machine, in Claude Code and in Codex, compares each
// with the version on the marketplace's main branch, and records the result,
// the person's choice and any update in the session's state.
//
// Usage:
//   plugin-version.mjs [check]  [--runtime codex|claude] [state] [--claude <CLI>] [--codex <CLI>]
//                               [--latest-base <url>] [--timeout-ms <n>]
//   plugin-version.mjs choose   --choice update|proceed [--by person|opening-message] [state]
//   plugin-version.mjs update   [state] [--claude <CLI>] [--codex <CLI>]
//   plugin-version.mjs pending  --conversation <id>     (written by the vibe hooks when a session starts)
//   plugin-version.mjs adopt    --worktree <path>       (vibe-sessions.mjs new does this itself)
//   plugin-version.mjs status   --closedloop connected|not-connected --graph connected|not-connected [state]
//   plugin-version.mjs show     [state]
// where [state] is --worktree <vibe session> (the session record's
// `pluginVersion`), --state <file> (a fleet program's plugin-version.json),
// or neither: this conversation's startup record under
// ~/.codex/vibe/plugin-version/, named by CLAUDE_CODE_SESSION_ID or
// CODEX_THREAD_ID (--conversation overrides).
//
// `check` prints {"status":"current"|"outdated"|"unknown", "harnesses", "outdated",
// "versions", "reason"?} and always exits 0: no network, a refused, slow or
// garbled answer, or a CLI that cannot list its plugins makes the affected
// part `unknown` with its reason, and the session carries on. A harness is
// installed when its CLI is found and lists at least one closedloop-ai plugin;
// nothing is assumed. "Latest" is each plugin's manifest on main, located
// through main's own marketplace file, read over HTTPS with no clone.
//
// A check run again in the same conversation with the same outdated versions
// keeps the answer already recorded; a new conversation asks again.
// `choose` records the person's answer. `proceed` records that they accepted
// that an outdated plugin could give worse results. `update` refuses unless
// the recorded choice is `update`; it refreshes the marketplace and updates
// each outdated plugin in every harness that has one (Claude Code, Codex, or
// both), lists the plugins again, and prints {"status":"updated"|"failed",
// "plugins", "restart", "commands"}, exiting 1 unless every plugin reached
// the latest version. `restart` names the harnesses that need a new session
// (Claude Code) or a reopened app (Codex) before the update takes effect.
// `status` prints the startup setup check block (ISS-13258, operator ruling
// 2026-10-27): the installed closedloop-core and vibe versions for each
// installed harness, from this conversation's `check`, and whether the
// closedloop and closedloop-graph connections answered this conversation's
// own get-me and sync_status calls. It prints {"print":true,"block"} once per
// conversation and {"print":false} on every later call in it, a compaction
// included, so the block is never shown twice.
// When vibe itself is outdated, `sessions` names each vibe session in the
// remembered checkout whose writer is bound to an older vibe release, which
// the update strands (ISS-13291), and migrates each Claude writer with the
// updated release's own writer-state.mjs: `migrated`, `on-resume` (a running
// turn, a Codex writer, or a recorded release still installed; the session
// migrates when it resumes) or `failed` with its reason.
// `vibe-sessions.mjs new` refuses to create a session while this
// conversation's record is outdated with no choice, and the vibe hooks refuse
// worker launches in Claude Code while it is (hooks/plugin-version-guard.mjs).

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";

export const MARKETPLACE = "closedloop-ai";
export const LATEST_BASE = "https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main";
export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
export const Harness = Object.freeze({ Claude: "claude", Codex: "codex" });
export const VersionStatus = Object.freeze({ Current: "current", Outdated: "outdated", Unknown: "unknown", Pending: "pending" });
export const Choice = Object.freeze({ Update: "update", Proceed: "proceed" });
export const Connection = Object.freeze({ Connected: "connected", NotConnected: "not-connected" });
export const StrandedMigration = Object.freeze({ Migrated: "migrated", OnResume: "on-resume", Failed: "failed" });
const VIBE_BRANCH = "vibe/";
const MANIFEST = Object.freeze({ claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json" });
const CATALOG = Object.freeze({ claude: ".claude-plugin/marketplace.json", codex: ".agents/plugins/marketplace.json" });
const CHOOSERS = Object.freeze(["person", "opening-message"]);
const COMMANDS = Object.freeze(["check", "choose", "update", "pending", "adopt", "status", "show"]);
const HARNESS_LABEL = Object.freeze({ claude: "Claude Code", codex: "Codex" });
const STATUS_PLUGINS = Object.freeze(["closedloop-core", "vibe"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 180_000;
const STARTUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CONVERSATION = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_WORD = /^[\w@%+=:,./-]+$/;

/** -1, 0 or 1 for two x.y.z versions, or null when either is not one. */
export function compareVersions(left, right) {
  const a = VERSION.exec(String(left ?? "").trim());
  const b = VERSION.exec(String(right ?? "").trim());
  if (!a || !b) {
    return null;
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** The CLI for `harness` that exists on this machine, or null: PATH first, then its usual install places. */
export function findCli(harness, env = process.env, home = os.homedir()) {
  const fallbacks = harness === Harness.Claude
    ? [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")]
    : [BUNDLED_CODEX];
  return onPath(harness, env) ?? fallbacks.find(isExecutable) ?? null;
}

/** The enabled closedloop-ai plugins one harness's `plugin list --json` output names, as {name, id, version, scope?, marketplace?}. */
export function installedPlugins(harness, listing) {
  const parsed = typeof listing === "string" ? JSON.parse(listing) : listing;
  if (harness === Harness.Claude) {
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows.filter((row) => typeof row?.id === "string" && row.id.endsWith(`@${MARKETPLACE}`) && row.enabled !== false)
      .map((row) => ({ name: row.id.slice(0, -MARKETPLACE.length - 1), id: row.id, version: row.version ?? null, scope: row.scope ?? null }));
  }
  const rows = Array.isArray(parsed?.installed) ? parsed.installed : [];
  return rows.filter((row) => row?.marketplaceName === MARKETPLACE && row.installed !== false && row.enabled !== false && typeof row.name === "string")
    .map((row) => ({ name: row.name, id: row.pluginId ?? `${row.name}@${MARKETPLACE}`, version: row.version ?? null, marketplace: marketplaceOf(row) }));
}

/** The per-plugin verdicts for one harness, given each plugin's latest version or the reason it is unknown. */
export function comparePlugins(plugins, latest) {
  return plugins.map((plugin) => {
    const found = latest.get(plugin.name);
    if (!found || found.reason) {
      return { ...plugin, latest: null, status: VersionStatus.Unknown, reason: found?.reason ?? `${plugin.name} is not in the marketplace on main` };
    }
    const order = compareVersions(plugin.version, found.version);
    if (order === null) {
      return { ...plugin, latest: found.version, status: VersionStatus.Unknown, reason: `cannot compare ${plugin.version} with ${found.version}` };
    }
    return { ...plugin, latest: found.version, status: order < 0 ? VersionStatus.Outdated : VersionStatus.Current };
  });
}

/** The overall result from each harness's findings. */
export function summarize(harnesses) {
  const outdated = harnesses.flatMap((entry) => (entry.plugins ?? [])
    .filter((plugin) => plugin.status === VersionStatus.Outdated)
    .map((plugin) => ({ harness: entry.harness, plugin: plugin.name, installed: plugin.version, latest: plugin.latest })));
  const reasons = harnesses.flatMap((entry) => [
    ...(entry.reason ? [`${entry.harness}: ${entry.reason}`] : []),
    ...(entry.plugins ?? []).filter((plugin) => plugin.status === VersionStatus.Unknown).map((plugin) => `${entry.harness} ${plugin.name}: ${plugin.reason}`),
  ]);
  const found = harnesses.some((entry) => entry.installed);
  if (!found && reasons.length === 0) {
    reasons.push("no closedloop-ai plugin is installed in Claude Code or Codex");
  }
  let status = VersionStatus.Current;
  if (outdated.length > 0) {
    status = VersionStatus.Outdated;
  } else if (reasons.length > 0) {
    status = VersionStatus.Unknown;
  }
  return {
    status,
    harnesses,
    outdated,
    versions: versionsText(outdated),
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

/** "vibe: you have 1.0.52, the latest is 1.0.53", once per plugin and version pair, in first-seen order. */
export function versionsText(outdated) {
  const seen = new Set();
  const parts = [];
  for (const entry of outdated) {
    const text = `${entry.plugin}: you have ${entry.installed}, the latest is ${entry.latest}`;
    if (!seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }
  return parts.join("; ");
}

/** The commands that bring one harness's outdated plugins to the latest version, as argv arrays. */
export function updateCommands(harness, cli, outdated) {
  if (outdated.length === 0) {
    return [];
  }
  if (harness === Harness.Claude) {
    return [
      [cli, "plugin", "marketplace", "update", MARKETPLACE],
      ...outdated.map((plugin) => [cli, "plugin", "update", plugin.id, ...(plugin.scope ? ["--scope", plugin.scope] : [])]),
    ];
  }
  // A local folder marketplace is not refreshed by `marketplace upgrade`
  // (INSTALL.md, "Updating"); its checkout is pulled instead.
  const local = outdated.map((plugin) => plugin.marketplace).find((source) => source?.type === "local");
  const refresh = local ? ["git", "-C", local.root, "pull", "--ff-only"] : [cli, "plugin", "marketplace", "upgrade", MARKETPLACE];
  return [refresh, ...outdated.map((plugin) => [cli, "plugin", "add", `${plugin.name}@${MARKETPLACE}`])];
}

/** Runs the whole check; never throws. */
export async function checkVersions({ clis = {}, latestBase = LATEST_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, env = process.env, home = os.homedir() } = {}) {
  const fetchText = cachedFetch(fetchImpl, timeoutMs);
  const harnesses = [];
  for (const harness of [Harness.Claude, Harness.Codex]) {
    harnesses.push(await checkHarness(harness, clis[harness] ?? findCli(harness, env, home), latestBase, fetchText));
  }
  return summarize(harnesses);
}

/** Updates every outdated plugin `record` lists, then lists again; never throws. */
export function updatePlugins(record, { clis = {}, env = process.env, home = os.homedir() } = {}) {
  const commands = [];
  const plugins = [];
  const restart = [];
  for (const entry of record.harnesses ?? []) {
    const outdated = (entry.plugins ?? []).filter((plugin) => plugin.status === VersionStatus.Outdated);
    if (outdated.length === 0) {
      continue;
    }
    const cli = clis[entry.harness] ?? entry.cli ?? findCli(entry.harness, env, home);
    let failure = entry.harness === Harness.Codex ? localMarketplaceProblem(outdated) : null;
    for (const argv of updateCommands(entry.harness, cli, outdated)) {
      commands.push(argv.map(shellWord).join(" "));
      if (failure) {
        continue;
      }
      try {
        execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: UPDATE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        failure = `${argv.slice(0, 4).join(" ")} failed: ${firstLine(error.stderr) || error.message}`;
      }
    }
    const after = listInstalled(entry.harness, cli);
    for (const plugin of outdated) {
      const now = after.plugins?.find((candidate) => candidate.id === plugin.id) ?? null;
      const reached = now && compareVersions(now.version, plugin.latest) >= 0;
      plugins.push({
        harness: entry.harness, plugin: plugin.name, before: plugin.version, after: now?.version ?? null, latest: plugin.latest,
        status: reached ? "updated" : "not-updated",
        ...(reached ? {} : { reason: failure ?? after.reason ?? `still ${now?.version ?? "missing"} after the update` }),
      });
    }
    if (plugins.some((plugin) => plugin.harness === entry.harness && plugin.status === "updated")) {
      restart.push(entry.harness);
    }
  }
  const ok = plugins.length > 0 && plugins.every((plugin) => plugin.status === "updated");
  return { status: ok ? "updated" : "failed", plugins, restart, commands };
}

/**
 * Why a local folder marketplace cannot be pulled, or null: it is often someone's own
 * checkout, so it is pulled only on its default branch with nothing uncommitted, and a
 * feature branch is never moved (PR #350 review).
 */
export function localMarketplaceProblem(outdated) {
  const root = outdated.map((plugin) => plugin.marketplace).find((source) => source?.type === "local")?.root;
  if (!root) {
    return null;
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    let base = "main";
    try {
      base = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
    } catch {
      // No remote HEAD recorded; main is the marketplace's branch.
    }
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== base) {
      return `the local marketplace ${root} is on ${branch}, not ${base}; it was left alone, so switch it to ${base} or update it yourself`;
    }
    if (git("status", "--porcelain") !== "") {
      return `the local marketplace ${root} has uncommitted changes; it was left alone, so commit or stash them, or update it yourself`;
    }
  } catch (error) {
    return `the local marketplace ${root} could not be read: ${firstLine(error.stderr) || error.message}`;
  }
  return null;
}

/** Where this conversation's startup record lives. */
export function startupFile(conversation, home = os.homedir()) {
  if (!CONVERSATION.test(conversation)) {
    throw new Error(`invalid conversation id ${JSON.stringify(conversation)}`);
  }
  return path.join(startupDir(home), `${conversation}.json`);
}

/** This conversation's id from the harness, or "default" outside one. */
export function conversationId(env = process.env) {
  return [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID].find((value) => typeof value === "string" && CONVERSATION.test(value)) ?? "default";
}

/** Reads a startup record, or null. */
export function readStartupRecord(conversation, home = os.homedir()) {
  return readJson(startupFile(conversation, home));
}

/** Marks a conversation's vibe or fleet session as started with the check not yet run; keeps any record it already has. */
export function markPending(conversation, home = os.homedir(), now = new Date()) {
  const file = startupFile(conversation, home);
  if (existsSync(file)) {
    return readJson(file);
  }
  const record = { conversation, status: VersionStatus.Pending, startedAt: now.toISOString() };
  writeJson(file, record);
  return record;
}

/** Why the recorded state blocks starting work, or null: the check never ran, or it found an outdated plugin nobody chose about. */
export function blockingProblem(record) {
  if (record?.status === VersionStatus.Pending) {
    return "the plugin version check has not run in this conversation";
  }
  if (record?.status === VersionStatus.Outdated && !record.choice) {
    return `plugins are outdated (${record.versions}) and the person has not chosen to update or to proceed`;
  }
  return null;
}

/** Moves this conversation's startup record onto a vibe session record; refuses one that blocks. Returns the adopted record or null. */
export function adoptStartupRecord(worktree, { env = process.env, home = os.homedir() } = {}) {
  const conversation = conversationId(env);
  const record = readStartupRecord(conversation, home);
  if (!record) {
    return null;
  }
  const problem = blockingProblem(record);
  if (problem) {
    throw new Error(`${problem}; run plugin-version.mjs check, ask the person, and record the answer with plugin-version.mjs choose first`);
  }
  const session = readSessionRecord(worktree);
  if (!session) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  writeSessionRecord(worktree, { ...session, pluginVersion: record });
  return record;
}

/**
 * The startup setup check block: the installed closedloop-core and vibe versions for each
 * installed harness, from `record` (this conversation's check, or null when it has not run
 * here), then the two connections as this conversation's own calls found them.
 */
export function statusBlock(record, connections) {
  const lines = ["Setup check"];
  const harnesses = (record?.harnesses ?? []).filter((entry) => entry.installed !== false);
  if (!record) {
    lines.push("- Plugins: the version check has not run in this conversation");
  } else if (harnesses.length === 0) {
    lines.push(record.reason ? `- Plugins: couldn't read the installed versions (${record.reason})` : "- Plugins: none installed in Claude Code or Codex");
  }
  for (const entry of harnesses) {
    const label = HARNESS_LABEL[entry.harness] ?? entry.harness;
    if (!Array.isArray(entry.plugins)) {
      lines.push(`- ${label}: couldn't read its plugins`);
      continue;
    }
    const parts = STATUS_PLUGINS.map((name) => {
      const plugin = entry.plugins.find((candidate) => candidate.name === name);
      return plugin ? `${name} ${plugin.version ?? "(version unknown)"}` : `${name} not installed`;
    });
    lines.push(`- ${label}: ${parts.join(", ")}`);
  }
  const word = (value) => (value === Connection.Connected ? "connected" : "not connected");
  lines.push(`- ClosedLoop connection: ${word(connections.closedloop)}`, `- closedloop-graph connection: ${word(connections.graph)}`);
  return lines.join("\n");
}

function onPath(name, env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function marketplaceOf(row) {
  const source = row.marketplaceSource;
  if (source?.sourceType === "local" && typeof source.source === "string") {
    return { type: "local", root: source.source };
  }
  return { type: source?.sourceType ?? "unknown" };
}

function listInstalled(harness, cli) {
  try {
    const listing = execFileSync(cli, ["plugin", "list", "--json"], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
    return { plugins: installedPlugins(harness, listing) };
  } catch (error) {
    return { reason: `${path.basename(cli)} plugin list failed: ${firstLine(error.stderr) || error.message}` };
  }
}

async function checkHarness(harness, cli, latestBase, fetchText) {
  if (!cli) {
    return { harness, installed: false };
  }
  const listed = listInstalled(harness, cli);
  if (listed.reason) {
    return { harness, cli, installed: null, reason: listed.reason };
  }
  if (listed.plugins.length === 0) {
    return { harness, cli, installed: false };
  }
  const latest = await latestVersions(harness, listed.plugins.map((plugin) => plugin.name), latestBase, fetchText);
  if (latest.reason) {
    return { harness, cli, installed: true, reason: latest.reason, plugins: listed.plugins.map((plugin) => ({ ...plugin, latest: null, status: VersionStatus.Unknown, reason: latest.reason })) };
  }
  return { harness, cli, installed: true, plugins: comparePlugins(listed.plugins, latest.versions) };
}

async function latestVersions(harness, names, latestBase, fetchText) {
  const catalog = await fetchText(`${latestBase}/${CATALOG[harness]}`);
  if (catalog.reason) {
    return { reason: catalog.reason };
  }
  let entries;
  try {
    entries = JSON.parse(catalog.text).plugins;
  } catch {
    return { reason: "the marketplace file on main is not JSON" };
  }
  const versions = new Map();
  for (const name of names) {
    const entry = Array.isArray(entries) ? entries.find((candidate) => candidate?.name === name) : undefined;
    const source = typeof entry?.source === "string" ? entry.source : entry?.source?.path;
    if (typeof source !== "string") {
      continue;
    }
    const manifest = await fetchText(`${latestBase}/${path.posix.join(source, MANIFEST[harness])}`);
    if (manifest.reason) {
      versions.set(name, { reason: manifest.reason });
      continue;
    }
    try {
      versions.set(name, { version: JSON.parse(manifest.text).version });
    } catch {
      versions.set(name, { reason: `the ${name} manifest on main is not JSON` });
    }
  }
  return { versions };
}

function cachedFetch(fetchImpl, timeoutMs) {
  const cache = new Map();
  return (url) => {
    if (!cache.has(url)) {
      cache.set(url, (async () => {
        try {
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          return response.ok ? { text: await response.text() } : { reason: `the marketplace answered ${response.status}` };
        } catch (error) {
          return { reason: `the marketplace could not be reached: ${error.message}` };
        }
      })());
    }
    return cache.get(url);
  };
}

function startupDir(home) {
  return path.join(home, ".codex", "vibe", "plugin-version");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Drops startup records older than 30 days so the folder never grows without bound. */
function sweepStartup(home, now) {
  const dir = startupDir(home);
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs > STARTUP_KEEP_MS) {
        rmSync(file, { force: true });
      }
    } catch {
      // Another process removed it.
    }
  }
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0] ?? "";
}

function shellWord(word) {
  return SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Reads and writes the record the options name: a session, a state file, or this
 * conversation's startup record. A session or state file write is mirrored to the
 * startup record, which the vibe hooks read.
 */
function stateStore(values, env, home) {
  const startup = startupFile(values.conversation ?? conversationId(env), home);
  if (values.worktree) {
    return {
      read: () => readSessionRecord(values.worktree)?.pluginVersion ?? null,
      write: (record) => {
        const session = readSessionRecord(values.worktree);
        if (!session) {
          throw new Error(`No vibe session record in ${values.worktree}.`);
        }
        writeSessionRecord(values.worktree, { ...session, pluginVersion: record });
        writeJson(startup, record);
      },
      where: values.worktree,
    };
  }
  const file = values.state ? path.resolve(values.state) : startup;
  return {
    read: () => readJson(file),
    write: (record) => {
      writeJson(file, record);
      if (file !== startup) {
        writeJson(startup, record);
      }
    },
    where: file,
  };
}

async function main(argv, env, home) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      runtime: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      worktree: { type: "string" },
      state: { type: "string" },
      conversation: { type: "string" },
      choice: { type: "string" },
      by: { type: "string" },
      closedloop: { type: "string" },
      graph: { type: "string" },
      "latest-base": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const command = positionals[0] ?? "check";
  const clis = Object.fromEntries([[Harness.Claude, values.claude], [Harness.Codex, values.codex]].filter(([, cli]) => cli));
  const now = new Date();
  if (command === "pending") {
    return { code: 0, output: markPending(values.conversation ?? conversationId(env), home, now) };
  }
  if (command === "adopt") {
    if (!values.worktree) {
      throw new Error("adopt needs --worktree");
    }
    return { code: 0, output: { ok: true, pluginVersion: adoptStartupRecord(values.worktree, { env, home }) } };
  }
  const store = stateStore(values, env, home);
  if (command === "check") {
    const timeoutMs = Number(values["timeout-ms"]);
    const result = await checkVersions({
      clis,
      latestBase: values["latest-base"] ?? env.VIBE_LATEST_BASE_URL ?? LATEST_BASE,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      env,
      home,
    });
    const conversation = values.conversation ?? conversationId(env);
    const record = { ...result, conversation, checkedAt: now.toISOString(), ...(values.runtime ? { runtime: values.runtime } : {}) };
    // Checking again in the same conversation (after a compaction, say) keeps the
    // answer the person already gave for the same versions, so it is never asked twice.
    const previous = store.read();
    if (record.status === VersionStatus.Outdated && previous?.choice && previous.conversation === conversation && previous.versions === record.versions) {
      record.choice = previous.choice;
    }
    if (previous?.statusShown?.conversation === conversation) {
      record.statusShown = previous.statusShown;
    }
    try {
      store.write(record);
      if (!values.worktree && !values.state) {
        sweepStartup(home, now);
      }
    } catch (error) {
      record.recordError = error.message;
    }
    return { code: 0, output: { ...record, state: store.where } };
  }
  if (command === "status") {
    const connections = { closedloop: values.closedloop, graph: values.graph };
    if (!Object.values(connections).every((value) => Object.values(Connection).includes(value))) {
      throw new Error("--closedloop and --graph must each be connected or not-connected, from this conversation's own get-me and sync_status calls");
    }
    const conversation = values.conversation ?? conversationId(env);
    const record = store.read();
    if (record?.statusShown?.conversation === conversation) {
      return { code: 0, output: { print: false, reason: "the setup check was already shown in this conversation", state: store.where } };
    }
    const block = statusBlock(record?.conversation === conversation ? record : null, connections);
    store.write({ ...record, statusShown: { conversation, at: now.toISOString(), ...connections } });
    return { code: 0, output: { print: true, block, state: store.where } };
  }
  if (command === "show") {
    return { code: 0, output: store.read() ?? { status: null, state: store.where } };
  }
  if (command === "choose") {
    if (!Object.values(Choice).includes(values.choice)) {
      throw new Error("--choice must be update or proceed");
    }
    const by = values.by ?? "person";
    if (!CHOOSERS.includes(by)) {
      throw new Error(`--by must be one of ${CHOOSERS.join(", ")}`);
    }
    const record = store.read();
    if (record?.status !== VersionStatus.Outdated) {
      throw new Error(`there is nothing to choose: the recorded check is ${record?.status ?? "missing"}; run plugin-version.mjs check first`);
    }
    const choice = { choice: values.choice, by, at: now.toISOString(), ...(values.choice === Choice.Proceed ? { acceptedWorseResults: true } : {}) };
    store.write({ ...record, choice });
    return { code: 0, output: { ok: true, choice, state: store.where } };
  }
  if (command === "update") {
    const record = store.read();
    if (record?.choice?.choice !== Choice.Update) {
      throw new Error("the person has not chosen to update; record their answer with plugin-version.mjs choose --choice update first");
    }
    const vibe = (record.harnesses ?? []).flatMap((entry) => entry.plugins ?? [])
      .find((plugin) => plugin.name === "vibe" && plugin.status === VersionStatus.Outdated);
    // Named before the update, which removes the release their writers are bound to.
    const stranded = vibe ? writersBoundBefore(vibe.latest, home) : [];
    const result = updatePlugins(record, { clis, env, home });
    const reached = result.plugins.find((plugin) => plugin.plugin === "vibe" && plugin.status === "updated");
    if (stranded.length) {
      result.sessions = migrateStrandedWriters(stranded, reached?.after ?? null);
    }
    store.write({ ...record, update: { ...result, at: now.toISOString() } });
    return { code: result.status === "updated" ? 0 : 1, output: result };
  }
  throw new Error(`unknown command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { code, output } = await main(process.argv.slice(2), process.env, os.homedir());
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = code;
  } catch (error) {
    const command = process.argv.slice(2).find((word) => COMMANDS.includes(word)) ?? "check";
    // The check itself never fails a session; the other commands report a refusal.
    process.stdout.write(`${JSON.stringify(command === "check" ? { status: VersionStatus.Unknown, reason: error.message } : { ok: false, error: error.message })}\n`);
    process.exitCode = command === "check" ? 0 : 1;
  }
}

/**
 * Vibe sessions in the remembered symphony-alpha checkout whose persistent writer is bound to a vibe
 * release older than `latest`. An update removes that release from the plugin cache, which strands the
 * writer until it is migrated (ISS-13291). Never throws: an unreadable checkout or record lists nothing.
 */
export function writersBoundBefore(latest, home = os.homedir()) {
  const repo = readJson(path.join(home, ".codex", "vibe", "config.json"))?.repo;
  if (typeof repo !== "string" || !existsSync(repo)) {
    return [];
  }
  const sessions = [];
  for (const entry of vibeWorktrees(repo)) {
    const ledger = readLedger(entry.worktree);
    const agentRoot = ledger?.binding?.agentRoot;
    if (typeof agentRoot !== "string" || path.basename(path.dirname(agentRoot)) !== "vibe") {
      continue;
    }
    const recordedVersion = path.basename(agentRoot);
    if (compareVersions(recordedVersion, latest) !== -1) {
      continue;
    }
    sessions.push({
      slug: entry.branch.slice(VIBE_BRANCH.length), worktree: entry.worktree, runtime: ledger.runtime,
      workerId: ledger.workerId, digest: ledger.binding.digest, agentRoot, recordedVersion,
      running: Boolean(ledger.active?.lease), blocked: ledger.active?.status === "BLOCKED",
    });
  }
  return sessions.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Migrates each stranded writer it can with the updated release's own `writer-state.mjs migrate`, found
 * beside the recorded release in the same plugin cache; the rest migrate when their session resumes
 * (vibe quality loop, "Recorded definition migration"). Never throws.
 */
export function migrateStrandedWriters(sessions, afterVersion) {
  return sessions.map((session) => {
    const named = { slug: session.slug, worktree: session.worktree, runtime: session.runtime,
      recordedVersion: session.recordedVersion, blocked: session.blocked };
    const onResume = (reason) => ({ ...named, migration: StrandedMigration.OnResume, reason });
    if (session.running) {
      return onResume("a writer turn is still running");
    }
    if (session.runtime !== Harness.Claude) {
      return onResume("a Codex writer needs the new held writer its session starts");
    }
    const agentRoot = path.join(path.dirname(session.agentRoot), afterVersion ?? "");
    const command = path.join(agentRoot, "skills", "vibe", "scripts", "dist", "writer-state.mjs");
    if (!afterVersion || !existsSync(command)) {
      return onResume(`vibe ${afterVersion ?? "(unknown)"} is not beside ${session.recordedVersion} in the plugin cache`);
    }
    try {
      const output = execFileSync(process.execPath, [command, "migrate"], {
        input: JSON.stringify({ worktree: session.worktree, runtime: session.runtime, agentRoot, agentName: "vibe-change-worker",
          previousWorkerId: session.workerId, previousDigest: session.digest }),
        encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"],
      });
      return { ...named, migration: StrandedMigration.Migrated, workerId: JSON.parse(output).workerId };
    } catch (error) {
      const reason = firstLine(error.stderr) || error.message;
      // The recorded release is still installed, so its writer still runs until it is removed.
      return reason.includes("present and matching") ? onResume(reason) : { ...named, migration: StrandedMigration.Failed, reason };
    }
  });
}

function vibeWorktrees(repo) {
  let porcelain;
  try {
    porcelain = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  const entries = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries.filter((entry) => entry.branch?.startsWith(VIBE_BRANCH) && existsSync(entry.worktree));
}

function readLedger(worktree) {
  try {
    const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return readJson(path.join(gitDir, "vibe-writer.json"));
  } catch {
    return null;
  }
}
