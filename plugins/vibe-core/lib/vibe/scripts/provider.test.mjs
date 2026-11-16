import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleProviderText, bindForRepository, boundWith, Capability, installedProviders, knownProviderContracts, probeProvider, providerBlock, providerCandidate, providerData,
  providerDataOr, providerPath, ProviderBroken, ProviderState, ProviderUnavailable, readContract, recordedBinding, ticketReference,
} from "./provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "provider.mjs");
const REAL_PROVIDER = path.resolve(HERE, "../../../../vibe-closedloop-provider");
const VIBE = path.resolve(HERE, "../../../../vibe");
const CONTRACT = {
  vibeProvider: 1, name: "acme-provider", references: "skills/acme/references",
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
  return { name: "acme-provider", root, version: "1.0.0", contract: { ...CONTRACT, ...overrides } };
}

/** A Codex plugin cache under `root` holding vibe-core and vibe (with a bundled provider when `bundled`); returns their roots. */
function codexCache(root, { bundled = false } = {}) {
  const cache = path.join(root, "codex", "plugins", "cache", "acme-market");
  const core = plugin(path.join(cache, "vibe-core", "1.0.5"), "vibe-core", "1.0.5");
  const vibe = plugin(path.join(cache, "vibe", "2.3.4"), "vibe", "2.3.4");
  if (bundled) {
    write(path.join(vibe, "provider", "provider.json"), CONTRACT);
    write(path.join(vibe, "provider", CONTRACT.references, "vibe-skill.md"), "<!-- block: intake -->\nAsk for the ticket.\n<!-- end: intake -->\n");
  }
  return { cache, core, vibe, from: path.join(core, ".codex-plugin", "plugin.json") };
}

test("this checkout's provider folder carries a contract vibe can speak to, and the generic vibe beside it carries none", () => {
  const contract = readContract(REAL_PROVIDER);
  assert.deepEqual(Object.keys(contract.capabilities).sort(), Object.values(Capability).sort());
  assert.deepEqual(installedProviders({ cwd: path.resolve(HERE, "../../../..") }), [], "plugins/vibe has no provider folder");
});

test("only the provider built into vibe is found: a provider plugin beside vibe is never listed, on or off", (t) => {
  const root = tree(t);
  const { cache, vibe, from } = codexCache(root);
  plugin(path.join(cache, "acme-provider", "1.0.0"), "acme-provider", "1.0.0", CONTRACT);
  assert.deepEqual(installedProviders({ cwd: root, from }), [], "a Codex sibling is no provider");
  assert.equal(providerCandidate({ cwd: root, providers: installedProviders({ cwd: root, from }) }).reason, "no provider is installed");
  const claude = path.join(root, "claude");
  const claudeCore = plugin(path.join(claude, "plugins", "cache", "acme-market", "vibe-core", "1.0.5"), "vibe-core", "1.0.5");
  const claudeVibe = plugin(path.join(claude, "plugins", "cache", "acme-market", "vibe", "2.3.4"), "vibe", "2.3.4");
  const acme = plugin(path.join(claude, "plugins", "cache", "acme-market", "acme-provider", "1.0.0"), "acme-provider", "1.0.0", CONTRACT);
  write(path.join(claude, "plugins", "installed_plugins.json"), { version: 2, plugins: Object.fromEntries([["vibe-core", claudeCore], ["vibe", claudeVibe],
    ["acme-provider", acme]].map(([name, installPath]) => [`${name}@acme-market`, [{ scope: "user", installPath }]])) });
  assert.deepEqual(installedProviders({ cwd: root, from: path.join(claudeCore, ".claude-plugin", "plugin.json") }), [], "a Claude Code sibling is no provider");
  write(path.join(vibe, "provider", "provider.json"), { ...CONTRACT, name: "bundled-provider" });
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.name), ["bundled-provider"], "the bundled one alone, beside a sibling");
});

