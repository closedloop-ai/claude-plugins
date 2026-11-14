#!/usr/bin/env node
// The optional vibe provider: a plugin installed beside vibe, in vibe's marketplace, that carries one
// tracker's, organization's or repository's knowledge (its tickets, plans, code graph, repository memory and
// repository recipes). vibe and fleet run without one, in any repository; with one bound they also follow
// its text and data. This module is the only code that finds a provider, reads its contract or opens its
// files, so nothing reaches a provider that is disabled, absent or unbound.
//
// Detection runs once at a vibe or fleet start or resume (plugin-version.mjs check): `probeProvider` reads
// the harness's own install and settings files, never a plugin listing that drops disabled rows. The
// result, the binding, is saved with the conversation's startup record and copied into the session
// record; workers, scripts and hooks read the binding and never probe. A provider counts only when:
// - exactly one enabled plugin beside vibe has a provider.json speaking PROVIDER_PROTOCOL;
// - in Claude Code its skill is in this session's skill list (the session keeps the plugin set it started
//   with until the person restarts or runs /reload-plugins);
// - each capability's own needs hold: a connection the conversation proved, or a file the repository
//   commits to opt in.
// The probe names no provider; it reads what the contract declares.
//
// Usage:
//   provider.mjs show   [--worktree <wt>] [--conversation <id>]          the binding, as JSON
//   provider.mjs assemble [--blocks] [--worktree <wt>] [--conversation <id>] <file>
//   provider.mjs block  [--worktree <wt>] [--conversation <id>] <capability> <file> <id>
//   provider.mjs path   [--worktree <wt>] [--conversation <id>] <capability> <file>
//   provider.mjs data   [--worktree <wt>] [--conversation <id>] <capability> <key>
//   provider.mjs tree   [--worktree <wt>] [--vibe-root <dir>]                  the bind-time provider text folder
// `block` prints one block of a provider reference; `path` prints the absolute path of a whole provider
// reference (provider text names one as `provider:<file>`), relative to its references folder; `data`
// prints one contract data value as JSON; `assemble` prints the path of `file` rendered for the binding (with
// `--blocks`, of only the blocks it serves, for a file already in context). Each exits 3 with one `provider: ...` line when no provider with
// that capability is bound, so a generic session reads nothing. In a session bound to a provider whose text
// cannot be read (the provider is gone, a block or reference is missing, any other error), each exits 4 with
// one `provider-broken: ...` line naming the reason and the fix, and the step stops instead of going generic.
// In a session bound to a provider, exit 3 is a stop too: only an unbound session follows the generic text.
// `tree` prints the folder `check` wrote for this repository's main checkout (or, outside a checkout, the working
// folder) and binding (writeProviderTree), or exits 3 with why it cannot be used (none written, another repository,
// another vibe install), meaning: run the check again.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ownPluginRoot, pluginManifest, siblingPluginInstall, siblingPluginNames, siblingPluginRootOrNull } from "../../../shared/plugin-roots.mjs";
import { pluginEnabled } from "../../../shared/vibe-install.mjs";
import { harnessActor } from "./harness-identity.mjs";
import { sessionRecordPath } from "./session-record.mjs";
import { startupFile } from "./startup-record.mjs";

