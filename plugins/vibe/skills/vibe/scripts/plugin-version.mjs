#!/usr/bin/env node
// The startup version check for vibe and fleet-orchestrator sessions
// (operator rulings, 2026-10-16 and 2026-10-27). It finds every plugin from
// vibe's marketplace installed on this machine, in Claude Code and in Codex, compares each
// with the version on the marketplace's main branch, and records the result,
// the person's choice and any update in the session's state.
//
// Usage:
//   plugin-version.mjs [check]  [--runtime codex|claude] [state] [--claude <CLI>] [--codex <CLI>]
//                               [--latest-base <url>] [--timeout-ms <n>]
//                               [--connection <name>=connected|not-connected]... [--skill-listed <plugin>:<skill>]
//                               [--closedloop <state>] [--graph <state>]   (aliases of --connection tracker=<state>, graph=<state>)
//   plugin-version.mjs choose   --choice update|proceed [--by person|opening-message] [state]
//   plugin-version.mjs update   [state] [--claude <CLI>] [--codex <CLI>]
//   plugin-version.mjs loaded   --runtime codex|claude [state]
//   plugin-version.mjs pending  --conversation <id>     (written by the vibe hooks when a session starts)
//   plugin-version.mjs adopt    --worktree <path>       (vibe-sessions.mjs new does this itself)
//   plugin-version.mjs status   [--connection <name>=connected|not-connected]... [state]
//   plugin-version.mjs provider                         (the provider a start would bind, and its connection checks)
//   plugin-version.mjs show     [state]
// where [state] is --worktree <vibe session> (the session record's
// `pluginVersion`), --state <file> (a fleet program's plugin-version.json),
// or neither: this conversation's startup record under
// ~/.codex/vibe/plugin-version/, named by the conversation harness-identity.mjs
// resolves from CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID (--conversation overrides).
//
// `check` prints {"status":"current"|"outdated"|"unknown", "harnesses", "outdated",
// "versions", "reason"?} and always exits 0: no network, a refused, slow or
// garbled answer, or a CLI that cannot list its plugins makes the affected
// part `unknown` with its reason, and the session carries on. A harness is
// installed when its CLI is found and lists at least one plugin from vibe's marketplace;
// nothing is assumed. "Latest" is each plugin's manifest on main, located
// through main's own marketplace file, read over HTTPS with no clone.
//
// A check run again in the same conversation with the same outdated versions
// keeps the answer already recorded; a new conversation asks again.
// `loaded` records the installed vibe release whose current skill file this
// conversation has read, as the Skill or UserPromptSubmit hook observed it.
// Later checks preserve it, so fleet wake and prompt gates can refuse stale
// remembered steps after an in-place plugin update. Where no hook has recorded
// the conversation (Codex before its hooks are trusted) it records that the
// gate is not enforced instead of failing.
// `choose` records the person's answer. `proceed` records that they accepted
// that an outdated plugin could give worse results. `update` refuses unless
// the recorded choice is `update`; it refreshes the marketplace and updates
// each outdated plugin in every harness that has one (Claude Code, Codex, or
// both), lists the plugins again, and prints {"status":"updated"|"failed",
// "plugins", "restart", "commands"}, exiting 1 unless every plugin reached
// the latest version. `restart` names the harnesses that need a new session
// (Claude Code) or a reopened app (Codex) before the update takes effect.
// `status` prints the startup setup check block (operator ruling,
// 2026-10-27): the installed closedloop-core and vibe versions for each
// installed harness, each with the latest-version result from this
// conversation's `check` ("latest", "<version> available" or "couldn't check
// for a newer version"), and, when a provider is enabled, whether each
// connection its contract names answered a call made in this conversation.
// With no check of this conversation it reads the installed versions locally.
// It prints {"print":true,"block"} once per conversation and
// {"print":false} on every later call in it, a compaction included, so the
// block is never shown twice. `check` given --connection does the same in the
// same run, so startup is one command after the provider's connection calls.
// `check` also binds the optional provider for the conversation (vibe-core
// lib/vibe/scripts/provider.mjs `probeProvider`), saves the binding in the
// record as `provider`, and carries the provider install `offer` when one
// stands. `provider` prints what a start would bind, its connection calls and
// skill, for a model whose skill list cuts the provider skill's description short.
// In Codex's default sandbox (CODEX_SANDBOX_NETWORK_DISABLED=1) main cannot be
// read and the startup record cannot be saved: `check` then adds
// {"escalate":true,"justification"}, and the orchestrator runs the same
// command again with escalated permissions. A record that
// could not be saved is reported as `recordError`; the command still exits 0.
// When vibe itself is outdated, `sessions` names each vibe session in the
// remembered checkout whose writer is bound to an older vibe release, which
// the update strands, and migrates each Claude writer with the
// updated release's own writer-state.mjs: `migrated`, `on-resume` (a running
// turn, a Codex writer, or a recorded release still installed; the session
// migrates when it resumes) or `failed` with its reason.
// `vibe-sessions.mjs new` refuses to create a session while this
// conversation's record is outdated with no choice, and the vibe hooks refuse
// worker launches in Claude Code while it is (vibe-core's hooks/plugin-version-guard.mjs).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ownPluginRoot } from "../../../shared/plugin-roots.mjs";
import { vibeCore, vibeCoreProblem } from "../../../shared/vibe-core.mjs";
import { codexHookApproval, FIRST_SPLIT_VIBE, HookApproval, hookApprovalLine } from "./vibe-core-hooks.mjs";
import { BUNDLED_CODEX, findCli, installedPlugins, MARKETPLACE } from "./plugin-cli.mjs";
import { Choice, Connection, runWithoutVibeCore } from "./plugin-version-bootstrap.mjs";