test("the probe binds the provider whose needs this conversation met, in Codex and Claude Code alike", (t) => {
  const root = tree(t);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const all = { tracker: "connected", graph: "connected" };
  const probe = (providers, extra = {}) => probeProvider({ runtime: "codex", cwd: repo, connections: all, providers, ...extra });
  assert.deepEqual([probe([]).state, probe([]).reason], [ProviderState.None, "no provider is installed"]);
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
  assert.deepEqual([unanswered.state, unanswered.capabilities, unanswered.missing], [ProviderState.Bound, ["tickets", "memory", "recipes"], ["connection:graph"]]);
  assert.deepEqual(unanswered.withheld, [{ capability: "graph", reason: "not answered in this conversation: graph" }]);
  const silent = probe([provider(acme)], { connections: {} });
  assert.deepEqual([silent.state, silent.capabilities, silent.missing], [ProviderState.Disconnected, [], ["connection:tracker", "connection:graph"]]);
  const claude = probe([provider(acme)], { runtime: "claude", skillListed: null });
  assert.deepEqual([claude.state, claude.capabilities], [ProviderState.Bound, ["tickets", "graph", "memory", "recipes"]], "no skill need be listed");
  assert.equal(claude.skill, undefined, "a binding names no provider skill");
});

test("a contract vibe does not speak is no provider", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  assert.ok(readContract(acme));
  for (const bad of [{ vibeProvider: 2 }, { capabilities: { teleport: { needs: [] } } }, { capabilities: { tickets: { needs: ["shell:rm"] } } }, { name: "someone-else" }]) {
    write(path.join(acme, "provider.json"), { ...CONTRACT, name: "acme-provider", ...bad });
    assert.equal(readContract(acme), null, JSON.stringify(bad));
  }
  write(path.join(acme, "provider.json"), { ...CONTRACT, name: "acme-provider", skill: "acme" });
  assert.ok(readContract(acme), "an older contract's skill key is ignored");
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
  const data = run("data", "tickets", "referencePattern");
  assert.deepEqual([data.status, data.stdout], [3, "provider: no provider with tickets is bound to this session\n"]);
  assert.equal(run("show").stdout, '{"state":"none"}\n');
});

