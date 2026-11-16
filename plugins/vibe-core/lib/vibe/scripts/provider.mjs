#!/usr/bin/env node
// The optional vibe provider: one tracker's, organization's or repository's knowledge (its tickets, plans, code
// graph, repository memory and repository recipes), built into a vibe release as `provider/provider.json` and its
// reference files. vibe and fleet run without one, in any repository; with one bound they also use its data. This
// module is the only code that finds the provider, reads its contract or opens its files, so nothing reaches a
// provider that is absent or unbound.
//
// Detection runs once at a vibe or fleet start or resume (plugin-version.mjs check): `probeProvider` reads the
// contract in vibe's own install. The result, the binding, is saved with the conversation's startup record and
// copied into the session record; workers, scripts and hooks read the binding and never probe. Each capability binds
// on its own needs: a connection the conversation proved, or a file the repository commits to opt in. The probe
// names no provider; it reads what the contract declares.
//
// Usage:
//   provider.mjs show [--worktree <wt>] [--conversation <id>]                    the binding, as JSON
//   provider.mjs data [--worktree <wt>] [--conversation <id>] <capability> <key>
// `data` prints one contract data value as JSON. It exits 3 with one `provider: ...` line when no provider with that
// capability is bound. In a session bound to a provider that cannot be read (the provider is gone, its contract is
// unreadable, any other error), it exits 4 with one `provider-broken: ...` line naming the reason and the fix, and the
// step stops instead of going generic. `tree`, `assemble`, `block` and `path`, which an older vibe release's text
// runs, each exit 4 with one `provider-broken: ...` line: a release carries its provider's text in its own files.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint, isVibePlugin, ownPluginRoot, pluginManifest, siblingInstalls, VIBE_PLUGIN_NAMES } from "../../../shared/plugin-roots.mjs";
import { vibeRoot as installedVibeRoot } from "../../../shared/vibe-install.mjs";
import { harnessActor } from "./harness-identity.mjs";
import { sessionRecordPath } from "./session-record.mjs";
import { startupFile } from "./startup-record.mjs";

export const PROVIDER_PROTOCOL = 1;
export const CONTRACT_FILE = "provider.json";
/** The folder of vibe's own install that holds a provider built into it at release. */
export const BUNDLED_PROVIDER_DIR = "provider";
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
// The region a file with provider stubs carries for a reader of the raw (generic) file; assembled text needs none.
const PROVIDER_RULE = /^<!-- provider-rule -->\n[\s\S]*?\n<!-- end provider-rule -->\n\n?/m;
const URL_REFERENCE = String.raw`https?:\/\/\S+`;
const GITHUB_NUMBER = String.raw`(?<![\w/&])#\d+\b`;

const EXIT_COMMAND = 2;
const EXIT_UNBOUND = 3;
const EXIT_BROKEN = 4;
const USAGE = "usage: provider.mjs show|data <capability> <key> [--worktree <wt>] [--conversation <id>]";
/** The commands an older vibe release's text runs to read provider text, which vibe's own files now carry. */
const RETIRED_COMMANDS = new Set(["tree", "assemble", "block", "path"]);

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
    if (contract?.vibeProvider !== PROVIDER_PROTOCOL || (manifest?.name !== contract.name && !isBundledRoot(root, manifest))) return null;
    if (typeof contract.references !== "string") return null;
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

/**
 * The provider vibe can bind, as a list of none or one: the one built into vibe's own install, found from `from`
 * (`<vibe root>/provider/provider.json`, where the vibe root is the plugin holding `from` when that is vibe, else vibe
 * beside it). Its version is vibe's. A vibe release with no provider folder, or one whose contract this vibe cannot
 * read, has none.
 */
export function installedProviders({ cwd = process.cwd(), from = import.meta.url } = {}) {
  let vibeRoot;
  try {
    const own = ownPluginRoot(from);
    vibeRoot = isVibePlugin(own.name) ? own.root : installedVibeRoot(cwd, from);
  } catch {
    return [];
  }
  const root = path.join(vibeRoot, BUNDLED_PROVIDER_DIR);
  const contract = readContract(root);
  return contract ? [{ name: contract.name, root, version: pluginManifest(vibeRoot)?.version ?? null, contract }] : [];
}

/**
 * Every provider built into a vibe install found from `from`, under either vibe name, enabled or not: the vibe holding
 * `from` when it is one, and each vibe beside it. Never for binding (installedProviders decides that); a privacy guard
 * reads it so a folder a provider's session wrote while bound stays private once no session binds that provider.
 */
export function knownProviderContracts({ cwd = process.cwd(), from = import.meta.url } = {}) {
  let vibeRoots;
  try {
    const own = ownPluginRoot(from);
    vibeRoots = [...(isVibePlugin(own.name) ? [own.root] : []), ...siblingInstalls(VIBE_PLUGIN_NAMES, { from, cwd }).map((install) => install.root)];
  } catch {
    return [];
  }
  return [...new Set(vibeRoots)].flatMap((vibeRoot) => {
    const root = path.join(vibeRoot, BUNDLED_PROVIDER_DIR);
    const contract = readContract(root);
    return contract ? [{ name: contract.name, root, version: pluginManifest(vibeRoot)?.version ?? null, contract }] : [];
  });
}

