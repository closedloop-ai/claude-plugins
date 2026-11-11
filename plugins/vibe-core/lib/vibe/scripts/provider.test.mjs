import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleProviderText, boundWith, Capability, installedProviders, probeProvider, providerBlock, providerData, providerDataOr, providerPath,
  bindForRepository, ProviderState, ProviderUnavailable, readContract, recordedBinding, ticketReference,
} from "./provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "provider.mjs");
const CONTRACT = {
  vibeProvider: 1, name: "acme-provider", skill: "acme", references: "skills/acme/references",
  capabilities: { tickets: { needs: ["connection:tracker"] }, graph: { needs: ["connection:graph"] }, memory: { needs: [] },
    recipes: { needs: ["repo-file:.acme/vibe-recipes.json"] } },
  connections: { tracker: { label: "Acme", check: "call the tracker" }, graph: { label: "acme-graph", check: "call the graph" } },
  data: { recipes: { bootstrap: "./setup.sh" } },
};

function tree(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-provider-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

/** A plugin root holding `name`'s manifests, plus the provider contract and one reference when `contract` is given. */
function plugin(root, name, version, contract = null) {
  for (const manifest of [".claude-plugin", ".codex-plugin"]) write(path.join(root, manifest, "plugin.json"), { name, version });
  if (contract) {
    write(path.join(root, "provider.json"), { ...contract, name });
    write(path.join(root, contract.references, "vibe-skill.md"), "intro\n<!-- block: intake -->\nAsk for the ticket.\nThen read it.\n<!-- end: intake -->\n");
  }
  return root;
}

function provider(root, overrides = {}) {
  return { name: "acme-provider", root, version: "1.0.0", enabled: true, contract: { ...CONTRACT, ...overrides }, ...overrides.entry };
}

test("this checkout's provider plugin carries a contract vibe can speak to", () => {
  const checkout = path.resolve(HERE, "../../../..");
  const found = installedProviders({ cwd: checkout });
  assert.deepEqual(found.map((entry) => [entry.name, entry.enabled]), [["vibe-closedloop-provider", true]]);
  assert.deepEqual(Object.keys(found[0].contract.capabilities).sort(), Object.values(Capability).sort());
});

test("Claude Code: an installed but disabled provider is listed as off, and an uninstalled one is not listed", (t) => {
  const root = tree(t);
  const home = path.join(root, "claude");
  const cache = path.join(home, "plugins", "cache", "acme-market");
  const core = plugin(path.join(cache, "vibe-core", "1.0.5"), "vibe-core", "1.0.5");
  const acme = plugin(path.join(cache, "acme-provider", "1.0.0"), "acme-provider", "1.0.0", CONTRACT);
  const registry = { version: 2, plugins: {
    "vibe-core@acme-market": [{ scope: "user", installPath: core }],
    "acme-provider@acme-market": [{ scope: "user", installPath: acme }],
  } };
  write(path.join(home, "plugins", "installed_plugins.json"), registry);
  const from = path.join(core, ".claude-plugin", "plugin.json");
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.enabled), [true]);
  write(path.join(home, "settings.json"), { enabledPlugins: { "acme-provider@acme-market": false } });
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.enabled), [false], "disabled, still installed");
  write(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "vibe-core@acme-market": registry.plugins["vibe-core@acme-market"] } });
  assert.deepEqual(installedProviders({ cwd: root, from }), [], "never installed");
});

test("Codex: config.toml's enabled = false turns the provider off", (t) => {
  const root = tree(t);
  const home = path.join(root, "codex");
  const cache = path.join(home, "plugins", "cache", "acme-market");
  const core = plugin(path.join(cache, "vibe-core", "1.0.5"), "vibe-core", "1.0.5");
  plugin(path.join(cache, "acme-provider", "1.0.0"), "acme-provider", "1.0.0", CONTRACT);
  const from = path.join(core, ".codex-plugin", "plugin.json");
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.enabled), [true]);
  write(path.join(home, "config.toml"), '[plugins."acme-provider@acme-market"]\nenabled = false\n');
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.enabled), [false]);
});