// Without vibe-core (a Codex vibe update that did not add it) the modules below cannot load, so the
// command line reports the missing dependency and how to add it, and stops here.
const missingCore = vibeCoreProblem();
if (missingCore && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await runWithoutVibeCore(process.argv.slice(2), missingCore));
}

const { Harness, harnessActor } = await vibeCore("lib/vibe/scripts/harness-identity.mjs");
const { readSessionRecord, writeSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const startupRecord = await vibeCore("lib/vibe/scripts/startup-record.mjs");
const { bindForRepository, isProviderBroken, probeProvider, providerCandidate, providerTextRoot, ProviderState, scriptExitCode, syncProviderTree,
  UNPROBED_REFUSAL, unprobedBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { RELEASE_VERSION: VERSION, readJson, startupDir, writeJson } = startupRecord;
export const { VersionStatus, blockingProblem, compareVersions, installedVibeVersion, loadedSkillProblem, markPending,
  readStartupRecord, startupFile } = startupRecord;

export { BUNDLED_CODEX, findCli, installedPlugins, MARKETPLACE };
export const LATEST_BASE = "https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main";
export { Harness };
export { Choice, Connection };
export const StrandedMigration = Object.freeze({ Migrated: "migrated", OnResume: "on-resume", Failed: "failed" });
const VIBE_BRANCH = "vibe/";
const MANIFEST = Object.freeze({ claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json" });
const CATALOG = Object.freeze({ claude: ".claude-plugin/marketplace.json", codex: ".agents/plugins/marketplace.json" });
const CHOOSERS = Object.freeze(["person", "opening-message"]);
const COMMANDS = Object.freeze(["check", "choose", "update", "loaded", "pending", "adopt", "status", "show", "provider", "provider-install", "provider-match"]);
const CONNECTION_ARG = /^([a-z][a-z0-9-]{0,40})=(.+)$/;
/** The 1.1.86 check flags, each still accepted as `--connection <name>=<state>` for the connection it named. */
const CONNECTION_ALIASES = Object.freeze({ closedloop: "tracker", graph: "graph" });
const VIBE_ROOT = ownPluginRoot(import.meta.url).root;
const HARNESS_LABEL = Object.freeze({ claude: "Claude Code", codex: "Codex" });
const STATUS_PLUGINS = Object.freeze(["closedloop-core", "vibe", "vibe-core"]);
/**
 * Plugins another plugin needs installed in the same harness. vibe's hooks ship in vibe-core, and Codex
 * installs no plugin dependency, so a vibe update there can leave vibe-core, and every hook, missing.
 */
const REQUIRED_WITH = Object.freeze({ vibe: Object.freeze(["vibe-core"]) });
/** The release from which a plugin needs each REQUIRED_WITH plugin; an older vibe ships its own hooks. */
const REQUIRED_FROM = Object.freeze({ vibe: FIRST_SPLIT_VIBE });
const DEFAULT_TIMEOUT_MS = 5_000;
export const ESCALATION_JUSTIFICATION = "Check whether vibe is up to date";
const CLI_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 180_000;
const STARTUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_WORD = /^[\w@%+=:,./-]+$/;

/**
 * The skill release this conversation loaded. On the first check after an
 * upgrade, an old record has no explicit field, so its prior installed vibe
 * version is the only durable evidence of what the conversation had loaded.
 */
export function loadedSkillForCheck(previous, current, conversation, runtime, now = new Date()) {
  const recorded = previous?.loadedSkill;
  if ((recorded?.actorId === conversation || recorded?.conversation === conversation)
    && recorded?.runtime === runtime && VERSION.test(recorded.version ?? "")) return recorded;
  if (previous?.conversation === conversation) {
    const priorVersion = installedVibeVersion(previous, runtime);
    if (VERSION.test(priorVersion ?? "")) return { conversation, runtime, version: priorVersion, at: previous.checkedAt ?? now.toISOString(), inferred: true };
  }
  return null;
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
    .map((plugin) => ({ harness: entry.harness, plugin: plugin.name, installed: plugin.version, latest: plugin.latest,
      ...(plugin.missing ? { missing: true } : {}) })));
  const reasons = harnesses.flatMap((entry) => [
    ...(entry.reason ? [`${entry.harness}: ${entry.reason}`] : []),
    ...(entry.plugins ?? []).filter((plugin) => plugin.status === VersionStatus.Unknown).map((plugin) => `${entry.harness} ${plugin.name}: ${plugin.reason}`),
  ]);
  const found = harnesses.some((entry) => entry.installed);
  if (!found && reasons.length === 0) {
    reasons.push(`no ${MARKETPLACE} plugin is installed in Claude Code or Codex`);
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

/** "vibe: you have 1.0.52, the latest is 1.0.53" (or "vibe-core: not installed, ..."), once per plugin and version pair, in first-seen order. */
export function versionsText(outdated) {
  const seen = new Set();
  const parts = [];
  for (const entry of outdated) {
    const text = entry.missing
      ? `${entry.plugin}: not installed, the latest is ${entry.latest}`
      : `${entry.plugin}: you have ${entry.installed}, the latest is ${entry.latest}`;
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
      ...outdated.map((plugin) => [cli, "plugin", plugin.missing ? "install" : "update", plugin.id, ...(plugin.scope ? ["--scope", plugin.scope] : [])]),
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
    harnesses.push(await withHookApproval(await checkHarness(harness, clis[harness] ?? findCli(harness, env, home), latestBase, fetchText)));
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

/** This conversation's id from the harness (harness-identity.mjs), or "default" outside one. */
export function conversationId(env = process.env) {
  return harnessActor(env)?.id ?? "default";
}

/** Active harness for a conversation, or null outside Claude/Codex. */
export function conversationRuntime(env = process.env) {
  return harnessActor(env)?.runtime ?? null;
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
  if (record.provider?.state === ProviderState.Unprobed) throw new Error(UNPROBED_REFUSAL);
  const session = readSessionRecord(worktree);
  if (!session) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  // The provider binding travels with the session, so its workers, scripts and hooks read it and never probe.
  // The opt-in a recipe needs is the session repository's own, never the directory the check happened to run in.
  const provider = bindForRepository(adoptedProvider(session, record.provider), worktree);
  writeSessionRecord(worktree, { ...session, pluginVersion: record, ...(provider ? { provider } : {}) });
  return record;
}

/**
 * The startup setup check block: the installed closedloop-core and vibe versions for each
 * installed harness, from `record` (this conversation's check, or null when it has not run
 * here), then the two connections as this conversation's own calls found them.
 */
export function statusBlock(record, connections, labels = {}) {
  const lines = ["Setup check"];
  const harnesses = (record?.harnesses ?? []).filter((entry) => entry.installed !== false);
  if (harnesses.length === 0) {
    lines.push(record?.reason ? `- Plugins: couldn't read the installed versions (${record.reason})` : "- Plugins: none installed in Claude Code or Codex");
  }
  for (const entry of harnesses) {
    const label = HARNESS_LABEL[entry.harness] ?? entry.harness;
    if (!Array.isArray(entry.plugins)) {
      lines.push(`- ${label}: couldn't read its plugins`);
      continue;
    }
    const parts = STATUS_PLUGINS.map((name) => {
      const plugin = entry.plugins.find((candidate) => candidate.name === name);
      return plugin && !plugin.missing ? `${name} ${plugin.version ?? "(version unknown)"} (${latestNote(plugin)})` : `${name} not installed`;
    });
    lines.push(`- ${label}: ${parts.join(", ")}`);
    const approval = hookApprovalLine(entry.hookApproval);
    if (approval) lines.push(`- ${label}: ${approval}`);
  }
  const word = (value) => (value === Connection.Connected ? "connected" : "not connected");
  const unprobed = record?.provider?.state === ProviderState.Unprobed;
  for (const [name, spec] of Object.entries(labels)) {
    lines.push(unprobed ? `- ${spec.label} connection: not checked yet (${spec.check})` : `- ${spec.label} connection: ${word(connections[name])}`);
  }
  const text = record?.providerText;
  if (text?.broken) lines.push(`- Provider${record.provider?.name ? ` ${record.provider.name}` : ""}: ${text.error}`);
  else if (text?.error) lines.push(`- Provider text: not saved (${text.error})`);
  return lines.join("\n");
}

/**
 * The installed plugins from vibe's marketplace of every harness found on this machine, read locally with
 * no network, every one `unknown` against main: what the setup check shows when this
 * conversation has no check of its own.
 */
export function localInstalled({ clis = {}, env = process.env, home = os.homedir(), reason = "the latest version was not checked" } = {}) {
  return [Harness.Claude, Harness.Codex].map((harness) => {
    const cli = clis[harness] ?? findCli(harness, env, home);
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
    return { harness, cli, installed: true, plugins: listed.plugins.map((plugin) => ({ ...plugin, latest: null, status: VersionStatus.Unknown, reason })) };
  });
}

/**
 * True when this check ran inside Codex's sandbox and the sandbox stopped it: the turn's
 * sandbox has no network (Codex's default "Ask for approval" mode), and main could not be
 * reached or the record could not be written. Codex sets CODEX_SANDBOX_NETWORK_DISABLED for
 * every command of such a turn, escalated ones included (seen on codex-cli 0.163.0-alpha.11.2),
 * so the variable alone never decides it: an escalated run reaches main and saves.
 */
export function blockedBySandbox(result, recordError, env = process.env) {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") {
    return false;
  }
  return /EPERM|EACCES/.test(recordError ?? "") || /could not be reached/.test(result.reason ?? "");
}

/**
 * The setup check block for `own` (this conversation's check, or the local listing), once per
 * conversation: what to print, and the record to save (`stored` marked shown), or null when
 * `stored` says it was already shown here and nothing changes.
 */
function setupCheck(stored, own, connections, conversation, now, labels) {
  if (stored?.statusShown?.conversation === conversation) {
    return { output: { print: false, reason: "the setup check was already shown in this conversation" }, next: null };
  }
  return {
    output: { print: true, block: statusBlock(own, connections, labels) },
    next: { ...stored, statusShown: { conversation, at: now.toISOString(), ...connections } },
  };
}

function latestNote(plugin) {
  if (plugin.status === VersionStatus.Outdated) {
    return `${plugin.latest} available`;
  }
  if (plugin.status === VersionStatus.Current) {
    return "latest";
  }
  return "couldn't check for a newer version";
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
  const required = missingRequired(listed.plugins);
  const latest = await latestVersions(harness, [...listed.plugins, ...required].map((plugin) => plugin.name), latestBase, fetchText);
  if (latest.reason) {
    return { harness, cli, installed: true, reason: latest.reason, plugins: listed.plugins.map((plugin) => ({ ...plugin, latest: null, status: VersionStatus.Unknown, reason: latest.reason })) };
  }
  return { harness, cli, installed: true, plugins: [...comparePlugins(listed.plugins, latest.versions), ...compareMissing(required, latest.versions)] };
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

function hookRecord(conversation, home) {
  const record = readJson(path.join(home, ".vibe-hook-scope", `${conversation}.json`));
  return record?.sessionId === conversation ? record : null;
}

function hookRecordExists(conversation, home) {
  return hookRecord(conversation, home) !== null;
}

function observedLoadedSkill(conversation, home) {
  return hookRecord(conversation, home)?.loadedSkill ?? null;
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
      connection: { type: "string", multiple: true },
      ...Object.fromEntries(Object.keys(CONNECTION_ALIASES).map((flag) => [flag, { type: "string" }])),
      "skill-listed": { type: "string" },
      "latest-base": { type: "string" },
      "timeout-ms": { type: "string" },
      expect: { type: "string" },
    },
  });
  const command = positionals[0] ?? "check";
  const runtime = values.runtime ?? conversationRuntime(env);
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
  const connectionArgs = [...(values.connection ?? []), ...aliasedConnections(values)];
  const connections = parseConnections(connectionArgs);
  // The labels of the connections the enabled provider names; none when no provider is enabled.
  const candidate = providerCandidate({ cwd: process.cwd() });
  const labels = candidate.connections ?? {};
  if (command === "provider") {
    // Read-only: a start may run it inside a sandbox that refuses writes, so a provider seen here is recorded by the check.
    const offer = providerOffer(candidate, readProviderInstall(home));
    return { code: 0, output: { ...candidate, ...(offer ? { offer } : {}) } };
  }
  if (command === "provider-match") {
    const conversation = values.conversation ?? conversationId(env);
    return providerMatch(values.expect, readStartupRecord(conversation, home)?.provider ?? null);
  }
  if (command === "provider-install") {
    return installOfferedProvider({ candidate, connections, clis, env, home, now });
  }
  if (command === "loaded") {
    if (!Object.values(Harness).includes(runtime)) throw new Error("loaded needs --runtime codex or claude");
    const conversation = values.conversation ?? conversationId(env);
    const harnesses = localInstalled({ clis, env, home });
    const previous = store.read() ?? {};
    if (!hookRecordExists(conversation, home)) {
      // No hook has run in this conversation (Codex hooks run only once the person trusts them),
      // so nothing can observe a load: keep the earlier behavior rather than block every session.
      const record = { ...previous, conversation, runtime, harnesses, loadedSkillRequired: false };
      delete record.loadedSkill;
      delete record.reloadRequired;
      store.write(record);
      return { code: 0, output: { ok: true, loadedSkill: null, enforced: false, reason: "no hook has recorded this conversation, so loaded-skill evidence is not enforced", state: store.where } };
    }
    const loadedSkill = observedLoadedSkill(conversation, home);
    if (!loadedSkill || loadedSkill.actorId !== conversation || loadedSkill.runtime !== runtime) {
      throw new Error("the current Skill/UserPrompt hook has not observed this actor loading vibe or fleet");
    }
    const record = { ...previous, conversation, runtime, harnesses, loadedSkill, loadedSkillRequired: true };
    delete record.reloadRequired;
    store.write(record);
    return { code: 0, output: { ok: true, loadedSkill, enforced: true, state: store.where } };
  }
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
    const previous = store.read();
    const record = { ...result, conversation, checkedAt: now.toISOString(), ...(runtime ? { runtime } : {}),
      provider: (connectionArgs.length ? null : unprobedBinding(candidate, { runtime, now }))
        ?? probeProvider({ runtime, cwd: process.cwd(), connections, skillListed: values["skill-listed"] ?? null, now }) };
    const unprobed = record.provider.state === ProviderState.Unprobed;
    // An unprobed check binds nothing and leaves the provider text as it is until the check runs with the states.
    if (!unprobed) {
      const binding = values.worktree ? bindForRepository(record.provider, values.worktree) : record.provider;
      const text = syncProviderTree({ binding, repoRoot: providerTextRoot(values.worktree ?? process.cwd()), vibeRoot: VIBE_ROOT, home, now });
      if (text.error) record.providerText = text;
      else if (text.folder) record.providerText = { folder: text.folder };
    }
    // Load evidence is enforced only where a hook has recorded this conversation; without one
    // (Codex hooks not trusted yet) the check behaves as it did before loaded-skill evidence.
    if (runtime && hookRecordExists(conversation, home)) {
      record.loadedSkillRequired = true;
      record.loadedSkill = observedLoadedSkill(conversation, home) ?? loadedSkillForCheck(previous, record, conversation, runtime, now);
      const problem = loadedSkillProblem(record);
      if (problem) record.reloadRequired = { loaded: record.loadedSkill.version, installed: installedVibeVersion(record, runtime), problem };
    }
    // Checking again in the same conversation (after a compaction, say) keeps the
    // answer the person already gave for the same versions, so it is never asked twice.
    if (record.status === VersionStatus.Outdated && previous?.choice && previous.conversation === conversation && previous.versions === record.versions) {
      record.choice = previous.choice;
    }
    if (previous?.statusShown?.conversation === conversation) {
      record.statusShown = previous.statusShown;
    }
    const shown = setupCheck(record, record, connections, conversation, now, labels);
    // The block of an unprobed check is not the one the person keeps: the rerun with the states shows it again.
    if (unprobed) shown.next = null;
    let recordError;
    try {
      store.write(shown.next ?? record);
      if (!values.worktree && !values.state) {
        sweepStartup(home, now);
      }
    } catch (error) {
      recordError = error.message;
    }
    // In Codex's default sandbox main cannot be read and the record cannot be saved; the
    // orchestrator reruns this same command with escalated permissions (one "Allow once"),
    // and that run's block is the one the person sees.
    const escalating = blockedBySandbox(record, recordError, env);
    if (escalating && shown.next && !recordError) {
      try {
        store.write(record);
      } catch {
        // The escalated rerun saves it.
      }
    }
    const escalate = escalating ? { escalate: true, justification: ESCALATION_JUSTIFICATION } : {};
    const offer = startOffer(candidate, home, now);
    // The record's own `reason` (why the versions are unknown) wins over the already-shown note.
    const block = shown.output.print ? shown.output : { print: false };
    const needed = unprobed ? { connectionsNeeded: record.provider.connectionsNeeded } : {};
    return { code: 0, output: { ...record, ...block, ...needed, ...(offer ? { offer } : {}), ...(recordError ? { recordError } : {}), ...escalate,
      state: store.where } };
  }
  if (command === "status") {
    const conversation = values.conversation ?? conversationId(env);
    const record = store.read();
    // A conversation whose own check never ran or never saved still shows the versions
    // installed here, read locally, never "has not run" with no versions.
    const own = record?.conversation === conversation ? record
      : { harnesses: await Promise.all(localInstalled({ clis, env, home }).map(withHookApproval)) };
    const shown = setupCheck(record, own, connections, conversation, now, labels);
    let recordError;
    try {
      if (shown.next) {
        store.write(shown.next);
      }
    } catch (error) {
      recordError = error.message;
    }
    return { code: 0, output: { ...shown.output, ...(recordError ? { recordError } : {}), state: store.where } };
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
    // Asked of Codex after the update, so an approval the update made necessary is named, and nothing when none is.
    const codex = await withHookApproval(afterUpdate(record, result, Harness.Codex));
    const approval = hookApprovalLine(codex?.hookApproval);
    if (approval) result.hookApproval = approval;
    const reached = result.plugins.find((plugin) => plugin.plugin === "vibe" && plugin.status === "updated");
    if (stranded.length) {
      result.sessions = migrateStrandedWriters(stranded, reached?.after ?? null);
    }
    store.write({ ...record, update: { ...result, at: now.toISOString() } });
    return { code: result.status === "updated" ? 0 : 1, output: result };
  }
  throw new Error(`unknown command ${command}`);
}

// Fields only a provider session wrote before bindings were recorded: its tickets and plan, its hosted environment
// (mode, Vercel, the environment's org under its old and new names) and its flag snapshot. A generic session has none.
const LEGACY_PROVIDER_FIELDS = ["liveTicket", "handoffTicket", "livePlan", "mode", "vercel", "clerkOrgId", "environmentOrgId", "flagSnapshot"];

/**
 * The one provider vibe installs for the person (operator ruling on the install default): only when no provider was
 * ever installed here, vibe never installed it before (so an uninstall stays), and the provider's tracker connection
 * answered in this conversation. vibe never re-enables a disabled provider and never reinstalls a removed one.
 */
export const OFFERED_PROVIDER = Object.freeze({ name: "vibe-closedloop-provider", connection: "tracker",
  label: "ClosedLoop", check: "Call ClosedLoop `get-me`; connected only when it answered in this conversation." });

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { code, output } = await main(process.argv.slice(2), process.env, os.homedir());
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = code;
  } catch (error) {
    const command = process.argv.slice(2).find((word) => COMMANDS.includes(word)) ?? "check";
    // The check never fails a start, a broken provider included: it shows the setup check with the reason, and only a
    // later step that needs the provider stops. Every other command reports its refusal, a broken provider with exit 4.
    const failed = { status: VersionStatus.Unknown, reason: error.message };
    const providerText = isProviderBroken(error) ? { error: error.message, broken: true } : undefined;
    process.stdout.write(`${JSON.stringify(command === "check" ? { ...failed, print: true, block: statusBlock({ ...failed, providerText }, {}) }
      : { ok: false, error: error.message })}\n`);
    process.exitCode = command === "check" ? 0 : scriptExitCode(error, 1);
  }
}

/**
 * Vibe sessions in the remembered checkout whose persistent writer is bound to a vibe
 * release older than `latest`. An update removes that release from the plugin cache, which strands the
 * writer until it is migrated. Never throws: an unreadable checkout or record lists nothing.
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

/** The plugins `REQUIRED_WITH` names for an installed one that this harness lacks, carrying its scope and marketplace. */
export function missingRequired(plugins) {
  const names = new Set(plugins.map((plugin) => plugin.name));
  return plugins.filter((plugin) => (compareVersions(plugin.version, REQUIRED_FROM[plugin.name] ?? "0.0.0") ?? -1) >= 0)
    .flatMap((plugin) => (REQUIRED_WITH[plugin.name] ?? []).filter((name) => !names.has(name)).map((name) => ({
    name, id: `${name}@${MARKETPLACE}`, version: null, missing: true,
    ...(plugin.scope ? { scope: plugin.scope } : {}), ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
  })));
}

/**
 * A missing required plugin is outdated against main's version, so the person's update installs it; one main's
 * marketplace does not list is not required there, and one whose manifest could not be read is unknown.
 */
function compareMissing(required, latest) {
  return required.filter((plugin) => latest.has(plugin.name)).map((plugin) => {
    const found = latest.get(plugin.name);
    return found.version
      ? { ...plugin, latest: found.version, status: VersionStatus.Outdated }
      : { ...plugin, latest: null, status: VersionStatus.Unknown, reason: found.reason };
  });
}

/**
 * `entry` with `hookApproval` from Codex's own hooks/list when it is the Codex harness and its vibe runs
 * vibe-core's hooks (FIRST_SPLIT_VIBE or newer); every other entry is returned unchanged.
 */
export async function withHookApproval(entry) {
  const vibe = entry?.plugins?.find((plugin) => plugin.name === "vibe");
  if (entry?.harness !== Harness.Codex || !entry.cli || (compareVersions(vibe?.version, FIRST_SPLIT_VIBE) ?? -1) < 0) return entry;
  const installed = entry.plugins.some((plugin) => plugin.name === "vibe-core" && !plugin.missing);
  return { ...entry, hookApproval: installed ? await codexHookApproval(entry.cli) : { state: HookApproval.Missing } };
}

/** `harness`'s entry in `record` with the versions `result` (an update) reached, without listing the plugins again. */
function afterUpdate(record, result, harness) {
  const entry = (record.harnesses ?? []).find((candidate) => candidate.harness === harness && Array.isArray(candidate.plugins));
  if (!entry) return null;
  const reached = new Map(result.plugins.filter((plugin) => plugin.harness === harness && plugin.after).map((plugin) => [plugin.plugin, plugin.after]));
  return { ...entry, plugins: entry.plugins.map((plugin) => reached.has(plugin.name)
    ? { ...plugin, version: reached.get(plugin.name), missing: false } : plugin) };
}

/** The `--connection` arguments the alias flags given stand for. */
function aliasedConnections(values) {
  return Object.entries(CONNECTION_ALIASES).filter(([flag]) => values[flag] !== undefined).map(([flag, name]) => `${name}=${values[flag]}`);
}

/** `--connection <name>=<state>` arguments as `{ name: state }`; a state is connected or not-connected. */
function parseConnections(args) {
  const connections = {};
  for (const arg of args) {
    const match = CONNECTION_ARG.exec(arg);
    if (!match || !Object.values(Connection).includes(match[2])) {
      throw new Error(`--connection ${arg}: give <name>=connected or <name>=not-connected, from a call made in this conversation`);
    }
    connections[match[1]] = match[2];
  }
  return connections;
}

/** Where vibe records the provider install it ran, so a later start never repeats it. */
export function providerInstallFile(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "provider-install.json");
}