export const PROVIDER_PROTOCOL = 1;
export const CONTRACT_FILE = "provider.json";
export const ProviderState = Object.freeze({ None: "none", Bound: "bound", Disconnected: "bound-disconnected", Unprobed: "unprobed" });
const UNPROBED_REASON = "the plugin version check ran without connection states";
const UNPROBED_FIX = "make the calls it named and run it again first";
/** Why a step refuses while this chat's check left the installed provider unprobed: no state may read as generic. */
export const UNPROBED_REFUSAL = `${UNPROBED_REASON}; ${UNPROBED_FIX}`;
/** What a provider can supply; a stub or call names one of these. */
export const Capability = Object.freeze({
  Tickets: "tickets",
  Plans: "plans",
  Graph: "graph",
  Memory: "memory",
  Recipes: "recipes",
});
const CAPABILITIES = new Set(Object.values(Capability));
const NEED = /^(connection|repo-file):(.+)$/;
const CONNECTION_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const REFERENCE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.md$/;
const MAX_CONTRACT_BYTES = 512 * 1024;
const PROVIDER_STUB = /^> Provider `[a-z+]+` \(block `[a-z0-9-]+` of `[^`]+`\)/m;
const PROVIDER_STUB_LINES = /^> Provider `([a-z+]+)` \(block `([a-z0-9-]+)` of `([^`]+)`\)[^\n]*$/gm;
const PROVIDER_STUB_PARTS = /^> Provider `([a-z+]+)` \(block `([a-z0-9-]+)` of `([^`]+)`\)/;
const PROVIDER_STUB_DROP = /^> Provider `[a-z+]+` \(block `[a-z0-9-]+` of `[^`]+`\)[^\n]*(?:\n|$)/gm;
const GENERIC_REGION = /^<!-- generic: ([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- end generic: \1 -->\n/gm;
const URL_REFERENCE = String.raw`https?:\/\/\S+`;
const GITHUB_NUMBER = String.raw`(?<![\w/&])#\d+\b`;
// The rule region a file with provider stubs carries for a reader of the raw file, and the one-line form it replaced.
const PROVIDER_RULE = /^(?:<!-- provider-rule -->\n[\s\S]*?\n<!-- end provider-rule -->\n|Lines that start `> Provider` follow `[^`]*provider-text\.md`\.(?: [^\n]*)?\n)\n?/m;
const TEXT_DIR = [".codex", "vibe", "provider-text"];
const TEXT_INDEX = "index.json";
const TEXT_BINDING = "binding.json";
const BLOCKS_SUFFIX = ".blocks.md";
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

const EXIT_COMMAND = 2;
const EXIT_UNBOUND = 3;
const EXIT_BROKEN = 4;
const USAGE = "usage: provider.mjs show|block <capability> <file> <id>|path <capability> <relative>|data <capability> <key>"
  + "|assemble [--blocks] <file> [--worktree <wt>] [--conversation <id>]|tree [--worktree <wt>] [--vibe-root <dir>]";
const ASSEMBLED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A command line or vibe file the CLI cannot use: exit 2, never read as a provider answer. */
class CommandError extends Error {}

/** Thrown when a provider file or value is asked for without a bound provider that has the capability. */
export class ProviderUnavailable extends Error {}

/**
 * Thrown when a session bound to a provider cannot read that provider's text: the provider is gone, or a block or
 * reference it should hold is missing or unreadable. The step stops; it never falls back to the generic text.
 */
export class ProviderBroken extends Error {
  constructor(reason, name, fix = null) {
    super(`${reason}. Fix: ${fix ?? `reinstall or update the ${name ?? "provider"} plugin, then start a new chat so vibe binds it again`}`);
    this.name = "ProviderBroken";
  }
}

/** Whether `error` is a ProviderBroken, from this copy of the module or another. */
export function isProviderBroken(error) {
  return error instanceof ProviderBroken || error?.name === "ProviderBroken";
}

/** A script's exit code for `error` caught at its top level when it reports the error itself: 4 for a ProviderBroken. */
export function scriptExitCode(error, fallback) {
  return isProviderBroken(error) ? EXIT_BROKEN : fallback;
}

/**
 * For a script entry that catches nothing: an uncaught ProviderBroken prints its `provider-broken: ...` line and exits
 * 4, as provider.mjs answers; any other uncaught error still prints its stack and exits 1.
 */
export function exitOnProviderBroken() {
  const handle = (error) => {
    if (!isProviderBroken(error)) {
      process.stderr.write(`${error?.stack ?? String(error)}\n`);
      process.exit(1);
    }
    process.stdout.write(`provider-broken: ${error.message}\n`);
    process.exit(EXIT_BROKEN);
  };
  process.on("uncaughtException", handle);
  process.on("unhandledRejection", handle);
}

/**
 * A script's exit code for `error` caught at its top level: for a ProviderBroken, 4 with one `provider-broken: ...`
 * line on stdout, as provider.mjs answers; for anything else `fallback`, with the message on stderr.
 */
export function failScript(error, fallback) {
  if (isProviderBroken(error)) {
    process.stdout.write(`provider-broken: ${error.message}\n`);
    return EXIT_BROKEN;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return fallback;
}

// A script run with `--worktree <path>` works on that session, so its sessionBinding() reads that worktree first.
let activeWorktree = worktreeArgument(process.argv);
let leadBinding = null;

/** The contract at a plugin `root`, or null when it is not a provider vibe can speak to. */
export function readContract(root) {
  const file = path.join(root, CONTRACT_FILE);
  let stat;
  try { stat = statSync(file); } catch { return null; }
  if (stat.size > MAX_CONTRACT_BYTES) return null;
  // One validation per distinct contract text: every data lookup reads the contract, so a hook or script would
  // otherwise parse and validate it again on each one.
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const cached = contracts.get(file);
  if (cached?.text === text) return cached.contract;
  const contract = parseContract(root, text);
  if (!contracts.has(file) && contracts.size >= CONTRACT_CACHE_LIMIT) contracts.delete(contracts.keys().next().value);
  contracts.set(file, { text, contract });
  return contract;
}

const CONTRACT_CACHE_LIMIT = 8;
const contracts = new Map();

function parseContract(root, text) {
  try {
    const contract = JSON.parse(text);
    const manifest = pluginManifest(root);
    if (contract?.vibeProvider !== PROVIDER_PROTOCOL || manifest?.name !== contract.name) return null;
    if (typeof contract.skill !== "string" || typeof contract.references !== "string") return null;
    const capabilities = contract.capabilities;
    if (!capabilities || typeof capabilities !== "object" || Object.keys(capabilities).some((name) => !CAPABILITIES.has(name))) return null;
    for (const spec of Object.values(capabilities)) {
      if (!Array.isArray(spec?.needs) || spec.needs.some((need) => typeof need !== "string" || !NEED.test(need))) return null;
    }
    const connections = contract.connections ?? {};
    if (typeof connections !== "object" || Object.entries(connections).some(([name, spec]) => !CONNECTION_NAME.test(name)
      || typeof spec?.label !== "string" || typeof spec?.check !== "string")) return null;
    return contract;
  } catch {
    return null;
  }
}

/** The plugins beside vibe that ship a provider contract file this vibe cannot read (another protocol, or malformed). */
export function unreadableProviders({ from = import.meta.url } = {}) {
  const found = [];
  for (const name of siblingPluginNames({ from })) {
    let root;
    try { root = siblingPluginInstall(name, { from }).root; } catch { continue; }
    if (existsSync(path.join(root, CONTRACT_FILE)) && !readContract(root)) found.push(name);
  }
  return found;
}

/** Every plugin beside vibe that ships a provider contract, with its install and whether the harness has it on. */
export function installedProviders({ cwd = process.cwd(), from = import.meta.url } = {}) {
  const found = [];
  for (const name of siblingPluginNames({ from })) {
    let install;
    try {
      install = siblingPluginInstall(name, { from, cwd });
    } catch {
      continue;
    }
    const contract = readContract(install.root);
    if (!contract) continue;
    found.push({ name, root: install.root, version: pluginManifest(install.root)?.version ?? null,
      enabled: pluginEnabled(name, install, cwd), contract });
  }
  return found;
}

/**
 * The binding for a conversation in `cwd`: `connections` maps each connection name the contract declares to
 * "connected" when this conversation proved it (a call to it answered here), and `skillListed` is the provider's skill
 * name as the model saw it in its own skill list (`<plugin>:<skill>` or the bare `<skill>`), or null. Each capability
 * binds on its own needs; one withheld for an unanswered connection is listed in `withheld` and its connection in
 * `missing`. The provider is `bound-disconnected` only when none of its connection capabilities binds.
 */
export function probeProvider({ runtime, cwd = process.cwd(), connections = {}, skillListed = null, now = new Date(),
  providers = installedProviders({ cwd }) } = {}) {
  const probedAt = now.toISOString();
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length !== 1) {
    return { state: ProviderState.None, runtime, probedAt,
      reason: enabled.length > 1 ? "more than one provider is enabled" : providers.length ? "the provider is disabled" : "no provider is installed" };
  }
  const [provider] = enabled;
  const { contract } = provider;
  const base = { name: provider.name, version: provider.version, runtime, root: provider.root, probedAt,
    skill: `${provider.name}:${contract.skill}`, connections: contract.connections ?? {} };
  const missing = [];
  const capabilities = [];
  const withheld = [];
  const repo = repositoryRoot(cwd);
  for (const [capability, spec] of Object.entries(contract.capabilities)) {
    const unmet = spec.needs.filter((need) => !needMet(need, connections, repo));
    const unanswered = unmet.filter(isConnectionNeed);
    if (unmet.length === 0) {
      const problem = spec.needs.map((need) => optInProblem(need, repo, provider.name)).find(Boolean);
      if (problem) withheld.push({ capability, reason: problem });
      else capabilities.push(capability);
    } else if (unanswered.length) {
      missing.push(...unanswered);
      withheld.push({ capability, reason: notAnswered(unanswered) });
    } else {
      const file = unmet.find((need) => need.startsWith("repo-file:"));
      withheld.push({ capability, reason: `${file.slice("repo-file:".length)} is not in this repository` });
    }
  }
  if (runtime === "claude" && !skillNameListed(skillListed, provider.name, contract.skill)) {
    return { ...base, state: ProviderState.Disconnected, capabilities: [], missing: ["skill-listed"],
      reason: `${base.skill} is installed and on but not loaded in this session; restart Claude Code or run /reload-plugins` };
  }
  const uniqueMissing = [...new Set(missing)];
  const needsConnection = (capability) => contract.capabilities[capability].needs.some(isConnectionNeed);
  const connected = capabilities.some(needsConnection) || !Object.keys(contract.capabilities).some(needsConnection);
  if (!connected || capabilities.length === 0) {
    return { ...base, state: ProviderState.Disconnected, capabilities: [], missing: uniqueMissing, reason: notAnswered(uniqueMissing) };
  }
  return { ...base, state: ProviderState.Bound, capabilities, missing: uniqueMissing, ...(withheld.length ? { withheld } : {}) };
}

/** Whether the skill name the model saw in its list (`<plugin>:<skill>` or bare `<skill>`) is this provider's skill. */
export function skillNameListed(listed, name, skill) {
  return typeof listed === "string" && (listed === `${name}:${skill}` || listed === skill);
}

function isConnectionNeed(need) {
  return need.startsWith("connection:");
}

function notAnswered(needs) {
  return `not answered in this conversation: ${needs.map((need) => need.slice("connection:".length)).join(", ")}`;
}

const OPT_IN_LIMIT_BYTES = 64 * 1024;
const OPT_IN_KEYS = ["provider", "schema"];

/**
 * Why a present repository opt-in file does not opt in, or null. The file is `{"schema": 1, "provider": "<name>"}`
 * and nothing else; any other content withholds the capability with this one reason rather than binding it.
 */
export function optInProblem(need, repo, providerName) {
  const [, kind, value] = NEED.exec(need);
  if (kind !== "repo-file" || repo === null) return null;
  const file = path.join(repo, value);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > OPT_IN_LIMIT_BYTES) return `${value} is not a regular file under 64 KiB`;
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)
      || JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(OPT_IN_KEYS)) return `${value} must hold exactly "schema" and "provider"`;
    if (data.schema !== 1) return `${value} has schema ${JSON.stringify(data.schema)}, not 1`;
    if (data.provider !== providerName) return `${value} opts in to ${JSON.stringify(data.provider)}, not ${providerName}`;
    return null;
  } catch (error) {
    return error instanceof SyntaxError ? `${value} is not valid JSON` : `${value} could not be read`;
  }
}

/**
 * `binding` with its repository-file needs judged in the session repository `repo` instead of the chat's working
 * directory: each capability that needs a committed opt-in file binds only when `repo` (or, lacking the file, its main
 * checkout) holds a valid one, and is
 * listed in `withheld` with its one reason otherwise. A binding that is not bound comes back unchanged.
 */
export function bindForRepository(binding, repo) {
  if (binding?.state !== ProviderState.Bound || typeof binding.root !== "string" || !repo) return binding;
  const contract = readContract(binding.root);
  if (contract?.name !== binding.name) return binding;
  const capabilities = new Set(binding.capabilities ?? []);
  const unanswered = new Set(binding.missing ?? []);
  // A capability withheld for a connection this conversation did not answer stays withheld whatever the repository holds.
  const waiting = (capability) => contract.capabilities[capability]?.needs.some((need) => unanswered.has(need));
  const withheld = (binding.withheld ?? []).filter((entry) => waiting(entry.capability)
    || !contract.capabilities[entry.capability]?.needs.some((need) => need.startsWith("repo-file:")));
  for (const [capability, spec] of Object.entries(contract.capabilities)) {
    const files = spec.needs.filter((need) => need.startsWith("repo-file:"));
    if (!files.length || waiting(capability)) continue;
    const home = optInHome(repo, files);
    const missing = files.find((need) => !existsSync(path.join(home, need.slice("repo-file:".length))));
    const problem = missing ? `${missing.slice("repo-file:".length)} is not in this repository`
      : files.map((need) => optInProblem(need, home, binding.name)).find(Boolean);
    if (problem) { capabilities.delete(capability); withheld.push({ capability, reason: problem }); }
    else capabilities.add(capability);
  }
  const order = Object.keys(contract.capabilities).filter((capability) => capabilities.has(capability));
  const { withheld: _previous, ...rest } = binding;
  return { ...rest, capabilities: order, ...(withheld.length ? { withheld } : {}) };
}

/**
 * Where a session at `repo` finds its committed opt-in `files`: `repo` itself, else the repository's main checkout,
 * so a session branched before the repository committed its opt-in still reads the repository's answer.
 */
function optInHome(repo, files) {
  const present = (dir) => files.every((need) => existsSync(path.join(dir, need.slice("repo-file:".length))));
  if (present(repo)) return repo;
  const main = mainCheckout(repo);
  return main && present(main) ? main : repo;
}

/** The main checkout of the repository holding `dir` (the parent of its git common dir), or null when git cannot say. */
function mainCheckout(dir) {
  try {
    return path.dirname(execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim());
  } catch {
    return null;
  }
}

/**
 * What a check run with no connection states records while `candidate` names connections: an `unprobed` binding that
 * binds nothing and names each connection's call, so the check is run again with the states instead of reading as
 * generic. Null when the candidate needs no states (no provider, or a contract with no connections).
 */
export function unprobedBinding(candidate, { runtime, now = new Date() } = {}) {
  const connections = candidate?.state === "candidate" ? Object.entries(candidate.connections ?? {}) : [];
  if (!connections.length) return null;
  return { state: ProviderState.Unprobed, name: candidate.name, skill: candidate.skill, runtime, probedAt: now.toISOString(), capabilities: [],
    connectionsNeeded: connections.map(([name, spec]) => ({ name, label: spec.label, check: spec.check })),
    reason: `${candidate.name} is installed and the check had no connection states: make each call in connectionsNeeded, then run the check again `
      + "with one --connection <name>=<state> per entry" };
}

/**
 * The one enabled provider a start would bind, with the connection checks the model makes first, or why
 * there is none: `{ state: "candidate", name, skill, connections }` or `{ state: "none", reason }`.
 */
export function providerCandidate({ cwd = process.cwd(), providers = installedProviders({ cwd }), unreadable = unreadableProviders() } = {}) {
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length !== 1) {
    // A provider vibe cannot read is still installed: it is reported as that, never offered for install over it.
    const none = unreadable.length ? `the installed provider ${unreadable.join(", ")} has a contract this vibe cannot read` : "no provider is installed";
    return { state: ProviderState.None,
      reason: enabled.length > 1 ? "more than one provider is enabled" : providers.length ? "the provider is disabled" : none };
  }
  const [{ name, contract }] = enabled;
  return { state: "candidate", name, skill: `${name}:${contract.skill}`, connections: contract.connections ?? {} };
}

/**
 * The binding recorded for a session worktree or a conversation (worktree first), or null when neither has a record.
 * A record that exists but cannot be read throws ProviderBroken: it may hold a binding, so it is never read as none.
 */
export function recordedBinding({ worktree = null, conversation = null, home } = {}) {
  if (worktree) {
    let file = null;
    try { file = sessionRecordPath(worktree); } catch { file = null; } // Not a git checkout: fall back to the conversation.
    const binding = file ? recordBinding(file) : null;
    if (binding) return binding;
  }
  if (conversation) {
    let file;
    try { file = startupFile(conversation, home); } catch { return null; } // Not a conversation id this harness writes.
    return recordBinding(file);
  }
  return null;
}

function recordBinding(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.provider ?? null;
  } catch (error) {
    throw new ProviderBroken(`the record ${file} cannot be read (${error.code ?? error.message})`, null,
      `repair ${file} (it must be valid JSON), then run the step again`);
  }
}

/**
 * The binding a script in a session (or, before one exists, this conversation) reads: the worktree first (the one
 * given, else the one the script's entry point named with useSessionWorktree), then the harness conversation. A
 * worker launched as its own harness session has no conversation record, so the worktree is what binds it.
 */
export function sessionBinding(worktree = null, env = process.env) {
  return recordedBinding({ worktree: worktree ?? activeWorktree, conversation: harnessActor(env)?.id ?? null }) ?? leadBinding;
}

/**
 * The lead's binding a writer launch on another host was handed (codex-session.mjs `--lead-provider`): that host has
 * no chat of the lead's, so sessionBinding() reads this last.
 */
export function useLeadBinding(binding) {
  leadBinding = binding ?? null;
}

/** The binding `provider.mjs show` printed on the lead's host, checked; throws on anything else. */
export function parseLeadBinding(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("--lead-provider takes the JSON provider.mjs show prints"); }
  if (value?.state === ProviderState.None) return { state: ProviderState.None };
  const valid = value?.state === ProviderState.Bound && typeof value.name === "string" && /^[a-z0-9-]+$/.test(value.name)
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => typeof capability === "string")
    && (value.root === undefined || typeof value.root === "string");
  if (!valid) throw new Error("--lead-provider names neither a bound provider nor none");
  return { state: value.state, name: value.name, capabilities: value.capabilities, ...(value.root ? { root: value.root } : {}) };
}

/** Names the session worktree (a script's `--worktree`) that a later sessionBinding() without one reads first. */
export function useSessionWorktree(worktree) {
  activeWorktree = typeof worktree === "string" && worktree ? worktree : null;
}

/**
 * `binding` when it is bound with `capability` and its provider is still installed (where it was bound, or where an
 * update put it); null when the binding does not claim `capability`. A claimed provider removed since throws
 * ProviderBroken, so no caller mistakes a broken bound session for an unbound one. Disabling one takes effect at the
 * next start's probe; its files stay where the binding recorded them, so a session already bound keeps reading them.
 */
export function boundWith(binding, capability) {
  // An unprobed binding is neither bound nor generic: every read stops until the check runs again with the states.
  if (binding?.state === ProviderState.Unprobed) throw new ProviderBroken(UNPROBED_REASON, binding.name, UNPROBED_FIX);
  if (!claims(binding, capability)) return null;
  const root = currentRoot(binding);
  const contract = root ? readContract(root) : null;
  if (contract?.name !== binding.name) {
    throw new ProviderBroken(`the provider ${binding.name} this session is bound to is no longer installed at ${binding.root}`, binding.name);
  }
  return { ...binding, root, contract };
}

/**
 * Where the bound provider is now: the recorded root while it exists, or, when an update replaced that release, the
 * root of the same provider still installed and enabled. A provider removed since has none.
 */
function currentRoot(binding) {
  if (typeof binding.root === "string" && existsSync(binding.root)) return binding.root;
  if (!movedRoots.has(binding.name)) {
    let found = null;
    try { found = installedProviders().find((provider) => provider.name === binding.name && provider.enabled)?.root ?? null; }
    catch { found = null; }
    movedRoots.set(binding.name, found);
  }
  return movedRoots.get(binding.name);
}

const movedRoots = new Map();

/** `boundWith`, or a ProviderUnavailable naming what is missing. */
export function requireProvider(binding, capability) {
  const bound = boundWith(binding, capability);
  if (bound) return bound;
  throw new ProviderUnavailable(`no provider with ${capability} is bound to this session`);
}

/** The absolute path of reference `file` (relative to the bound provider's references folder, for `capability`). */
export function providerPath(binding, capability, file) {
  const bound = requireProvider(binding, capability);
  const references = path.resolve(bound.root, bound.contract.references);
  const resolved = path.resolve(references, String(file).replace(/^provider:/, ""));
  if (!resolved.startsWith(`${references}${path.sep}`)) throw new ProviderBroken(`${file} is outside the provider's references`, bound.name);
  return resolved;
}

/**
 * The block `id` of provider reference `file` (relative to its references folder), unchanged. `capability` may
 * join several with "+"; the block is read through the first one the binding holds.
 */
export function providerBlock(binding, capability, file, id) {
  const names = String(capability).split("+");
  const served = names.find((one) => boundWith(binding, one)) ?? names[0];
  const bound = requireProvider(binding, served);
  if (!REFERENCE.test(file) || !BLOCK_ID.test(id)) throw new ProviderBroken(`not a provider block: ${file} ${id}`, bound.name);
  const reference = providerPath(bound, served, file);
  let text;
  try {
    text = readFileSync(reference, "utf8");
  } catch (error) {
    throw new ProviderBroken(`${file} in ${bound.name} cannot be read (${error.code ?? error.message})`, bound.name);
  }
  const found = new RegExp(`<!-- block: ${id} -->\\n([\\s\\S]*?)\\n<!-- end: ${id} -->`).exec(text);
  if (!found) throw new ProviderBroken(`${file} in ${bound.name} has no block ${id}`, bound.name);
  return found[1];
}

/**
 * Markdown `text` as a reader with `binding` sees it: the rule pointer gone and, with the provider bound,
 * every `> Provider` stub replaced by its block and every generic region dropped; with none (or with a
 * capability unbound), the generic regions kept and the stubs dropped. A capability the binding claims whose provider
 * is gone or lacks the block throws ProviderBroken; it never falls back to the generic text. The same assembly as
 * tools/python/skill_split.py `assembled`.
 */
export function assembleProviderText(text, binding) {
  if (!PROVIDER_STUB.test(text)) return text;
  const body = text.replace(PROVIDER_RULE, "");
  const served = (capability) => servedCapability(binding, capability);
  const providerIds = new Set();
  for (const [, capability, id] of body.matchAll(PROVIDER_STUB_LINES)) {
    if (served(capability)) providerIds.add(id);
  }
  return body
    .replace(GENERIC_REGION, (_region, id, generic) => (providerIds.has(id) ? "" : `${generic}\n`))
    .replace(PROVIDER_STUB_DROP, (line) => {
      const [, capability, id, file] = PROVIDER_STUB_PARTS.exec(line);
      if (!served(capability)) return "";
      return `${providerBlock(binding, capability, file, id)}${line.endsWith("\n") ? "\n" : ""}`;
    });
}

/**
 * Every stub of `text` the binding serves, in file order, with its block: what a reader that already has `text` in
 * context (a loaded SKILL.md) puts in place of the generic region of the same id. Throws ProviderBroken as
 * assembleProviderText does.
 */
export function servedProviderBlocks(text, binding) {
  const blocks = [];
  for (const [, capability, id, file] of text.matchAll(PROVIDER_STUB_LINES)) {
    if (servedCapability(binding, capability)) blocks.push({ id, capability, file, text: providerBlock(binding, capability, file, id) });
  }
  return blocks;
}

/**
 * A reference to the work a change answers to, as a RegExp with `flags`: a URL always; with a tracker bound,
 * its slugs (`data.tickets.referencePattern`); with none, a GitHub `#123` issue or pull request.
 */
export function ticketReference(binding, flags = "") {
  const tracker = providerDataOr(binding, Capability.Tickets, "referencePattern", null);
  return new RegExp(`${tracker ?? GITHUB_NUMBER}|${URL_REFERENCE}`, flags);
}

/**
 * A hook rule the bound provider supplies as data (`data.guards[key]`, for vibe-core's guards), whatever capability
 * bound it; null with no provider bound. The provider ships rules, never hooks.
 */
export function providerGuardRule(binding, key) {
  for (const capability of CAPABILITIES) {
    const bound = boundWith(binding, capability);
    if (bound) return bound.contract.data?.guards?.[key] ?? null;
  }
  return null;
}

/** The contract's `data[capability][key]` from the bound provider, or undefined when it declares none. */
export function providerData(binding, capability, key) {
  return requireProvider(binding, capability).contract.data?.[capability]?.[key];
}

/** The label of connection `name` (`connections[name].label`) that the provider bound with `capability` declares, or null. */
export function connectionLabel(binding, capability, name) {
  return boundWith(binding, capability)?.contract.connections?.[name]?.label ?? null;
}

/** `providerData`, or `fallback` when no provider with `capability` is bound. */
export function providerDataOr(binding, capability, key, fallback) {
  const bound = boundWith(binding, capability);
  const value = bound?.contract.data?.[capability]?.[key];
  return value === undefined ? fallback : value;
}

function needMet(need, connections, repo) {
  const [, kind, value] = NEED.exec(need);
  if (kind === "connection") return connections[value] === "connected";
  return repo !== null && existsSync(path.join(repo, value));
}

function repositoryRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function main(argv) {
  let binding = null;
  try {
    const [command, ...rest] = argv;
    let parsed;
    try {
      parsed = parseArgs({ args: rest, allowPositionals: true,
        options: { worktree: { type: "string" }, conversation: { type: "string" }, blocks: { type: "boolean" }, "vibe-root": { type: "string" } } });
    } catch (error) {
      throw new CommandError(error.message);
    }
    const { values, positionals } = parsed;
    if (command === "tree" && positionals.length === 0) return treeCommand(values);
    binding = values.conversation
      ? recordedBinding({ worktree: values.worktree ?? null, conversation: values.conversation })
      : sessionBinding(values.worktree ?? null);
    // A checkout that holds no session (preflight names the repository's main checkout) is judged as that repository:
    // its own opt-in decides, not the folder the chat's check ran in.
    if (values.worktree && !recordedBinding({ worktree: values.worktree })) binding = bindForRepository(binding, values.worktree);
    if (command === "show") {
      process.stdout.write(`${JSON.stringify(binding ?? { state: ProviderState.None })}\n`);
      return 0;
    }
    if (command === "block" && positionals.length === 3) {
      process.stdout.write(`${providerBlock(binding, ...positionals)}\n`);
      return 0;
    }
    if (command === "path" && positionals.length === 2) {
      process.stdout.write(`${providerPath(binding, ...positionals)}\n`);
      return 0;
    }
    if (command === "data" && positionals.length === 2) {
      process.stdout.write(`${JSON.stringify(providerData(binding, ...positionals) ?? null)}\n`);
      return 0;
    }
    if (command === "assemble" && positionals.length === 1) return assembleCommand(binding, positionals[0], values.blocks === true);
    throw new CommandError(USAGE);
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      const bound = binding?.state === ProviderState.Bound
        ? ` (this session is bound to ${binding.name} with ${(binding.capabilities ?? []).join(", ") || "nothing"}: stop this step, never follow the generic text)` : "";
      process.stdout.write(`provider: ${error.message}${bound}\n`);
      return EXIT_UNBOUND;
    }
    // A command error (usage, the vibe file itself) is no provider's fault, and nor is any error with no binding claimed.
    if (error instanceof CommandError || (!isProviderBroken(error) && binding?.state !== ProviderState.Bound)) {
      process.stderr.write(`provider.mjs: ${error?.message ?? error}\n`);
      return EXIT_COMMAND;
    }
    const broken = isProviderBroken(error) ? error
      : new ProviderBroken(`unexpected error reading the provider: ${error?.message ?? error}`, binding?.name);
    process.stdout.write(`provider-broken: ${broken.message}\n`);
    return EXIT_BROKEN;
  }
}