/**
 * Whether `root` is a provider folder built into vibe: no manifest of its own, named BUNDLED_PROVIDER_DIR, inside a
 * plugin named vibe. Only such a folder may carry a contract whose name no manifest beside it declares.
 */
function isBundledRoot(root, manifest) {
  return manifest === null && path.basename(root) === BUNDLED_PROVIDER_DIR && pluginManifest(path.dirname(root))?.name === "vibe";
}

/**
 * The binding for a conversation in `cwd`: `connections` maps each connection name the contract declares to
 * "connected" when this conversation proved it (a call to it answered here). Each capability binds on its own needs;
 * one withheld for an unanswered connection is listed in `withheld` and its connection in `missing`. The provider is
 * `bound-disconnected` only when none of its connection capabilities binds.
 */
export function probeProvider({ runtime, cwd = process.cwd(), connections = {}, now = new Date(), providers = installedProviders({ cwd }) } = {}) {
  const probedAt = now.toISOString();
  const [provider] = providers;
  if (!provider) return { state: ProviderState.None, runtime, probedAt, reason: "no provider is installed" };
  const { contract } = provider;
  const base = { name: provider.name, version: provider.version, runtime, root: provider.root, probedAt, connections: contract.connections ?? {} };
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
  const uniqueMissing = [...new Set(missing)];
  const needsConnection = (capability) => contract.capabilities[capability].needs.some(isConnectionNeed);
  const connected = capabilities.some(needsConnection) || !Object.keys(contract.capabilities).some(needsConnection);
  if (!connected || capabilities.length === 0) {
    return { ...base, state: ProviderState.Disconnected, capabilities: [], missing: uniqueMissing, reason: notAnswered(uniqueMissing) };
  }
  return { ...base, state: ProviderState.Bound, capabilities, missing: uniqueMissing, ...(withheld.length ? { withheld } : {}) };
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
  return { state: ProviderState.Unprobed, name: candidate.name, runtime, probedAt: now.toISOString(), capabilities: [],
    connectionsNeeded: connections.map(([name, spec]) => ({ name, label: spec.label, check: spec.check })),
    reason: `${candidate.name} is installed and the check had no connection states: make each call in connectionsNeeded, then run the check again `
      + "with one --connection <name>=<state> per entry" };
}

/**
 * The provider a start would bind, with the connection checks the model makes first, or that there is none:
 * `{ state: "candidate", name, connections }` or `{ state: "none", reason }`.
 */
export function providerCandidate({ cwd = process.cwd(), providers = installedProviders({ cwd }) } = {}) {
  const [provider] = providers;
  if (!provider) return { state: ProviderState.None, reason: "no provider is installed" };
  return { state: "candidate", name: provider.name, connections: provider.contract.connections ?? {} };
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
 * root of the same provider in the vibe installed now. A provider removed since has none.
 */
function currentRoot(binding) {
  if (typeof binding.root === "string" && existsSync(binding.root)) return binding.root;
  if (!movedRoots.has(binding.name)) {
    let found = null;
    try { found = installedProviders().find((provider) => provider.name === binding.name)?.root ?? null; }
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
 * Markdown `text` as a reader with `binding` sees it: the rule region gone and, with the provider bound, every
 * `> Provider` stub replaced by its block and every generic region dropped; with none (or with a capability unbound), the generic regions kept and the
 * stubs dropped. A capability the binding claims whose provider is gone or lacks the block throws ProviderBroken; it
 * never falls back to the generic text.
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

/** Every `> Provider` stub of `text`, in file order: `{ capability, id, file }`, `capability` as written (may join several). */
export function providerStubs(text) {
  return [...text.matchAll(PROVIDER_STUB_LINES)].map(([, capability, id, file]) => ({ capability, id, file }));
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
    if (RETIRED_COMMANDS.has(command)) {
      process.stdout.write(`provider-broken: provider.mjs ${command} is retired\n`);
      return EXIT_BROKEN;
    }
    let parsed;
    try {
      parsed = parseArgs({ args: rest, allowPositionals: true, options: { worktree: { type: "string" }, conversation: { type: "string" } } });
    } catch (error) {
      throw new CommandError(error.message);
    }
    const { values, positionals } = parsed;
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
    if (command === "data" && positionals.length === 2) {
      process.stdout.write(`${JSON.stringify(providerData(binding, ...positionals) ?? null)}\n`);
      return 0;
    }
    throw new CommandError(USAGE);
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      const bound = binding?.state === ProviderState.Bound
        ? ` (this session is bound to ${binding.name} with ${(binding.capabilities ?? []).join(", ") || "nothing"}: stop this step, never follow the generic text)` : "";
      process.stdout.write(`provider: ${error.message}${bound}\n`);
      return EXIT_UNBOUND;
    }
    // A command error (usage) is no provider's fault, and nor is any error with no binding claimed.
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

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));

function worktreeArgument(argv) {
  const at = argv.indexOf("--worktree");
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith("--worktree="));
  return inline ? inline.slice("--worktree=".length) || null : null;
}