/** vibe's own recorded provider install, or null. */
export function readProviderInstall(home = os.homedir()) {
  try { return readJson(providerInstallFile(home)); } catch { return null; }
}

/** The install offer a start shows, or null; a provider seen installed here (enabled or not) is recorded so it is never offered. */
function startOffer(candidate, home, now) {
  if (candidate.state === "candidate" || candidate.reason !== "no provider is installed") markProviderSeen(home, now);
  return providerOffer(candidate, readProviderInstall(home));
}

/** Records that a provider was installed here, once; vibe's own install record already counts. */
export function markProviderSeen(home = os.homedir(), now = new Date()) {
  if (readProviderInstall(home)) return false;
  try { writeJson(providerInstallFile(home), { seenAt: now.toISOString() }); return true; } catch { return false; }
}

/** The install offer for a start: present only when nothing was ever installed and vibe has no install on record. */
export function providerOffer(candidate, installed) {
  if (candidate?.state !== "none" || candidate.reason !== "no provider is installed" || installed) return null;
  const { name, connection, label, check } = OFFERED_PROVIDER;
  return { name, connection, label, check };
}

/** The install commands, one per harness where vibe is installed: Claude Code's `plugin install`, Codex's `plugin add`. */
export function providerInstallCommands(harnesses) {
  return (harnesses ?? []).flatMap((entry) => {
    const vibe = entry.installed === true ? entry.plugins?.find((plugin) => plugin.name === "vibe") : null;
    if (!vibe || !entry.cli) return [];
    const id = `${OFFERED_PROVIDER.name}@${MARKETPLACE}`;
    return [entry.harness === Harness.Claude
      ? [entry.cli, "plugin", "install", id, ...(vibe.scope ? ["--scope", vibe.scope] : [])]
      : [entry.cli, "plugin", "add", id]];
  });
}