/**
 * `assemble <file>`: writes `file` as the binding renders it (or, with `blocks`, only the blocks it serves, each
 * labelled by id) to a content-keyed file outside the repository, rewritten on every call, and prints that path, so a
 * reader opens it in parts. Nothing is written when it fails. With `blocks` and no stub served, it answers as `block`
 * does for an unbound capability.
 */
function assembleCommand(binding, file, blocksOnly) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new CommandError(`${file} cannot be read (${error.code ?? error.message})`);
  }
  let output;
  if (blocksOnly) {
    const blocks = servedProviderBlocks(text, binding);
    if (!blocks.length && binding?.state !== ProviderState.Bound) {
      throw new ProviderUnavailable(`no provider bound to this session serves a stub of ${path.basename(file)}`);
    }
    output = blocks.map((block) => `<!-- block: ${block.id} -->\n${block.text}\n<!-- end: ${block.id} -->\n`).join("");
  } else {
    output = assembleProviderText(text, binding);
  }
  const directory = path.join(homedir(), ".codex", "vibe", "provider-text");
  const target = path.join(directory, `${createHash("sha256").update(output).digest("hex").slice(0, 16)}-${blocksOnly ? "blocks-" : ""}${path.basename(file)}`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    pruneAssembled(directory);
    writeFileSync(target, output, { mode: 0o600 });
  } catch (error) {
    throw new CommandError(`${target} cannot be written (${error.code ?? error.message})`);
  }
  process.stdout.write(`${target}\n`);
  return 0;
}

