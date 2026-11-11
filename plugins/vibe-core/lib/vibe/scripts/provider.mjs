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
//   provider.mjs block  [--worktree <wt>] [--conversation <id>] <capability> <file> <id>
//   provider.mjs path   [--worktree <wt>] [--conversation <id>] <capability> <file>
//   provider.mjs data   [--worktree <wt>] [--conversation <id>] <capability> <key>
// `block` prints one block of a provider reference; `path` prints the absolute path of a whole provider
// reference (provider text names one as `provider:<file>`), relative to its references folder; `data`
// prints one contract data value as JSON. Each exits 3 with one line when no provider with that capability
// is bound, so a generic session reads nothing.

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pluginManifest, siblingPluginInstall, siblingPluginNames } from "../../../shared/plugin-roots.mjs";
import { pluginEnabled } from "../../../shared/vibe-install.mjs";
import { harnessActor } from "./harness-identity.mjs";
import { readSessionRecord } from "./session-record.mjs";
import { readStartupRecord } from "./startup-record.mjs";

export const PROVIDER_PROTOCOL = 1;
export const CONTRACT_FILE = "provider.json";
export const ProviderState = Object.freeze({ None: "none", Bound: "bound", Disconnected: "bound-disconnected" });
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
const PROVIDER_RULE = /^Lines that start `> Provider` follow `[^`]*provider-text\.md`\.(?: [^\n]*)?\n\n/m;

/** Thrown when a provider file or value is asked for without a bound provider that has the capability. */
export class ProviderUnavailable extends Error {}

// A script run with `--worktree <path>` works on that session, so its sessionBinding() reads that worktree first.
let activeWorktree = worktreeArgument(process.argv);

/** The contract at a plugin `root`, or null when it is not a provider vibe can speak to. */
export function readContract(root) {
  const file = path.join(root, CONTRACT_FILE);
  try {
    if (statSync(file).size > MAX_CONTRACT_BYTES) return null;
    const contract = JSON.parse(readFileSync(file, "utf8"));
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
 * "connected" when this conversation proved it (a call to it answered here), and `skillListed` is the
 * `<plugin>:<skill>` id the model saw in its own skill list, or null.
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
    if (unmet.length === 0) {
      const problem = spec.needs.map((need) => optInProblem(need, repo, provider.name)).find(Boolean);
      if (problem) withheld.push({ capability, reason: problem });
      else capabilities.push(capability);
    } else {
      missing.push(...unmet.filter((need) => need.startsWith("connection:")));
      const file = unmet.find((need) => need.startsWith("repo-file:"));
      if (file) withheld.push({ capability, reason: `${file.slice("repo-file:".length)} is not in this repository` });
    }
  }
  if (runtime === "claude" && skillListed !== base.skill) {
    return { ...base, state: ProviderState.Disconnected, capabilities: [], missing: ["skill-listed"],
      reason: `${base.skill} is installed and on but not loaded in this session; restart Claude Code or run /reload-plugins` };
  }
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    return { ...base, state: ProviderState.Disconnected, capabilities: [], missing: uniqueMissing,
      reason: `not answered in this conversation: ${uniqueMissing.map((need) => need.slice("connection:".length)).join(", ")}` };
  }
  return { ...base, state: ProviderState.Bound, capabilities, missing: [], ...(withheld.length ? { withheld } : {}) };
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
 * The one enabled provider a start would bind, with the connection checks the model makes first, or why
 * there is none: `{ state: "candidate", name, skill, connections }` or `{ state: "none", reason }`.
 */
export function providerCandidate({ cwd = process.cwd(), providers = installedProviders({ cwd }) } = {}) {
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length !== 1) {
    return { state: ProviderState.None,
      reason: enabled.length > 1 ? "more than one provider is enabled" : providers.length ? "the provider is disabled" : "no provider is installed" };
  }
  const [{ name, contract }] = enabled;
  return { state: "candidate", name, skill: `${name}:${contract.skill}`, connections: contract.connections ?? {} };
}

/** The binding recorded for a session worktree or a conversation (worktree first), or null. */
export function recordedBinding({ worktree = null, conversation = null, home } = {}) {
  if (worktree) {
    try {
      const binding = readSessionRecord(worktree)?.provider;
      if (binding) return binding;
    } catch {
      // Not a vibe worktree: fall back to the conversation.
    }
  }
  if (conversation) {
    try {
      return readStartupRecord(conversation, home)?.provider ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The binding a script in a session (or, before one exists, this conversation) reads: the worktree first (the one
 * given, else the one the script's entry point named with useSessionWorktree), then the harness conversation. A
 * worker launched as its own harness session has no conversation record, so the worktree is what binds it.
 */
export function sessionBinding(worktree = null, env = process.env) {
  return recordedBinding({ worktree: worktree ?? activeWorktree, conversation: harnessActor(env)?.id ?? null });
}

/** Names the session worktree (a script's `--worktree`) that a later sessionBinding() without one reads first. */
export function useSessionWorktree(worktree) {
  activeWorktree = typeof worktree === "string" && worktree ? worktree : null;
}

/**
 * `binding` when it is bound with `capability` and its provider is still where it was bound; else null.
 * A provider removed or replaced since the binding no longer answers, so a bound session keeps its local work
 * and stops its provider steps with one named failure (`requireProvider`).
 */
export function boundWith(binding, capability) {
  if (binding?.state !== ProviderState.Bound || !binding.capabilities?.includes(capability)) return null;
  if (typeof binding.root !== "string" || !existsSync(binding.root)) return null;
  const contract = readContract(binding.root);
  return contract?.name === binding.name ? { ...binding, contract } : null;
}

/** `boundWith`, or a ProviderUnavailable naming what is missing. */
export function requireProvider(binding, capability) {
  const bound = boundWith(binding, capability);
  if (bound) return bound;
  if (binding?.state === ProviderState.Bound && binding.capabilities?.includes(capability)) {
    throw new ProviderUnavailable(`the provider ${binding.name} this session was bound to is no longer installed at ${binding.root}; `
      + "its steps stop here and the session's local work stays as it is");
  }
  throw new ProviderUnavailable(`no provider with ${capability} is bound to this session`);
}

/** The absolute path of reference `file` (relative to the bound provider's references folder, for `capability`). */
export function providerPath(binding, capability, file) {
  const bound = requireProvider(binding, capability);
  const references = path.resolve(bound.root, bound.contract.references);
  const resolved = path.resolve(references, String(file).replace(/^provider:/, ""));
  if (!resolved.startsWith(`${references}${path.sep}`)) throw new ProviderUnavailable(`${file} is outside the provider's references`);
  return resolved;
}

