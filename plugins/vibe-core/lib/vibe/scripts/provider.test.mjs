import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleProviderText, boundWith, Capability, installedProviders, probeProvider, providerBlock, providerData, providerDataOr, providerPath, servedProviderBlocks,
  bindForRepository, ProviderBroken, ProviderState, ProviderUnavailable, readContract, recordedBinding, ticketReference,
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
  assert.throws(() => providerBlock(binding, "tickets", "../x.md", "intake"), ProviderBroken, "a bad reference in a bound session stops");
  assert.throws(() => providerBlock(null, "tickets", "../x.md", "intake"), ProviderUnavailable, "with nothing bound it is only unbound");
  rmSync(acme, { recursive: true });
  assert.throws(() => boundWith(binding, "tickets"), ProviderBroken, "a claimed provider that is gone is broken, never unbound");
  assert.equal(boundWith(binding, "graph"), null, "a capability the binding never claimed is still unbound");
  assert.throws(() => providerBlock(binding, "tickets", "vibe-skill.md", "intake"), ProviderBroken);
  assert.throws(() => providerBlock(binding, "tickets", "vibe-skill.md", "intake"), /no longer installed.*Fix: reinstall or update the acme-provider plugin/);
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

test("the command judges a named checkout that holds no session by that checkout's own opt-in", (t) => {
  const home = tree(t);
  const real = path.resolve(HERE, "../../../../vibe-closedloop-provider");
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", enabled: true, contract }];
  const probed = probeProvider({ runtime: "codex", cwd: home, providers, connections: { tracker: "connected", graph: "connected" } });
  assert.ok(!probed.capabilities.includes("recipes"), "the chat's check ran outside any opted-in repository");
  write(path.join(home, ".codex", "vibe", "plugin-version", "chat-1.json"), { conversation: "chat-1", provider: probed });
  const checkout = path.join(home, "checkout");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-1", CODEX_THREAD_ID: "" } });
  mkdirSync(checkout, { recursive: true });
  assert.equal(run("data", "recipes", "bootstrap", "--worktree", checkout).status, 3, "a checkout with no opt-in has no recipes");
  write(path.join(checkout, ".closedloop-ai", "vibe-recipes.json"), { schema: 1, provider: contract.name });
  const opted = run("data", "recipes", "bootstrap", "--worktree", checkout);
  assert.equal(opted.status, 0, opted.stdout + opted.stderr);
  assert.notEqual(JSON.parse(opted.stdout), null);
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

test("a session branched before its repository committed the opt-in reads it from the repository's main checkout", (t) => {
  const root = tree(t);
  const real = path.resolve(HERE, "../../../../vibe-closedloop-provider");
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", enabled: true, contract }];
  const bound = probeProvider({ runtime: "codex", cwd: root, providers, connections: { tracker: "connected", graph: "connected" } });
  const main = path.join(root, "repo");
  const git = (...args) => {
    const run = spawnSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  };
  mkdirSync(main, { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  const session = path.join(main, ".claude", "worktrees", "vibe-old");
  git("worktree", "add", "--quiet", "-b", "vibe/old", session);
  assert.ok(!bindForRepository(bound, session).capabilities.includes("recipes"), "neither checkout has opted in");
  write(path.join(main, ".closedloop-ai", "vibe-recipes.json"), JSON.stringify({ schema: 1, provider: contract.name }));
  assert.ok(bindForRepository(bound, session).capabilities.includes("recipes"), "the main checkout's opt-in binds the older session");
  write(path.join(session, ".closedloop-ai", "vibe-recipes.json"), JSON.stringify({ schema: 1, provider: "another-provider" }));
  assert.match(bindForRepository(bound, session).withheld[0].reason, /opts in to "another-provider"/, "the session's own file decides when it has one");
});

test("a binding whose release an update replaced finds the same provider where it is installed now", () => {
  const checkout = path.resolve(HERE, "../../../..");
  const [installed] = installedProviders({ cwd: checkout });
  assert.ok(installed, "this checkout's provider is installed beside vibe-core");
  const stale = { state: "bound", name: installed.name, root: path.join(checkout, "no-such-release"), capabilities: ["tickets"] };
  assert.equal(boundWith(stale, "tickets")?.root, installed.root);
  assert.throws(() => boundWith({ ...stale, name: "gone-provider" }, "tickets"), /gone-provider this session is bound to is no longer installed/,
    "a provider no longer installed is broken, never read as unbound");
});

/** Runs provider.mjs in a chat whose startup record holds `binding`. */
function runBound(home, binding, ...args) {
  write(path.join(home, ".codex", "vibe", "plugin-version", "chat-b.json"), { conversation: "chat-b", provider: binding });
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-b", CODEX_THREAD_ID: "" } });
}

test("only an unbound capability means the generic text; every failure in a bound session stops with the reason and fix", (t) => {
  const home = tree(t);
  const acme = plugin(path.join(home, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets"] };
  const unbound = runBound(home, binding, "block", "graph", "vibe-skill.md", "intake");
  assert.deepEqual([unbound.status, unbound.stdout], [3, "provider: no provider with graph is bound to this session\n"]);
  const fine = runBound(home, binding, "block", "tickets", "vibe-skill.md", "intake");
  assert.deepEqual([fine.status, fine.stdout], [0, "Ask for the ticket.\nThen read it.\n"]);

  const missing = runBound(home, binding, "block", "tickets", "vibe-skill.md", "nowhere");
  assert.equal(missing.status, 4);
  assert.match(missing.stdout, /^provider-broken: vibe-skill\.md in acme-provider has no block nowhere\. Fix: reinstall or update the acme-provider plugin/);

  mkdirSync(path.join(acme, CONTRACT.references, "folder.md"));
  const unreadable = runBound(home, binding, "block", "tickets", "folder.md", "intake");
  assert.equal(unreadable.status, 4, "an unexpected read error never reads as unbound");
  assert.match(unreadable.stdout, /^provider-broken: folder\.md in acme-provider cannot be read \(EISDIR\)/);
  assert.equal(unreadable.stderr, "", "no stack trace");

  rmSync(acme, { recursive: true });
  for (const args of [["block", "tickets", "vibe-skill.md", "intake"], ["path", "tickets", "provider:vibe-skill.md"], ["data", "tickets", "x"]]) {
    const gone = runBound(home, binding, ...args);
    assert.equal(gone.status, 4, args.join(" "));
    assert.match(gone.stdout, /^provider-broken: the provider acme-provider this session is bound to is no longer installed at .*Fix: reinstall or update/);
  }
});

test("assembled text for a launched worker fails on a broken bound provider instead of keeping the generic text", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets"] };
  const text = (id) => `<!-- generic: ${id} -->\nDescribe the change.\n<!-- end generic: ${id} -->\n> Provider \`tickets\` (block \`${id}\` of \`vibe-skill.md\`)\n`;
  assert.equal(assembleProviderText(text("intake"), null), "Describe the change.\n", "unbound keeps the generic text");
  assert.throws(() => assembleProviderText(text("nowhere"), binding), ProviderBroken, "a missing block stops");
  rmSync(acme, { recursive: true });
  assert.throws(() => assembleProviderText(text("intake"), binding), /no longer installed/, "a removed provider stops");
});

const REAL_PROVIDER = path.resolve(HERE, "../../../../vibe-closedloop-provider");
const VIBE = path.resolve(HERE, "../../../../vibe");

/** Runs provider.mjs with HOME and TMPDIR in `home`, in a chat whose startup record holds `binding`. */
function runIn(home, binding, ...args) {
  write(path.join(home, ".codex", "vibe", "plugin-version", "chat-a.json"), { conversation: "chat-a", provider: binding });
  const tmp = path.join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: home,
    env: { ...process.env, HOME: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: "chat-a", CODEX_THREAD_ID: "" } });
}

test("assemble writes a file exactly as assembleProviderText renders it for no, one and every capability", (t) => {
  const home = tree(t);
  const all = Object.values(Capability);
  const bindings = [{ state: ProviderState.None }, ...all.map((one) => [one]), all].map((capabilities) => (capabilities.state ? capabilities
    : { state: ProviderState.Bound, name: "vibe-closedloop-provider", root: REAL_PROVIDER, capabilities }));
  for (const file of ["skills/vibe/references/guardrails.md", "agents/vibe-environment-worker.md", "skills/vibe/references/spec-card.md"]) {
    const text = readFileSync(path.join(VIBE, file), "utf8");
    for (const binding of bindings) {
      const run = runIn(home, binding, "assemble", path.join(VIBE, file));
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const written = run.stdout.trim();
      assert.ok(written.startsWith(path.join(home, ".codex", "vibe", "provider-text")), "outside the repository, in the vibe home");
      assert.equal(readFileSync(written, "utf8"), assembleProviderText(text, binding), `${file} ${JSON.stringify(binding.capabilities ?? "none")}`);
    }
  }
});

test("assemble --blocks prints every block the binding serves, in file order, each labelled by its id", (t) => {
  const home = tree(t);
  const file = path.join(VIBE, "skills/vibe/SKILL.md");
  const text = readFileSync(file, "utf8");
  const binding = { state: ProviderState.Bound, name: "vibe-closedloop-provider", root: REAL_PROVIDER, capabilities: ["tickets", "plans"] };
  const stubs = [...text.matchAll(/^> Provider `([a-z+]+)` \(block `([a-z0-9-]+)` of `([^`]+)`\)/gm)];
  const expected = stubs.filter(([, capability]) => capability.split("+").every((one) => binding.capabilities.includes(one)))
    .map(([, capability, id, reference]) => ({ id, text: providerBlock(binding, capability, reference, id) }));
  assert.ok(expected.length > 1 && expected.length < stubs.length, "the fixture serves some stubs and not others");
  assert.deepEqual(servedProviderBlocks(text, binding).map(({ id, text: body }) => ({ id, text: body })), expected);
  const run = runIn(home, binding, "assemble", "--blocks", file);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const printed = readFileSync(run.stdout.trim(), "utf8");
  const labelled = [...printed.matchAll(/<!-- block: ([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- end: \1 -->\n/g)]
    .map(([, id, body]) => ({ id, text: body }));
  assert.deepEqual(labelled, expected);
  assert.equal(labelled.reduce((n, { id, text: body }) => n + `<!-- block: ${id} -->\n${body}\n<!-- end: ${id} -->\n`.length, 0), printed.length, "nothing else printed");
  const unbound = runIn(home, { state: ProviderState.None }, "assemble", "--blocks", file);
  assert.deepEqual([unbound.status, unbound.stdout], [3, "provider: no provider bound to this session serves a stub of SKILL.md\n"]);
});

test("assemble fails closed: a broken bound provider stops with the reason and fix and writes nothing", (t) => {
  const home = tree(t);
  const acme = plugin(path.join(home, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets"] };
  const file = path.join(home, "skill.md");
  write(file, "Keep.\n<!-- generic: intake -->\nDescribe the change.\n<!-- end generic: intake -->\n> Provider `tickets` (block `intake` of `vibe-skill.md`)\n");
  const fine = runIn(home, binding, "assemble", file);
  assert.equal(fine.status, 0, fine.stdout + fine.stderr);
  assert.equal(readFileSync(fine.stdout.trim(), "utf8"), "Keep.\nAsk for the ticket.\nThen read it.\n");
  rmSync(path.join(home, ".codex", "vibe", "provider-text"), { recursive: true, force: true });
  rmSync(acme, { recursive: true });
  for (const args of [["assemble", file], ["assemble", "--blocks", file]]) {
    const run = runIn(home, binding, ...args);
    assert.equal(run.status, 4, args.join(" "));
    assert.match(run.stdout, /^provider-broken: the provider acme-provider this session is bound to is no longer installed at .*Fix: reinstall or update/);
    assert.ok(!existsSync(path.join(home, ".codex", "vibe", "provider-text")), "no assembled file is left for a reader to open");
  }
  const missing = runIn(home, { state: ProviderState.None }, "assemble", path.join(home, "absent.md"));
  assert.deepEqual([missing.status, missing.stdout], [2, ""], "a vibe file that cannot be read is a command error, never unbound or a broken provider");
  assert.match(missing.stderr, /absent\.md cannot be read \(ENOENT\)/);
  const bogus = runIn(home, binding, "block", "--bogus", "tickets", "vibe-skill.md", "intake");
  assert.deepEqual([bogus.status, bogus.stdout], [2, ""], "a bad flag is a command error with no stack trace");
  assert.doesNotMatch(bogus.stderr, /\n\s+at /);
});

test("a binding record that exists but cannot be read is a broken provider, never no binding", (t) => {
  const home = tree(t);
  const startup = path.join(home, ".codex", "vibe", "plugin-version", "chat-c.json");
  write(startup, "{not json");
  assert.throws(() => recordedBinding({ conversation: "chat-c", home }), /the record .*chat-c\.json cannot be read.*Fix: repair/);
  assert.equal(recordedBinding({ conversation: "chat-none", home }), null, "no record at all is still no binding");
  const run = spawnSync(process.execPath, [SCRIPT, "block", "tickets", "vibe-skill.md", "intake"], { encoding: "utf8", cwd: home,
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-c", CODEX_THREAD_ID: "" } });
  assert.equal(run.status, 4);
  assert.match(run.stdout, /^provider-broken: the record .*chat-c\.json cannot be read/);
  const worktree = path.join(home, "wt");
  spawnSync("git", ["init", "-q", worktree]);
  write(path.join(worktree, ".git", "vibe-session.json"), "{");
  assert.throws(() => recordedBinding({ worktree }), /vibe-session\.json cannot be read/);
});