/** Drops assembled files no call has rewritten for a day, so the folder holds only current output. */
function pruneAssembled(directory, now = Date.now()) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (name === TEXT_INDEX) continue;
    try {
      const stat = statSync(file);
      if (stat.isFile() && now - stat.mtimeMs > ASSEMBLED_MAX_AGE_MS) rmSync(file, { force: true });
    } catch {
      // Another call removed or is rewriting it.
    }
  }
}

/**
 * Whether a stub naming `capability` takes its block: several joined with "+" are served when any one is bound, so a
 * missing connection withholds only the stubs that need nothing else. Throws ProviderBroken for a claimed one gone.
 */
function servedCapability(binding, capability) {
  return capability.split("+").some((one) => boundWith(binding, one));
}

/** Whether `binding` says this session is bound to a provider with `capability`, installed or not. */
function claims(binding, capability) {
  return binding?.state === ProviderState.Bound && Boolean(binding.capabilities?.includes(capability));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));

function worktreeArgument(argv) {
  const at = argv.indexOf("--worktree");
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith("--worktree="));
  return inline ? inline.slice("--worktree=".length) || null : null;
}

/** The folder under `home` that holds assembled provider text, per-read files and bind-time trees alike. */
export function providerTextDirectory(home = homedir()) {
  return path.join(home, ...TEXT_DIR);
}