/**
 * `provider-install --connection <tracker>=connected`: runs the offered install and records it. Refused unless the
 * offer stands and its connection answered in this conversation; a failed command is reported, never retried here.
 */
export function installOfferedProvider({ candidate, connections, clis = {}, env = process.env, home = os.homedir(), now = new Date(),
  harnesses = null, run = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: UPDATE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }) }) {
  const offer = providerOffer(candidate, readProviderInstall(home));
  if (!offer) return { code: 1, output: { ok: false, installed: false, reason: "no install offer stands: a provider is installed, disabled, or vibe installed it before" } };
  if (connections[offer.connection] !== Connection.Connected) {
    return { code: 1, output: { ok: false, installed: false, reason: `the ${offer.label} connection did not answer in this conversation` } };
  }
  const commands = providerInstallCommands(harnesses ?? localInstalled({ clis, env, home }));
  if (!commands.length) return { code: 1, output: { ok: false, installed: false, reason: "vibe is installed in no local harness to install the provider beside" } };
  const failures = [];
  for (const argv of commands) {
    try { run(argv); } catch (error) { failures.push(`${argv.slice(0, 4).join(" ")} failed: ${firstLine(error.stderr) || error.message}`); }
  }
  const ran = commands.map((argv) => argv.map(shellWord).join(" "));
  if (failures.length < commands.length) writeJson(providerInstallFile(home), { name: offer.name, installedAt: now.toISOString(), commands: ran });
  return { code: failures.length ? 1 : 0, output: { ok: failures.length === 0, installed: failures.length < commands.length, commands: ran, failures,
    next: "the provider binds at the next vibe or fleet start, in a new chat" } };
}