test("the probe binds only one enabled, loaded provider whose needs this conversation met", (t) => {
  const root = tree(t);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const all = { tracker: "connected", graph: "connected" };
  const probe = (providers, extra = {}) => probeProvider({ runtime: "codex", cwd: repo, connections: all, providers, ...extra });
  assert.equal(probe([]).state, ProviderState.None);
  assert.match(probe([provider(acme, { entry: { enabled: false } })]).reason, /disabled/);
  assert.match(probe([provider(acme), { ...provider(acme), name: "other" }]).reason, /more than one/);
  const bound = probe([provider(acme)]);
  assert.equal(bound.state, ProviderState.Bound);
  assert.deepEqual(bound.capabilities, ["tickets", "graph", "memory"], "recipes need the repository's opt-in file");
  assert.deepEqual(bound.withheld, [{ capability: "recipes", reason: ".acme/vibe-recipes.json is not in this repository" }]);
  const optIn = path.join(repo, ".acme", "vibe-recipes.json");
  mkdirSync(path.dirname(optIn), { recursive: true });
  for (const [body, reason] of [
    ["{}", /must hold exactly "schema" and "provider"/],
    ["{not json", /is not valid JSON/],
    [JSON.stringify({ schema: 2, provider: "acme-provider" }), /has schema 2, not 1/],
    [JSON.stringify({ schema: 1, provider: "other-provider" }), /opts in to "other-provider", not acme-provider/],
    [JSON.stringify({ schema: 1, provider: "acme-provider", extra: true }), /must hold exactly/],
  ]) {
    writeFileSync(optIn, body);
    const withheld = probe([provider(acme)]);
    assert.equal(withheld.state, ProviderState.Bound, `a malformed opt-in file never fails the binding: ${body}`);
    assert.deepEqual(withheld.capabilities, ["tickets", "graph", "memory"], body);
    assert.equal(withheld.withheld.length, 1, body);
    assert.match(withheld.withheld[0].reason, reason, body);
  }
  writeFileSync(optIn, JSON.stringify({ schema: 1, provider: "acme-provider" }));
  assert.deepEqual(probe([provider(acme)]).capabilities, ["tickets", "graph", "memory", "recipes"]);
  assert.equal(probe([provider(acme)]).withheld, undefined);
  const unanswered = probe([provider(acme)], { connections: { tracker: "connected" } });
  assert.deepEqual([unanswered.state, unanswered.missing], [ProviderState.Disconnected, ["connection:graph"]]);
  const claude = probe([provider(acme)], { runtime: "claude" });
  assert.deepEqual([claude.state, claude.missing], [ProviderState.Disconnected, ["skill-listed"]], "Claude must have loaded its skill");
  assert.equal(probe([provider(acme)], { runtime: "claude", skillListed: "acme-provider:acme" }).state, ProviderState.Bound);
});

test("a contract vibe does not speak is no provider", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  assert.ok(readContract(acme));
  for (const bad of [{ vibeProvider: 2 }, { capabilities: { teleport: { needs: [] } } }, { capabilities: { tickets: { needs: ["shell:rm"] } } }, { name: "someone-else" }]) {
    write(path.join(acme, "provider.json"), { ...CONTRACT, name: "acme-provider", ...bad });
    assert.equal(readContract(acme), null, JSON.stringify(bad));
  }
});

test("provider files and data answer only a bound session with the capability", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets", "recipes"] };
  assert.equal(providerBlock(binding, "tickets", "vibe-skill.md", "intake"), "Ask for the ticket.\nThen read it.");
  assert.equal(providerData(binding, "recipes", "bootstrap"), "./setup.sh");
  assert.equal(providerDataOr(null, "recipes", "bootstrap", "none"), "none");
  assert.throws(() => providerBlock(binding, "graph", "vibe-skill.md", "intake"), ProviderUnavailable, "no graph capability");
  assert.throws(() => providerBlock({ ...binding, state: ProviderState.Disconnected }, "tickets", "vibe-skill.md", "intake"), ProviderUnavailable);
  assert.throws(() => providerBlock(null, "tickets", "vibe-skill.md", "intake"), /no provider with tickets/);
  assert.equal(providerPath(binding, "tickets", "provider:vibe-skill.md"), path.join(acme, "skills/acme/references/vibe-skill.md"));
  assert.throws(() => providerPath(binding, "tickets", "../../etc/passwd"), /outside the provider/);
  assert.throws(() => providerBlock(binding, "tickets", "../x.md", "intake"), ProviderUnavailable);
  rmSync(acme, { recursive: true });
  assert.equal(boundWith(binding, "tickets"), null);
  assert.throws(() => providerBlock(binding, "tickets", "vibe-skill.md", "intake"), /no longer installed/);
});

test("the binding comes from the session record first, then the conversation's startup record", (t) => {
  const home = tree(t);
  const binding = { state: ProviderState.Bound, name: "acme-provider" };
  write(path.join(home, ".codex", "vibe", "plugin-version", "chat-1.json"), { conversation: "chat-1", provider: binding });
  assert.deepEqual(recordedBinding({ conversation: "chat-1", home }), binding);
  assert.equal(recordedBinding({ conversation: "chat-2", home }), null);
  assert.equal(recordedBinding({ worktree: home, conversation: null, home }), null, "a folder that is no vibe worktree");
});

test("the command prints nothing from a provider in a session with none bound, and says so in one line", (t) => {
  const home = tree(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-9", CODEX_THREAD_ID: "" } });
  const block = run("block", "tickets", "vibe-skill.md", "intake");
  assert.deepEqual([block.status, block.stdout], [3, "provider: no provider with tickets is bound to this session\n"]);
  assert.equal(run("show").stdout, '{"state":"none"}\n');
});

test("assembled text follows the binding stub by stub, and ticket references follow the tracker", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets"] };
  const text = "# Title\n\nLines that start `> Provider` follow `references/provider-text.md`.\n\nKeep.\n"
    + "<!-- generic: intake -->\nDescribe the change.\n<!-- end generic: intake -->\n> Provider `tickets` (block `intake` of `vibe-skill.md`)\n"
    + "<!-- generic: graph-only -->\nSearch with rg.\n<!-- end generic: graph-only -->\n> Provider `graph` (block `intake` of `vibe-skill.md`)\nEnd.\n";
  assert.equal(assembleProviderText(text, binding), "# Title\n\nKeep.\nAsk for the ticket.\nThen read it.\nSearch with rg.\nEnd.\n",
    "a bound capability takes its block, an unbound one keeps its generic text");
  assert.equal(assembleProviderText(text, null), "# Title\n\nKeep.\nDescribe the change.\nSearch with rg.\nEnd.\n");
  assert.equal(assembleProviderText("No stubs here.\n", binding), "No stubs here.\n");
  assert.equal(ticketReference(null).test("see #12"), true);
  assert.equal(ticketReference(null).test("ISS-12"), false);
  assert.equal(ticketReference(null).test("https://example.invalid/issue/4"), true);
});