test("the command judges a named checkout that holds no session by that checkout's own opt-in", (t) => {
  const home = tree(t);
  const real = REAL_PROVIDER;
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", contract }];
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
  const text = "# Title\n\nKeep.\n"
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
  const real = REAL_PROVIDER;
  const contract = readContract(real);
  assert.ok(contract, "the ClosedLoop provider's contract is valid");
  const providers = [{ name: contract.name, root: real, version: "1.0.0", contract }];
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
  const real = REAL_PROVIDER;
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", contract }];
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
  const real = REAL_PROVIDER;
  const contract = readContract(real);
  const providers = [{ name: contract.name, root: real, version: "1.0.0", contract }];
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

test("a binding whose release an update replaced finds the same provider in the vibe installed now", (t) => {
  const root = tree(t);
  const { core } = codexCache(root, { bundled: true });
  cpSync(path.resolve(HERE, "../../.."), core, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const home = path.join(root, "home");
  const script = path.join(core, "lib", "vibe", "scripts", "provider.mjs");
  const stale = { state: "bound", name: "acme-provider", root: path.join(root, "no-such-release"), capabilities: ["recipes"] };
  const moved = runBoundWith(script, home, stale, "data", "recipes", "bootstrap");
  assert.deepEqual([moved.status, moved.stdout], [0, '"./setup.sh"\n'], moved.stderr);
  const gone = runBoundWith(script, home, { ...stale, name: "gone-provider" }, "data", "recipes", "bootstrap");
  assert.equal(gone.status, 4, "a provider no longer installed is broken, never read as unbound");
  assert.match(gone.stdout, /gone-provider this session is bound to is no longer installed/);
});

/** Runs provider.mjs in a chat whose startup record holds `binding`. */
function runBound(home, binding, ...args) {
  return runBoundWith(SCRIPT, home, binding, ...args);
}

/** Runs the provider.mjs at `script` in a chat whose startup record holds `binding`. */
function runBoundWith(script, home, binding, ...args) {
  write(path.join(home, ".codex", "vibe", "plugin-version", "chat-b.json"), { conversation: "chat-b", provider: binding });
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-b", CODEX_THREAD_ID: "" } });
}

test("a provider answer in a bound session never means the generic text; every failure stops with the reason", (t) => {
  const home = tree(t);
  const acme = plugin(path.join(home, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets", "recipes"] };
  const unbound = runBound(home, binding, "data", "graph", "x");
  assert.deepEqual([unbound.status, unbound.stdout], [3, "provider: no provider with graph is bound to this session"
    + " (this session is bound to acme-provider with tickets, recipes: stop this step, never follow the generic text)\n"]);
  const fine = runBound(home, binding, "data", "recipes", "bootstrap");
  assert.deepEqual([fine.status, fine.stdout], [0, '"./setup.sh"\n']);
  rmSync(acme, { recursive: true });
  const gone = runBound(home, binding, "data", "tickets", "x");
  assert.equal(gone.status, 4);
  assert.match(gone.stdout, /^provider-broken: the provider acme-provider this session is bound to is no longer installed at .*Fix: reinstall or update/);
  const bogus = runBound(home, binding, "data", "--bogus", "tickets", "x");
  assert.deepEqual([bogus.status, bogus.stdout], [2, ""], "a bad flag is a command error with no stack trace");
  assert.doesNotMatch(bogus.stderr, /\n\s+at /);
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

test("the commands an older vibe runs for provider text each refuse in one line, bound or not, whatever their arguments", (t) => {
  const home = tree(t);
  const acme = plugin(path.join(home, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const bound = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets"] };
  for (const binding of [bound, { state: ProviderState.None }]) {
    for (const args of [["tree"], ["tree", "--worktree", home, "--vibe-root", home], ["assemble", path.join(VIBE, "skills/vibe/SKILL.md")],
      ["assemble", "--blocks", "--worktree", home, "x.md"], ["block", "tickets", "vibe-skill.md", "intake"], ["path", "tickets", "provider:vibe-skill.md"]]) {
      const run = runBound(home, binding, ...args);
      assert.deepEqual([run.status, run.stdout, run.stderr], [4, `provider-broken: provider.mjs ${args[0]} is retired\n`, ""], `${binding.state} ${args.join(" ")}`);
    }
  }
});

test("a binding record that exists but cannot be read is a broken provider, never no binding", (t) => {
  const home = tree(t);
  const startup = path.join(home, ".codex", "vibe", "plugin-version", "chat-c.json");
  write(startup, "{not json");
  assert.throws(() => recordedBinding({ conversation: "chat-c", home }), /the record .*chat-c\.json cannot be read.*Fix: repair/);
  assert.equal(recordedBinding({ conversation: "chat-none", home }), null, "no record at all is still no binding");
  const run = spawnSync(process.execPath, [SCRIPT, "data", "tickets", "x"], { encoding: "utf8", cwd: home,
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-c", CODEX_THREAD_ID: "" } });
  assert.equal(run.status, 4);
  assert.match(run.stdout, /^provider-broken: the record .*chat-c\.json cannot be read/);
  const worktree = path.join(home, "wt");
  spawnSync("git", ["init", "-q", worktree]);
  write(path.join(worktree, ".git", "vibe-session.json"), "{");
  assert.throws(() => recordedBinding({ worktree }), /vibe-session\.json cannot be read/);
});

/** Every Markdown file under `root` (relative paths), skipping evals. */
function markdown(root, relative = "") {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith(".") || ["node_modules", "evals"].includes(entry.name) ? [] : markdown(root, child);
    return entry.name.endsWith(".md") ? [child] : [];
  });
}

/** A repository at `root/repo` and the real provider probed there with `connections`. */
function realBinding(root, connections) {
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const contract = readContract(REAL_PROVIDER);
  const providers = [{ name: contract.name, root: REAL_PROVIDER, version: "1.0.0", contract }];
  return { repo, binding: probeProvider({ runtime: "codex", cwd: repo, providers, connections }) };
}

test("each capability binds on its own needs: graph down withholds only graph, and nothing answering binds nothing", (t) => {
  const root = tree(t);
  const { repo, binding: partial } = realBinding(root, { tracker: "connected", graph: "not-connected" });
  assert.equal(partial.state, ProviderState.Bound);
  assert.deepEqual(partial.capabilities, ["tickets", "plans", "memory"]);
  assert.deepEqual(partial.missing, ["connection:graph"]);
  assert.deepEqual(partial.withheld, [{ capability: "graph", reason: "not answered in this conversation: graph" },
    { capability: "recipes", reason: ".closedloop-ai/vibe-recipes.json is not in this repository" }]);
  write(path.join(repo, ".closedloop-ai", "vibe-recipes.json"), { schema: 1, provider: "vibe-closedloop-provider" });
  const opted = realBinding(root, { tracker: "connected" }).binding;
  assert.deepEqual(opted.capabilities, ["tickets", "plans", "memory", "recipes"], "an opted-in repository keeps its recipes");
  const graphOnly = realBinding(root, { graph: "connected" }).binding;
  assert.deepEqual([graphOnly.state, graphOnly.capabilities, graphOnly.missing], [ProviderState.Bound, ["graph", "memory", "recipes"], ["connection:tracker"]]);
  const none = realBinding(root, {}).binding;
  assert.deepEqual([none.state, none.capabilities, none.missing], [ProviderState.Disconnected, [], ["connection:tracker", "connection:graph"]]);
});

test("a capability withheld for an unanswered connection stays withheld when the repository has its opt-in file", (t) => {
  const root = tree(t);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  write(path.join(repo, ".acme", "vibe-recipes.json"), { schema: 1, provider: "acme-provider" });
  const both = { ...CONTRACT, capabilities: { ...CONTRACT.capabilities, recipes: { needs: ["connection:tracker", "repo-file:.acme/vibe-recipes.json"] } } };
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", both);
  const bound = probeProvider({ runtime: "codex", cwd: repo, providers: [provider(acme, both)], connections: { graph: "connected" } });
  assert.deepEqual([bound.state, bound.capabilities], [ProviderState.Bound, ["graph", "memory"]]);
  const session = bindForRepository(bound, repo);
  assert.deepEqual(session.capabilities, ["graph", "memory"], "the opt-in file never stands in for the tracker's answer");
  assert.ok(session.withheld.some((entry) => entry.capability === "recipes" && /not answered/.test(entry.reason)));
});

const STUB_LINE = /^> Provider `[a-z+]+` \(block `[a-z0-9-]+` of `[^`]+`\)/m;
const RULE_REGION = /^<!-- provider-rule -->\n([\s\S]*?)\n<!-- end provider-rule -->\n/gm;
const RULE_BODIES = new Set([
  "Lines of the form ``> Provider `<capability>` (block `<id>` of `<file>`)`` stand\nfor an optional provider's text. With no provider bound, follow the generic text.",
  "Lines that start `> Provider` stand for an optional provider's text. With no provider bound, follow the generic text.",
]);

test("each stubbed vibe file tells a generic reader what its stubs mean, and none points at runtime provider text", () => {
  const stubbed = markdown(VIBE).filter((file) => STUB_LINE.test(readFileSync(path.join(VIBE, file), "utf8")));
  assert.ok(stubbed.length > 30);
  for (const file of markdown(VIBE)) {
    const text = readFileSync(path.join(VIBE, file), "utf8");
    assert.doesNotMatch(text, /provider-text|provider\.mjs (?:tree|assemble|block|path)\b/, file);
    const rules = [...text.matchAll(RULE_REGION)].map(([, body]) => body);
    assert.deepEqual(rules.map((body) => RULE_BODIES.has(body)), stubbed.includes(file) ? [true] : [], file);
  }
});

test("assembled text carries no rule region, bound or not", () => {
  const bound = { state: ProviderState.Bound, name: "vibe-closedloop-provider", root: REAL_PROVIDER, capabilities: Object.values(Capability) };
  for (const file of markdown(VIBE).filter((name) => STUB_LINE.test(readFileSync(path.join(VIBE, name), "utf8")))) {
    const text = readFileSync(path.join(VIBE, file), "utf8");
    for (const binding of [null, bound]) assert.doesNotMatch(assembleProviderText(text, binding), /provider-rule|Lines (?:that start|of the form)/, `${file} ${binding?.state}`);
  }
});

test("a stub naming several capabilities is served when any is bound, and a graph-only stub stays generic", (t) => {
  const root = tree(t);
  const acme = plugin(path.join(root, "acme"), "acme-provider", "1.0.0", CONTRACT);
  const binding = { state: ProviderState.Bound, name: "acme-provider", root: acme, capabilities: ["tickets", "memory"], missing: ["connection:graph"] };
  const text = "<!-- generic: intake -->\nGeneric both.\n<!-- end generic: intake -->\n> Provider `graph+tickets` (block `intake` of `vibe-skill.md`)\n"
    + "<!-- generic: graph-only -->\nSearch with rg.\n<!-- end generic: graph-only -->\n> Provider `graph` (block `intake` of `vibe-skill.md`)\n";
  assert.equal(assembleProviderText(text, binding), "Ask for the ticket.\nThen read it.\nSearch with rg.\n");
  assert.equal(providerBlock(binding, "graph+tickets", "vibe-skill.md", "intake"), "Ask for the ticket.\nThen read it.");
  const real = { state: ProviderState.Bound, name: "vibe-closedloop-provider", root: REAL_PROVIDER, capabilities: ["tickets", "plans", "memory"] };
  const install = assembleProviderText(readFileSync(path.join(VIBE, "skills/vibe/INSTALL.md"), "utf8"), real);
  assert.match(install, /mcp add closedloop --url/, "INSTALL.md's install-2 renders with graph down");
  assert.match(install, /Have the vibe user sign in to ClosedLoop/, "INSTALL.md's connections renders with graph down");
});

test("an unprobed binding is never generic: provider reads and scripts stop with the rerun instruction", (t) => {
  const home = tree(t);
  const unprobed = { state: ProviderState.Unprobed, name: "vibe-closedloop-provider", capabilities: [] };
  const rerun = "the plugin version check ran without connection states. Fix: make the calls it named and run it again first";
  assert.throws(() => boundWith(unprobed, "tickets"), (error) => error instanceof ProviderBroken && error.message === rerun);
  assert.throws(() => ticketReference(unprobed), ProviderBroken);
  assert.throws(() => assembleProviderText("> Provider `tickets` (block `intake` of `vibe-skill.md`)\n", unprobed), ProviderBroken);
  const data = runBound(home, unprobed, "data", "tickets", "x");
  assert.deepEqual([data.status, data.stdout], [4, `provider-broken: ${rerun}\n`]);
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]]) {
    assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  }
  const script = path.resolve(HERE, "../../../../vibe/skills/handoff/scripts/comment-rules.mjs");
  const run = spawnSync(process.execPath, [script, "--worktree", repo, "--base", "HEAD"], { encoding: "utf8", cwd: home,
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "chat-b", CODEX_THREAD_ID: "" } });
  assert.deepEqual([run.status, run.stdout], [4, `provider-broken: ${rerun}\n`], run.stderr);
});

test("a provider built into vibe binds from vibe's own folder, and only there may a contract lack its own manifest", (t) => {
  const root = tree(t);
  const { cache, vibe, from } = codexCache(root);
  const bundled = path.join(vibe, "provider");
  write(path.join(bundled, "provider.json"), CONTRACT);
  write(path.join(bundled, CONTRACT.references, "ticket-template.md"), "# Template\n");
  const found = installedProviders({ cwd: root, from });
  assert.deepEqual(found.map((entry) => [entry.name, entry.root, entry.version]), [["acme-provider", bundled, "2.3.4"]]);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const bound = probeProvider({ runtime: "claude", cwd: repo, providers: found, connections: { tracker: "connected", graph: "connected" } });
  assert.equal(bound.state, ProviderState.Bound);
  assert.equal(providerPath(bound, "tickets", "ticket-template.md"), path.join(bundled, CONTRACT.references, "ticket-template.md"));
  assert.deepEqual(installedProviders({ cwd: root, from: path.join(vibe, ".codex-plugin", "plugin.json") }).map((entry) => entry.root), [bundled],
    "found from inside vibe too");

  const outside = path.join(root, "elsewhere", "provider");
  write(path.join(outside, "provider.json"), CONTRACT);
  assert.equal(readContract(outside), null, "a provider folder outside a vibe plugin has no manifest to match");
  const sibling = path.join(cache, "other-provider", "1.0.0");
  plugin(sibling, "other-provider", "1.0.0");
  write(path.join(sibling, "provider", "provider.json"), CONTRACT);
  assert.equal(readContract(path.join(sibling, "provider")), null, "only vibe's own folder holds a bundled provider");
  write(path.join(sibling, "provider.json"), { ...CONTRACT, name: "someone-else" });
  assert.equal(readContract(sibling), null, "a sibling plugin's contract must still name its manifest");
});

test("vibe-generic carries no provider: from its own install none is found, even beside the ClosedLoop build that carries one", (t) => {
  const root = tree(t);
  const { cache, from } = codexCache(root, { bundled: true });
  const generic = plugin(path.join(cache, "vibe-generic", "2.3.4"), "vibe-generic", "2.3.4");
  assert.deepEqual(installedProviders({ cwd: root, from: path.join(generic, ".codex-plugin", "plugin.json") }), [],
    "the generic install is its own vibe root, never the build beside it");
  assert.deepEqual(installedProviders({ cwd: root, from }).map((entry) => entry.name), ["acme-provider"],
    "vibe-core beside both, both enabled: the build serves the binding (lead's ruling; the check reports both-installed)");
  write(path.join(root, "codex", "config.toml"), '[plugins."vibe@acme-market"]\nenabled = false\n');
  assert.deepEqual(installedProviders({ cwd: root, from }), [], "with the build disabled, vibe-generic stands for vibe and binds nothing");
  assert.deepEqual(installedProviders({ cwd: root, from: path.join(generic, ".codex-plugin", "plugin.json") }), [],
    "a call from inside vibe-generic is vibe-generic's");
});

test("in Claude Code, with both installed in either registry order, the build's provider binds", (t) => {
  const root = tree(t);
  const cache = path.join(root, "claude", "plugins", "cache", "acme-market");
  const core = plugin(path.join(cache, "vibe-core", "1.0.5"), "vibe-core", "1.0.5");
  const vibe = plugin(path.join(cache, "vibe", "2.3.4"), "vibe", "2.3.4");
  write(path.join(vibe, "provider", "provider.json"), CONTRACT);
  const generic = plugin(path.join(cache, "vibe-generic", "2.3.4"), "vibe-generic", "2.3.4");
  const roots = { vibe, "vibe-generic": generic, "vibe-core": core };
  for (const order of [["vibe", "vibe-generic", "vibe-core"], ["vibe-generic", "vibe", "vibe-core"]]) {
    write(path.join(root, "claude", "plugins", "installed_plugins.json"), { version: 2,
      plugins: Object.fromEntries(order.map((name) => [`${name}@acme-market`, [{ scope: "user", installPath: roots[name] }]])) });
    assert.deepEqual(installedProviders({ cwd: root, from: path.join(core, ".claude-plugin", "plugin.json") }).map((entry) => entry.root),
      [path.join(vibe, "provider")], order.join(" then "));
  }
});

test("the privacy guard knows a checkout's ClosedLoop build beside vibe-generic, while binding still finds no provider there", (t) => {
  const plugins = path.join(tree(t), "plugins");
  const core = plugin(path.join(plugins, "vibe-core"), "vibe-core", "1.0.5");
  plugin(path.join(plugins, "vibe"), "vibe-generic", "2.3.4");
  const build = plugin(path.join(plugins, "vibe-closedloop"), "vibe", "2.3.4");
  write(path.join(build, "provider", "provider.json"), CONTRACT);
  const from = path.join(core, ".codex-plugin", "plugin.json");
  assert.deepEqual(knownProviderContracts({ cwd: plugins, from }).map((entry) => [entry.name, entry.root]),
    [["acme-provider", path.join(build, "provider")]]);
  assert.deepEqual(installedProviders({ cwd: plugins, from }), [], "a checkout looks up vibe-generic first, so nothing binds");
  assert.equal(providerCandidate({ cwd: plugins, providers: installedProviders({ cwd: plugins, from }) }).state, ProviderState.None);
});

test("the privacy guard knows every vibe install's provider, enabled or not, and none where only vibe-generic is installed", (t) => {
  const root = tree(t);
  const { cache, vibe, from } = codexCache(root, { bundled: true });
  write(path.join(root, "codex", "config.toml"), '[plugins."vibe@acme-market"]\nenabled = false\n');
  const generic = plugin(path.join(cache, "vibe-generic", "2.3.4"), "vibe-generic", "2.3.4");
  assert.deepEqual(installedProviders({ cwd: root, from }), [], "the disabled build binds nothing");
  assert.deepEqual(knownProviderContracts({ cwd: root, from }).map((entry) => entry.root), [path.join(vibe, "provider")],
    "the disabled build's provider is still known");
  rmSync(vibe, { recursive: true, force: true });
  assert.deepEqual(knownProviderContracts({ cwd: root, from }), [], "vibe-generic alone carries no provider");
  assert.deepEqual(knownProviderContracts({ cwd: root, from: path.join(generic, ".codex-plugin", "plugin.json") }), [],
    "from inside vibe-generic too");
});