/**
 * The binding a session keeps when a chat adopts it. A session keeps the binding it has (a generic session stays
 * generic, a bound one stays bound), except that a provider that was bound but disconnected, or bound with a connection
 * missing, rebinds when this chat bound the same provider with more capabilities. A session with none takes this chat's, unless it is a provider session from before
 * bindings were recorded and this chat bound nothing: it then waits for a chat that binds, and is never written as
 * generic.
 */
export function adoptedProvider(session, chat) {
  const current = session?.provider;
  if (current?.state === ProviderState.Unprobed && chat) return chat;
  if (current) {
    const more = (chat?.capabilities?.length ?? 0) > (current.capabilities?.length ?? 0);
    const partial = current.state === "bound-disconnected" || (current.state === "bound" && (current.missing?.length ?? 0) > 0 && more);
    const rebinds = partial && chat?.state === "bound" && chat.name === current.name;
    return rebinds ? chat : current;
  }
  if (!chat) return null;
  if (chat.state !== "bound" && LEGACY_PROVIDER_FIELDS.some((field) => session?.[field])) return null;
  return chat;
}

/**
 * `provider-match --expect <name|none>`: whether this chat is bound as the lead that briefed it was (its brief's
 * `Provider:` line). A writer works only under the lead's binding; a mismatch exits 1 with the reason to report.
 */
export function providerMatch(expected, binding) {
  if (typeof expected !== "string" || !expected.trim()) return { code: 1, output: { ok: false, reason: "provider-match needs --expect <provider name or none>" } };
  const actual = binding?.state === "bound" && binding.name ? binding.name : "none";
  const ok = actual === expected.trim();
  return { code: ok ? 0 : 1, output: { ok, expected: expected.trim(), actual,
    ...(ok ? {} : { reason: `the lead was bound as ${expected.trim()} and this chat is bound as ${actual}; a writer works only under the lead's binding` }) } };
}