test("a script's --worktree names the session its binding is read from", (t) => {
  const root = tree(t);
  const worktree = path.join(root, "wt");
  mkdirSync(worktree);
  spawnSync("git", ["init", "-q", worktree]);
  const binding = { state: ProviderState.Bound, name: "acme-provider", capabilities: ["tickets"] };
  writeFileSync(path.join(worktree, ".git", "vibe-session.json"), JSON.stringify({ branch: "vibe/x", provider: binding }));
  const read = (...args) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(new URL("./provider.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify(m.sessionBinding()));`,
    "--", ...args], { encoding: "utf8", env: { ...process.env, HOME: root, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" } }).stdout);
  assert.deepEqual(read("--worktree", worktree), binding);
  assert.deepEqual(read(`--worktree=${worktree}`), binding);
  assert.equal(read(), null);
});

test("the ClosedLoop provider bound in a symphony-alpha checkout without the opt-in file binds no recipes, with one named reason", (t) => {
  const root = tree(t);
  const repo = path.join(root, "symphony-alpha");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, ".closedloop-ai"), { recursive: true });
  const real = path.resolve(HERE, "../../../../vibe-closedloop-provider");
  const contract = readContract(real);
  assert.ok(contract, "the ClosedLoop provider's contract is valid");
  const providers = [{ name: contract.name, root: real, version: "1.0.0", enabled: true, contract }];
  const probe = () => probeProvider({ runtime: "codex", cwd: repo, providers, connections: { tracker: "connected", graph: "connected" } });
  const bound = probe();
  assert.equal(bound.state, ProviderState.Bound);
  assert.ok(!bound.capabilities.includes("recipes"));
  assert.deepEqual(bound.withheld, [{ capability: "recipes", reason: ".closedloop-ai/vibe-recipes.json is not in this repository" }]);
  writeFileSync(path.join(repo, ".closedloop-ai", "vibe-recipes.json"), JSON.stringify({ schema: 1, provider: contract.name }));
  assert.ok(probe().capabilities.includes("recipes"), "the committed opt-in file binds the recipes");
});

test("a session judges the recipes opt-in in its own repository, not the directory the check ran in", (t) => {
  const root = tree(t);
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const real = path.resolve(HERE, "../../../../vibe-closedloop-provider");
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", enabled: true, contract }];
  const fromElsewhere = probeProvider({ runtime: "codex", cwd: elsewhere, providers, connections: { tracker: "connected", graph: "connected" } });
  assert.ok(!fromElsewhere.capabilities.includes("recipes"), "the check ran outside the repository");
  const repo = path.join(root, "symphony-alpha");
  mkdirSync(path.join(repo, ".closedloop-ai"), { recursive: true });
  const withoutFile = bindForRepository(fromElsewhere, repo);
  assert.ok(!withoutFile.capabilities.includes("recipes"));
  assert.deepEqual(withoutFile.withheld, [{ capability: "recipes", reason: ".closedloop-ai/vibe-recipes.json is not in this repository" }]);
  writeFileSync(path.join(repo, ".closedloop-ai", "vibe-recipes.json"), JSON.stringify({ schema: 1, provider: contract.name }));
  const opted = bindForRepository(fromElsewhere, repo);
  assert.deepEqual(opted.capabilities, ["tickets", "plans", "graph", "memory", "recipes"]);
  assert.equal(opted.withheld, undefined);
  writeFileSync(path.join(repo, ".closedloop-ai", "vibe-recipes.json"), "{}");
  assert.match(bindForRepository(opted, repo).withheld[0].reason, /must hold exactly/, "a malformed file withholds them again with one reason");
  assert.deepEqual(bindForRepository({ state: "none" }, repo), { state: "none" });
});

test("a binding whose release an update replaced finds the same provider where it is installed now", () => {
  const checkout = path.resolve(HERE, "../../../..");
  const [installed] = installedProviders({ cwd: checkout });
  assert.ok(installed, "this checkout's provider is installed beside vibe-core");
  const stale = { state: "bound", name: installed.name, root: path.join(checkout, "no-such-release"), capabilities: ["tickets"] };
  assert.equal(boundWith(stale, "tickets")?.root, installed.root);
  assert.equal(boundWith({ ...stale, name: "gone-provider" }, "tickets"), null, "a provider no longer installed binds nothing");
});
