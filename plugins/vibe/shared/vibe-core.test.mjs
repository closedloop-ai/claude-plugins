// vibe's hooks and the modules they run live in vibe (lib/**, hooks/**); vibe-core only loads vibe's hook runtime.
// These pin that each such module has one home in vibe, that vibeCore() asks only for what exists, that it never
// needs vibe-core, and that the setup check still names a missing or too old vibe-core.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comparePluginVersions, pluginManifest } from "./plugin-roots.mjs";
import { VIBE_CORE_MIN, vibeCoreRoot } from "./vibe-core.mjs";

const VIBE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = vibeCoreRoot();
const DESTRUCTURED = /const \{([^}]*)\} = await vibeCore\(\s*"([^"]+)"\s*\)/g;
const NAMED_LOAD = /\b(?:vibeCore|vibeCorePath|runVibeCoreMain)\(\s*"([^"]+)"\s*\)/g;
const BUNDLED_SOURCE = /^\/\/ (\S+\.mjs)$/gm;

function files(dir, keep, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files(file, keep, found);
    else if (keep(file)) found.push(file);
  }
  return found;
}

const isModule = (file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs");
/** Where a lib module's command line keeps a skill path: lib/<skill>/scripts/x is skills/<skill>/scripts/x. */
const vibePath = (relative) => relative.replace(/^lib\//, "skills/");
const wrapper = (relative, file) => {
  let loader = path.relative(path.dirname(file), path.join(VIBE, "shared", "vibe-core.mjs"));
  if (!loader.startsWith(".")) loader = `./${loader}`;
  return `#!/usr/bin/env node\n// This command lives in vibe's lib/ folder; its skill path keeps working through this wrapper.\n`
    + `import { runVibeCoreMain } from "${loader}";\n\nawait runVibeCoreMain("${relative}");\n`;
};
const libModules = files(path.join(VIBE, "lib"), isModule).map((file) => path.relative(VIBE, file));
const wrappers = libModules.map((relative) => [relative, path.join(VIBE, vibePath(relative))]).filter(([, file]) => existsSync(file));

test("each lib module has one home: at most a thin command wrapper stays at its skill path", () => {
  assert.ok(libModules.includes("lib/vibe/scripts/session-record.mjs") && existsSync(path.join(VIBE, "hooks", "runtime.mjs")));
  for (const [relative, file] of wrappers) assert.equal(readFileSync(file, "utf8"), wrapper(relative, file), `${vibePath(relative)} is a copy, not a wrapper`);
  assert.deepEqual(wrappers.map(([relative]) => vibePath(relative)).sort(), [
    "skills/codex-fleet-monitor/scripts/liveness.mjs",
    "skills/codex-fleet-monitor/scripts/work-dir.mjs",
    "skills/fleet-orchestrator/scripts/fleet-home.mjs",
    "skills/fleet-orchestrator/scripts/helpers.mjs",
    "skills/fleet-orchestrator/scripts/skill-freshness.mjs",
    "skills/handoff/scripts/review-receipts.mjs",
    "skills/vibe/scripts/cloud-worker.mjs",
    "skills/vibe/scripts/e2e-lock.mjs",
    "skills/vibe/scripts/image-head.mjs",
    "skills/vibe/scripts/owned-state.mjs",
    "skills/vibe/scripts/provider.mjs",
    "skills/vibe/scripts/tested-head.mjs",
  ]);
  assert.ok(!existsSync(path.join(VIBE, "hooks", "hooks.json")), "vibe registers no hooks; vibe-core's hooks.json does");
  for (const file of files(VIBE, isModule)) {
    const source = readFileSync(file, "utf8");
    for (const [relative, wrapped] of wrappers) {
      let specifier = path.relative(path.dirname(file), wrapped);
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      assert.ok(!source.includes(`from "${specifier}"`) && !source.includes(`from '${specifier}'`), `${path.relative(VIBE, file)} imports the ${relative} wrapper`);
    }
  }
});

test("vibe's bundles load its lib and hooks modules from vibe at run time instead of carrying copies", () => {
  const bundles = files(path.join(VIBE, "skills", "vibe", "scripts", "dist"), (file) => file.endsWith(".mjs"));
  assert.ok(bundles.length >= 2);
  const runTime = /plugins\/vibe\/(?:lib|hooks)\/|plugins\/vibe\/shared\/process-identity\.mjs$|plugins\/vibe-core\//;
  for (const bundle of bundles) {
    const source = readFileSync(bundle, "utf8");
    // A run-time stub is labeled vibe-core:<path>; an inlined copy is labeled with its source path.
    const inlined = [...source.matchAll(BUNDLED_SOURCE)].map((match) => match[1]).filter((file) => !file.startsWith("vibe-core:") && runTime.test(file));
    assert.deepEqual(inlined, [], path.basename(bundle));
  }
  assert.match(readFileSync(path.join(VIBE, "skills", "vibe", "scripts", "dist", "writer-state.mjs"), "utf8"),
    /^\/\/ vibe-core:lib\/vibe\/scripts\/session-record\.mjs\nvar module\d* = await vibeCore\("lib\/vibe\/scripts\/session-record\.mjs"\);$/m);
});

test("vibeCore() asks only for modules and names vibe has, and VIBE_CORE_MIN is no newer than this checkout's vibe-core", async () => {
  // The skew tests write a pre-slim vibe's loads into fixtures on purpose; they aim at vibe-core's stubs, not at vibe.
  const sources = files(VIBE, (file) => file.endsWith(".mjs") && !file.includes(`${path.sep}dist${path.sep}`) && file !== fileURLToPath(import.meta.url)
    && !/vibe-core-skew[^/]*\.test\.mjs$/.test(file));
  let checked = 0;
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const [, relative] of source.matchAll(NAMED_LOAD)) {
      assert.ok(existsSync(path.join(VIBE, relative)), `${path.relative(VIBE, file)} loads ${relative}, which vibe does not have`);
    }
    for (const [, names, relative] of source.matchAll(DESTRUCTURED)) {
      const exported = new Set(Object.keys(await import(pathToFileURL(path.join(VIBE, relative)).href)));
      for (const name of names.split(",").map((part) => part.trim().split(":")[0].trim()).filter(Boolean)) {
        assert.ok(exported.has(name), `${path.relative(VIBE, file)} takes ${name} from ${relative}, which does not export it`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 100, `checked only ${checked} names`);
  const installed = pluginManifest(CORE).version;
  assert.ok(comparePluginVersions(VIBE_CORE_MIN, installed) <= 0, `VIBE_CORE_MIN ${VIBE_CORE_MIN} is newer than vibe-core ${installed}`);
});

test("vibeCore() loads from vibe itself with no vibe-core beside it, while the setup check names a missing or too old vibe-core", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-core-loader-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vibe = path.join(root, "plugins", "vibe");
  mkdirSync(path.join(vibe, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(vibe, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.1.71" }));
  cpSync(path.join(VIBE, "shared"), path.join(vibe, "shared"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  mkdirSync(path.join(vibe, "lib"));
  writeFileSync(path.join(vibe, "lib", "marker.mjs"), 'export const marker = "own vibe";\n');
  const run = (code) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { vibeCore, vibeCoreProblem } from ${JSON.stringify(pathToFileURL(path.join(vibe, "shared", "vibe-core.mjs")).href)}; ${code}`], { encoding: "utf8" });
  const load = () => run('process.stdout.write((await vibeCore("lib/marker.mjs")).marker);');
  const problem = () => run('process.stdout.write(vibeCoreProblem()?.message ?? "none");').stdout;
  assert.equal(load().stdout, "own vibe", load().stderr);
  assert.match(problem(), /vibe-core is not installed beside vibe \(checkout layout\); install it with `claude plugin install vibe-core@closedloop-ai` in Claude Code or `codex plugin add vibe-core@closedloop-ai` in Codex/);
  const core = path.join(root, "plugins", "vibe-core");
  mkdirSync(path.join(core, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(core, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe-core", version: "0.9.0" }));
  assert.match(problem(), new RegExp(`vibe 1\\.1\\.71 needs vibe-core ${VIBE_CORE_MIN.replaceAll(".", "\\.")} or newer, but vibe-core 0\\.9\\.0 is installed; update it`));
  assert.equal(load().stdout, "own vibe", "an old vibe-core never stops vibe's own modules loading");
});

test("the loader's fixes name the marketplace and the vibe they were installed from", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-core-loader-cache-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "codex", "plugins", "cache", "team-market");
  const vibe = path.join(cache, "vibe-generic", "1.1.88");
  mkdirSync(path.join(vibe, ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(vibe, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "vibe-generic", version: "1.1.88" }));
  cpSync(path.join(VIBE, "shared"), path.join(vibe, "shared"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  const load = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { vibeCoreProblem, VIBE_CORE_INSTALL } from ${JSON.stringify(pathToFileURL(path.join(vibe, "shared", "vibe-core.mjs")).href)};
process.stdout.write(JSON.stringify({ problem: vibeCoreProblem()?.message, install: VIBE_CORE_INSTALL }));`], { encoding: "utf8" });
  const missing = JSON.parse(load().stdout);
  assert.deepEqual(missing.install, { claude: "claude plugin install vibe-core@team-market", codex: "codex plugin add vibe-core@team-market" });
  assert.equal(missing.problem, "vibe-core is not installed beside vibe-generic (codex layout); install it with "
    + "`claude plugin install vibe-core@team-market` in Claude Code or `codex plugin add vibe-core@team-market` in Codex");
  const core = path.join(cache, "vibe-core", "0.9.0");
  mkdirSync(path.join(core, ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(core, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "vibe-core", version: "0.9.0" }));
  assert.equal(JSON.parse(load().stdout).problem, `vibe-generic 1.1.88 needs vibe-core ${VIBE_CORE_MIN} or newer, but vibe-core 0.9.0 is installed; `
    + "update it with `claude plugin update vibe-core@team-market` in Claude Code or `codex plugin add vibe-core@team-market` in Codex");
});

test("each command wrapper behaves as running its lib module directly", (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-core-wrappers-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // No codex on PATH, so the liveness probe reads nothing live.
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const outcome = (script) => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env, timeout: 20_000, input: "" });
    const message = result.stderr.split("\n").find((line) => line && !line.startsWith("file://") && !/^\s/.test(line) && !line.startsWith("Node.js")) ?? "";
    return { status: result.status, stdout: result.stdout, message };
  };
  for (const [relative, file] of wrappers) assert.deepEqual(outcome(file), outcome(path.join(VIBE, relative)), vibePath(relative));
});