/**
 * The block `id` of provider reference `file` (relative to its references folder), unchanged. `capability` may
 * join several with "+" (a block that needs each of them).
 */
export function providerBlock(binding, capability, file, id) {
  if (!REFERENCE.test(file) || !BLOCK_ID.test(id)) throw new ProviderUnavailable(`not a provider block: ${file} ${id}`);
  const [first, ...rest] = String(capability).split("+");
  for (const other of rest) requireProvider(binding, other);
  const bound = requireProvider(binding, first);
  capability = first;
  const text = readFileSync(providerPath(bound, capability, file), "utf8");
  const found = new RegExp(`<!-- block: ${id} -->\\n([\\s\\S]*?)\\n<!-- end: ${id} -->`).exec(text);
  if (!found) throw new ProviderUnavailable(`${file} in ${bound.name} has no block ${id}`);
  return found[1];
}

/**
 * Markdown `text` as a reader with `binding` sees it: the rule pointer gone and, with the provider bound,
 * every `> Provider` stub replaced by its block and every generic region dropped; with none (or with a
 * capability unbound), the generic regions kept and the stubs dropped. The same assembly as
 * tools/python/skill_split.py `assembled`.
 */
export function assembleProviderText(text, binding) {
  if (!PROVIDER_STUB.test(text)) return text;
  const body = text.replace(PROVIDER_RULE, "");
  const served = (capability) => capability.split("+").every((one) => boundWith(binding, one));
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
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true,
    options: { worktree: { type: "string" }, conversation: { type: "string" } } });
  const binding = values.conversation
    ? recordedBinding({ worktree: values.worktree ?? null, conversation: values.conversation })
    : sessionBinding(values.worktree ?? null);
  if (command === "show") {
    process.stdout.write(`${JSON.stringify(binding ?? { state: ProviderState.None })}\n`);
    return 0;
  }
  try {
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
  } catch (error) {
    if (!(error instanceof ProviderUnavailable)) throw error;
    process.stdout.write(`provider: ${error.message}\n`);
    return 3;
  }
  process.stderr.write("usage: provider.mjs show|block <capability> <file> <id>|path <capability> <relative>|data <capability> <key> [--worktree <wt>] [--conversation <id>]\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));

function worktreeArgument(argv) {
  const at = argv.indexOf("--worktree");
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith("--worktree="));
  return inline ? inline.slice("--worktree=".length) || null : null;
}