/** The bind-time tree's folder name for a repository root and provider: the first 16 hex of their sha256. */
export function providerTreeKey(repoRoot, name) {
  return createHash("sha256").update(`${repoRoot}\0${name}`).digest("hex").slice(0, 16);
}

/** Where a vibe file's served blocks sit in a bind-time tree, beside its assembled copy. */
export function blocksFileName(relative) {
  return relative.replace(/\.md$/, BLOCKS_SUFFIX);
}

/**
 * Writes the whole vibe text a bound `binding` reads, once, at bind time: every Markdown file under `vibeRoot` with
 * provider stubs, assembled, at its own relative path, a blocks file beside each stubbed SKILL.md, and binding.json.
 * The tree is built in a temporary sibling folder and renamed into place, then index.json maps `repoRoot` to it.
 * Throws ProviderBroken when the provider's text cannot be assembled, and any other error when it cannot be written.
 */
export function writeProviderTree({ binding, repoRoot, vibeRoot, home = homedir(), now = new Date() }) {
  const root = realpathSync(repoRoot);
  const vibe = realpathSync(vibeRoot);
  const directory = providerTextDirectory(home);
  const key = providerTreeKey(root, binding.name);
  const files = [];
  for (const relative of markdownFiles(vibe)) {
    const text = readFileSync(path.join(vibe, relative), "utf8");
    if (!PROVIDER_STUB.test(text)) continue;
    files.push([relative, assembleProviderText(text, binding)]);
    if (path.basename(relative) === "SKILL.md") {
      files.push([blocksFileName(relative), servedProviderBlocks(text, binding)
        .map((block) => `<!-- block: ${block.id} -->\n${block.text}\n<!-- end: ${block.id} -->\n`).join("")]);
    }
  }
  const record = { repoRoot: root, provider: binding.name, versions: { vibe: pluginManifest(vibe)?.version ?? null,
    "vibe-core": ownPluginRoot(import.meta.url).version ?? null, provider: binding.version ?? null },
  vibeRoot: vibe, capabilities: binding.capabilities ?? [], checkedAt: now.toISOString() };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${key}.${process.pid}.${now.getTime()}.tmp`);
  const target = path.join(directory, key);
  try {
    for (const [relative, body] of files) {
      mkdirSync(path.dirname(path.join(temporary, relative)), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(temporary, relative), body, { mode: 0o600 });
    }
    writeFileSync(path.join(temporary, TEXT_BINDING), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    replaceDirectory(temporary, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  updateTextIndex(directory, (index) => ({ ...index, [root]: key }));
  return { folder: target, files: files.length };
}

/** Removes `repoRoot`'s bind-time tree and index entry; writes nothing when there is neither. */
export function clearProviderTree({ repoRoot, home = homedir() }) {
  const directory = providerTextDirectory(home);
  const index = readTextIndex(directory);
  let root;
  try { root = realpathSync(repoRoot); } catch { root = path.resolve(repoRoot); }
  const key = index[root];
  if (typeof key !== "string") return false;
  if (/^[0-9a-f]{16}$/.test(key)) rmSync(path.join(directory, key), { recursive: true, force: true });
  updateTextIndex(directory, (current) => {
    const { [root]: _removed, ...rest } = current;
    return rest;
  });
  return true;
}

/**
 * `check`'s step after it probes: a bound `binding` gets its tree written; any other state clears this repository's.
 * Never throws: `{ folder, files }`, `{ cleared }`, or `{ error, broken? }` with the reason (and, for a provider whose
 * text cannot be assembled, the `provider-broken` message with its fix).
 */
export function syncProviderTree({ binding, repoRoot, vibeRoot, home = homedir(), now = new Date() }) {
  try {
    if (!repoRoot) return { error: "the check did not run inside a repository, so no provider text was written" };
    if (binding?.state === ProviderState.Bound) return writeProviderTree({ binding, repoRoot, vibeRoot, home, now });
    return { cleared: clearProviderTree({ repoRoot, home }) };
  } catch (error) {
    return isProviderBroken(error) ? { error: error.message, broken: true } : { error: error?.message ?? String(error) };
  }
}

/**
 * The bind-time tree a session at `repoRoot` reads, checked: `{ folder, binding }` when index.json names one whose
 * binding.json has this repository root and this vibe root, else `{ reason }` (none written, another repository, or
 * another vibe install, such as an update since the check).
 */
export function providerTree({ repoRoot, vibeRoot, home = homedir() }) {
  const directory = providerTextDirectory(home);
  let root;
  let vibe;
  try { root = realpathSync(repoRoot); } catch { return { reason: `${repoRoot} is not a folder` }; }
  try { vibe = realpathSync(vibeRoot); } catch { return { reason: `${vibeRoot} is not a folder` }; }
  const key = readTextIndex(directory)[root];
  if (typeof key !== "string" || !/^[0-9a-f]{16}$/.test(key)) return { reason: `no provider text was written for ${root}` };
  const folder = path.join(directory, key);
  let record;
  try { record = JSON.parse(readFileSync(path.join(folder, TEXT_BINDING), "utf8")); } catch { return { reason: `${folder} has no readable ${TEXT_BINDING}` }; }
  if (record?.repoRoot !== root) return { reason: `${folder} was written for ${record?.repoRoot}, not ${root}` };
  if (record?.vibeRoot !== vibe) return { reason: `${folder} was written for vibe at ${record?.vibeRoot}, not ${vibe}` };
  return { folder, binding: record };
}

/** `tree`: prints the checked folder, or exits 3 with why it cannot be used, so the reader runs the check again. */
function treeCommand(values) {
  const repoRoot = providerTextRoot(values.worktree ?? process.cwd());
  const vibeRoot = values["vibe-root"] ?? siblingPluginRootOrNull("vibe", { from: import.meta.url });
  const found = vibeRoot ? providerTree({ repoRoot, vibeRoot }) : { reason: "vibe is not installed beside vibe-core" };
  if (found.folder) {
    process.stdout.write(`${found.folder}\n`);
    return 0;
  }
  process.stdout.write(`provider: ${found.reason}; run the plugin version check again\n`);
  return EXIT_UNBOUND;
}

/**
 * The folder a bind-time tree is keyed by for a session at `cwd`: the main checkout of its repository, so every
 * worktree of one repository shares a tree, or, outside any git checkout, `cwd` itself. Always a realpath.
 */
export function providerTextRoot(cwd) {
  const repo = repositoryRoot(cwd);
  const root = repo ? mainCheckout(repo) ?? repo : cwd;
  try { return realpathSync(root); } catch { return path.resolve(root); }
}

function markdownFiles(root, relative = "") {
  const found = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...markdownFiles(root, child));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(child);
  }
  return found.sort();
}

/** Moves `source` to `target`, replacing what is there: the old folder steps aside first, so `target` is never half written. */
function replaceDirectory(source, target) {
  const aside = `${target}.${process.pid}.old`;
  rmSync(aside, { recursive: true, force: true });
  const had = existsSync(target);
  if (had) renameSync(target, aside);
  try {
    renameSync(source, target);
  } catch (error) {
    if (had) renameSync(aside, target);
    throw error;
  }
  rmSync(aside, { recursive: true, force: true });
}

function readTextIndex(directory) {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, TEXT_INDEX), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function updateTextIndex(directory, change) {
  const next = change(readTextIndex(directory));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${TEXT_INDEX}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path.join(directory, TEXT_INDEX));
}
