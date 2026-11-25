import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../../skills/vibe/scripts/test-fixtures.mjs";
import { actorCanSearch, conditionHolds, lanePath, pullRequestBase, runWorkflowLane, stepRole, workflowLanePlan } from "./cloud-workflow-runner.mjs";
import { workflowLaneDefinitions } from "./workflow-lane-definitions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const PASS = { exitCode: 0, stdoutTail: "", stderrTail: "", diagnosis: "" };
const job = (steps, extra = {}) => ({ workflow: {}, job: { "runs-on": "ubuntu-latest", steps, ...extra } });
// A refused lane reads as its reason, so a table comparison shows which job was refused and why.
const roles = (definition) => { try { return workflowLanePlan(definition).map((step) => step.role); } catch (error) { return [error.message]; } };

function lane(t, files = {}) {
  const f = makeHome("workflow-runner-");
  t.after(f.cleanup);
  chmodSync(f.root, 0o755);
  const checkout = path.join(f.root, "checkout");
  makeCheckout({ ...f, checkout, remoteUrl: "https://github.com/example/widgets.git", files });
  const work = mkdtempSync(path.join(f.root, "lane-"));
  chmodSync(work, 0o711);
  return { ...f, checkout, work, commit: git(checkout, ["rev-parse", "HEAD"], f.home) };
}

function file(target, content, mode = 0o644) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
}
const executable = (target, body) => file(target, `#!/bin/sh\n${body}\n`, 0o755);

test("AC-68 workflow step roles: an action, a step of only sudo commands or a dependency install is root setup; any other step is a lane command", () => {
  assert.equal(stepRole({ uses: "actions/checkout@v4" }), "action");
  assert.equal(stepRole({ run: "sudo apt-get update -qq && sudo apt-get install -y -qq zsh" }), "root");
  assert.equal(stepRole({ run: "npm ci" }), "setup");
  assert.equal(stepRole({ run: "uv sync --frozen --group dev" }), "setup");
  assert.equal(stepRole({ run: "npm run typecheck" }), "actor");
  assert.equal(stepRole({ run: "uv run pytest plugins/" }), "actor");
  assert.equal(stepRole({ run: "npm ci && npm test" }), "actor", "an install joined to a lane command is a lane command");
  assert.equal(stepRole({ run: "echo needs sudo" }), "actor", "the word alone is not a sudo command");
  assert.equal(stepRole({ run: "sudo apt-get install -y zsh\nnode --test" }), "mixed");
  assert.equal(stepRole({ run: "make check; sudo make install" }), "mixed");
});

test("AC-68 a root setup step after a lane command, or sudo inside one, refuses the whole lane and names the step", () => {
  const checkout = { uses: "actions/checkout@v4" };
  assert.throws(() => workflowLanePlan(job([checkout, { run: "npm test" }, { run: "npm ci" }])),
    /^Error: step 3 \(npm ci\) is root setup after the lane command step 2 \(npm test\)$/);
  assert.throws(() => workflowLanePlan(job([checkout, { run: "npm test" }, { name: "Packages", run: "sudo apt-get install -y zsh" }])),
    /step 3 \(Packages\) is root setup after the lane command step 2 \(npm test\)/);
  assert.throws(() => workflowLanePlan(job([checkout, { run: "npm test" }, { uses: "actions/setup-node@v4" }])), /step 3 \(actions\/setup-node@v4\) is root setup after/);
  assert.throws(() => workflowLanePlan(job([checkout, { name: "Both", run: "sudo apt-get install -y zsh && npm test" }])), /step 2 \(Both\) runs sudo inside a lane command/);
  assert.throws(() => workflowLanePlan(job([{ uses: "actions/cache@v4" }])), /uses actions\/cache, which the cloud runner does not provide/);
  assert.throws(() => workflowLanePlan(job([{ uses: "actions/checkout@v4", with: { ref: "main" } }])), /sets the actions\/checkout input ref/);
  assert.throws(() => workflowLanePlan(job([{ run: "Write-Host", shell: "pwsh" }])), /uses the shell pwsh/);
  assert.throws(() => workflowLanePlan(job([{ run: "ls", "working-directory": "../other" }])), /works outside the checkout/);
  assert.deepEqual(roles(job([checkout, { run: "sudo apt-get install -y zsh" }, { run: "npm ci" }, { run: "npm test" }, { run: "npm run build" }])),
    ["action", "root", "setup", "actor", "actor"]);
});

test("AC-68 this repository's CI workflow: every job is root setup, then lane commands, with no step needing root mid-lane", () => {
  const definitions = workflowLaneDefinitions(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
  const table = Object.fromEntries(definitions.map((definition) => [definition.job, roles(JSON.parse(definition.command))]));
  assert.deepEqual(table, {
    "plugin-version-bump": ["action", "actor"],
    "plugin-manifest-versions": ["action", "action", "setup", "actor", "actor"],
    lint: ["action", "action", "setup", "actor"],
    typecheck: ["action", "action", "setup", "actor"],
    test: ["action", "action", "setup", "action", "setup", "actor"],
    "node-tests": ["action", "action", "root", "actor"],
    "vibe-eval-t0": ["action", "action", "action", "setup", "setup", "actor", "actor", "actor", "actor"],
    "tools-ts": ["action", "action", "setup", "actor", "actor", "actor"],
  });
  assert.ok(definitions.filter((definition) => definition.job === "tools-ts").every((definition) =>
    JSON.stringify(roles(JSON.parse(definition.command))) === JSON.stringify(table["tools-ts"])), "every tools-ts matrix row has the same step roles");
});

test("AC-68 conditions follow CI for a pull request: success() is implied, always() and failure() run after a failure", () => {
  assert.equal(conditionHolds(undefined, false), true);
  assert.equal(conditionHolds(undefined, true), false);
  assert.equal(conditionHolds("github.event_name == 'pull_request'", false), true);
  assert.equal(conditionHolds("${{ github.event_name != 'pull_request' }}", false), false);
  assert.equal(conditionHolds("github.event_name == 'push'", false), false);
  assert.equal(conditionHolds("github.event_name == 'pull_request'", true), false, "an event check implies success()");
  assert.equal(conditionHolds("always()", true), true);
  assert.equal(conditionHolds("failure()", true), true);
  assert.equal(conditionHolds("failure()", false), false);
  assert.equal(conditionHolds("cancelled()", true), false);
  assert.equal(conditionHolds(true, true), false);
  assert.equal(conditionHolds(false, false), false);
  assert.throws(() => conditionHolds("contains(github.ref, 'x')", false), /unsupported condition/);
});

test("AC-68 the actor's PATH keeps only directories it can search, after the tools the lane's setup installed", () => {
  const tree = new Map([
    ["/", { uid: 0, gid: 0, mode: 0o755 }], ["/root", { uid: 0, gid: 0, mode: 0o700 }], ["/root/.local", { uid: 0, gid: 0, mode: 0o755 }],
    ["/root/.local/bin", { uid: 0, gid: 0, mode: 0o755 }], ["/opt", { uid: 0, gid: 0, mode: 0o755 }], ["/opt/node22", { uid: 0, gid: 0, mode: 0o755 }],
    ["/opt/node22/bin", { uid: 0, gid: 0, mode: 0o755 }], ["/srv", { uid: 0, gid: 4000, mode: 0o750 }], ["/srv/bin", { uid: 0, gid: 4000, mode: 0o755 }],
    ["/home", { uid: 0, gid: 0, mode: 0o755 }], ["/home/actor", { uid: 65534, gid: 65534, mode: 0o700 }], ["/home/actor/bin", { uid: 65534, gid: 65534, mode: 0o700 }],
  ]);
  const stat = (entry) => {
    const info = tree.get(entry);
    if (!info) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { ...info, isDirectory: () => true };
  };
  const actor = { uid: 65534, gid: 65534 };
  assert.equal(actorCanSearch("/root/.local/bin", actor, stat), false, "a directory under root's closed home");
  assert.equal(actorCanSearch("/opt/node22/bin", actor, stat), true);
  assert.equal(actorCanSearch("/srv/bin", actor, stat), false, "group bits bind a non-member to the other bits");
  assert.equal(actorCanSearch("/srv/bin", { uid: 65534, gid: 4000 }, stat), true, "the group's execute bit grants a member");
  assert.equal(actorCanSearch("/home/actor/bin", actor, stat), true, "the owner's execute bit grants its owner");
  assert.equal(actorCanSearch("/missing", actor, stat), false);
  assert.equal(lanePath(["/lane/tools/node-22/bin"], "/root/.local/bin:/opt/node22/bin:relative:/srv/bin:/home/actor/bin", actor, stat),
    "/lane/tools/node-22/bin:/opt/node22/bin:/home/actor/bin");
});

test("AC-68 as root, environment setup runs as root with the host network settings and every lane command as the actor without them", (t) => {
  const f = lane(t);
  const calls = [], owned = [], lines = [];
  const definition = { workflow: { env: { LEVEL: "workflow" } }, job: { "runs-on": "ubuntu-latest", env: { LEVEL: "job", JOB: "1" },
    defaults: { run: { "working-directory": "tools/widget" } }, steps: [
      { uses: "actions/checkout@v4" },
      { name: "Packages", run: "sudo apt-get update -qq && sudo apt-get install -y -qq zsh" },
      { run: "npm ci" },
      { name: "Check", run: "git diff ${{ github.event.pull_request.base.ref }}", env: { STEP: "yes" }, "working-directory": "." },
      { name: "Allowed", run: "exit 4", "continue-on-error": true },
      { name: "Fails", run: "exit 5" },
      { name: "Skipped", run: "echo never" },
      { name: "Report", run: "echo always", if: "always()" },
    ] } };
  git(f.checkout, ["update-ref", "refs/remotes/origin/release", f.commit], f.home);
  const codes = { "5.sh": 4, "6.sh": 5 };
  const result = runWorkflowLane({ checkout: f.checkout, commit: f.commit, definition, work: f.work, base: "main", uid: 0, gid: 0,
    environment: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://proxy.invalid:3128", SECRET_EXAMPLE: "fixture" },
    provision: (tree, actor) => owned.push([path.relative(f.work, tree), actor.uid]), log: (line) => lines.push(line),
    run: (command, args, options) => { calls.push({ command, args, options }); return { ...PASS, exitCode: codes[path.basename(args.at(-1))] ?? 0 }; } });
  const clone = path.join(f.work, "checkout"), home = path.join(f.work, "home");
  assert.equal(git(clone, ["rev-parse", "HEAD"], f.home), f.commit, "the lane runs in its own clone of the exact commit");
  assert.equal(git(clone, ["rev-parse", "origin/main"], f.home), f.commit, "the clone keeps the checkout's remote base branch");
  assert.equal(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release"], { encoding: "utf8" }).stdout.trim(), f.commit,
    "a branch the checkout holds only as a remote branch is in the clone");
  assert.deepEqual(calls.map(({ args }) => path.basename(args.at(-1))), ["2.sh", "3.sh", "4.sh", "5.sh", "6.sh", "8.sh"], "a success() step after a failure is skipped");
  const [packages, install, check, ...rest] = calls;
  for (const setup of [packages, install]) {
    assert.equal(setup.options.uid, undefined, "root setup keeps the runner's own identity");
    assert.equal(setup.options.env.HTTPS_PROXY, "http://proxy.invalid:3128", "root setup keeps the host's network settings");
    assert.equal(setup.options.env.SECRET_EXAMPLE, undefined);
    assert.equal(setup.options.env.HOME, home, "root setup writes its caches into the actor's home");
    assert.equal(setup.options.env.GIT_CONFIG_VALUE_1, clone, "root setup trusts exactly the actor-owned clone");
    assert.equal(setup.options.cwd, path.join(clone, "tools/widget"));
  }
  for (const command of [check, ...rest]) {
    assert.deepEqual([command.options.uid, command.options.gid], [65534, 65534], "every lane command runs as the actor");
    assert.equal(command.options.env.HTTPS_PROXY, undefined, "the actor gets no host network settings");
    assert.equal(command.options.env.SECRET_EXAMPLE, undefined);
  }
  assert.equal(check.options.cwd, clone, "a step's working directory overrides the job default");
  assert.deepEqual([check.options.env.LEVEL, check.options.env.JOB, check.options.env.STEP, check.options.env.CI, check.options.env.GITHUB_EVENT_NAME, check.options.env.GITHUB_BASE_REF],
    ["job", "1", "yes", "true", "pull_request", "main"]);
  assert.deepEqual(check.args.slice(0, -1), ["-e"], "a step with no shell runs under bash -e, as in CI");
  assert.equal(readFileSync(check.args.at(-1), "utf8"), "git diff main", "the base branch expression is the pull request's base");
  assert.deepEqual(owned, [["checkout", 65534], ["home", 65534], ["checkout", 65534], ["home", 65534], ["checkout", 65534], ["home", 65534], ["checkout", 65534], ["home", 65534]],
    "the actor owns the clone and its home at the start and after each root step");
  assert.equal(result.exitCode, 5, "the first failing step that does not continue on error sets the lane's exit");
  assert.deepEqual(result.steps.map(([step, role, uid, code]) => [step, role, uid, code]), [
    [1, "action", 0, 0], [2, "root", 0, 0], [3, "setup", 0, 0], [4, "actor", 65534, 0], [5, "actor", 65534, 4], [6, "actor", 65534, 5],
    [7, "actor", null, null], [8, "actor", 65534, 0]]);
  assert.match(lines.at(-1), /^CLOUD_WORKFLOW_LANE \{"exitCode":5,"steps":\[\[1,"action",0,0\]/);
  assert.ok(lines.some((line) => line === 'CLOUD_WORKFLOW_STEP {"step":4,"name":"step 4 (Check)","role":"actor","uid":65534}'));
  assert.equal(git(f.checkout, ["status", "--porcelain"], f.home), "", "the agent's checkout is untouched");
});

test("AC-68 setup-node and setup-uv install the host's tools into the lane, first on its PATH, and refuse a version the host lacks", (t) => {
  const f = lane(t);
  const host = path.join(f.root, "host");
  executable(path.join(host, "old/bin/node"), "echo v20.1.0");
  file(path.join(host, "old/lib/node_modules/npm/bin/npm-cli.js"), "old npm\n");
  executable(path.join(host, "plain/bin/node"), "echo v22.9.0");
  executable(path.join(host, "dist/bin/node"), "echo v22.3.0");
  file(path.join(host, "dist/lib/node_modules/npm/bin/npm-cli.js"), "npm 10\n");
  file(path.join(host, "dist/lib/node_modules/npm/bin/npx-cli.js"), "npx 10\n");
  executable(path.join(host, "uv/uv"), "echo uv 0.9.0");
  executable(path.join(host, "uv/uvx"), "echo uvx");
  const environment = { PATH: [path.join(host, "old/bin"), path.join(host, "plain/bin"), path.join(host, "dist/bin"), path.join(host, "uv"), "/usr/bin", "/bin"].join(":") };
  const calls = [];
  const definition = job([
    { uses: "actions/setup-node@v4", with: { "node-version": "22", cache: "npm" } },
    { uses: "astral-sh/setup-uv@v6", with: { "python-version": "3.13" } },
    { run: "uv run pytest" },
  ]);
  runWorkflowLane({ checkout: f.checkout, commit: f.commit, definition, work: f.work, environment, log: () => {},
    run: (command, args, options) => { calls.push(options); return PASS; } });
  const tools = path.join(f.work, "home/tools");
  const [first, second] = calls[0].env.PATH.split(":");
  assert.deepEqual([first, second], [path.join(tools, "uv"), path.join(tools, "node-22/bin")], "the latest setup action comes first, as each action prepends");
  assert.equal(readFileSync(path.join(tools, "node-22/bin/node"), "utf8"), "#!/bin/sh\necho v22.3.0\n", "the first Node 22 with its npm is the one copied");
  assert.equal(readlinkSync(path.join(tools, "node-22/bin/npm")), "../lib/node_modules/npm/bin/npm-cli.js");
  assert.equal(readFileSync(path.join(tools, "node-22/bin/npx"), "utf8"), "npx 10\n");
  assert.equal(existsSync(path.join(tools, "node-22/bin/corepack")), false, "a missing corepack gets no link");
  assert.deepEqual(readdirSync(path.join(tools, "uv")).sort(), ["uv", "uvx"]);
  assert.equal(calls[0].env.UV_PYTHON, "3.13");
  const other = lane(t);
  assert.throws(() => runWorkflowLane({ checkout: other.checkout, commit: other.commit, work: other.work, environment, log: () => {}, run: () => PASS,
    definition: job([{ uses: "actions/setup-node@v4", with: { "node-version": "24" } }, { run: "node --test" }]) }), /this host has no Node 24 distribution/);
});

test("AC-68 a real lane: setup as root, then each lane command as the actor in its own clone, so a mode 000 file is closed to it", (t) => {
  const f = lane(t, { "tools/widget/README.md": "widget\n" });
  const bin = path.join(f.root, "bin");
  executable(path.join(bin, "npm"), 'id -u > "$HOME/setup-uid"');
  chmodSync(bin, 0o755);
  const definition = job([
    { uses: "actions/checkout@v4", with: { "fetch-depth": 0 } },
    { run: "npm ci" },
    { name: "Identity", run: 'id -u > "$HOME/lane-uid"\ntouch closed\nchmod 000 closed\nif cat closed 2>/dev/null; then echo readable; else echo denied; fi > "$HOME/mode-000"\ngit rev-parse HEAD > "$HOME/head"',
      "working-directory": "tools/widget" },
    { run: "exit 3", shell: "bash" },
  ]);
  const lines = [];
  const stdio = ["ignore", "pipe", "pipe"];
  const result = runWorkflowLane({ checkout: f.checkout, commit: f.commit, definition, work: f.work, environment: { PATH: `${bin}:/usr/bin:/bin` }, stdio, log: (line) => lines.push(line) });
  const home = path.join(f.work, "home"), read = (name) => readFileSync(path.join(home, name), "utf8").trim();
  const asRoot = process.getuid() === 0;
  assert.equal(read("setup-uid"), String(process.getuid()), "a dependency install runs as the runner itself");
  assert.equal(read("lane-uid"), asRoot ? "65534" : String(process.getuid()), "a root runner drops every lane command to the actor");
  assert.equal(read("mode-000"), "denied", "the lane command cannot read a file it made mode 000, as on a non-root CI runner");
  assert.equal(read("head"), f.commit);
  assert.equal(result.exitCode, 3, "the lane's exit is its failing step's");
  assert.match(lines.at(-1), asRoot ? /"steps":\[\[1,"action",0,0\],\[2,"setup",0,0\],\[3,"actor",65534,0\],\[4,"actor",65534,3\]\]/ : /"exitCode":3/);
});

test("AC-68 a fetch-depth 0 checkout refuses the lane when the cloud checkout is shallow, and runs no lane command", (t) => {
  const f = lane(t);
  git(f.checkout, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "--allow-empty", "-m", "second"], f.home);
  const shallow = path.join(f.root, "shallow");
  git(f.root, ["clone", "--quiet", "--depth", "1", `file://${f.checkout}`, shallow], f.home);
  const commit = git(shallow, ["rev-parse", "HEAD"], f.home), calls = [];
  const definition = job([{ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }, { run: "git log" }]);
  const options = { commit, definition, environment: { PATH: "/usr/bin:/bin" }, log: () => {}, run: () => { calls.push(1); return PASS; } };
  assert.throws(() => runWorkflowLane({ ...options, checkout: shallow, work: f.work }), /step 1 \(actions\/checkout@v4\) needs the full history, and the cloud checkout is shallow/);
  assert.deepEqual(calls, []);
  const full = mkdtempSync(path.join(f.root, "lane-"));
  chmodSync(full, 0o711);
  assert.equal(runWorkflowLane({ ...options, checkout: f.checkout, commit: git(f.checkout, ["rev-parse", "HEAD"], f.home), work: full }).exitCode, 0);
  assert.deepEqual(calls, [1], "the same lane runs on a full checkout");
});

// The runner command over a plan directory holding these lane definitions, as the agent runs it:
// `node "$p/cloud-workflow-runner.mjs" <index> >$d/<index>.stdout 2>$d/<index>.stderr`, so both streams are files opened
// write-only. With `umask`, the shell that starts it sets that umask first.
function runnerCommand(f, definitions, umask = null) {
  const plan = path.join(f.checkout, ".git", "vibe-workflow-fixture");
  mkdirSync(plan);
  for (const name of ["cloud-workflow-runner.mjs", "cloud-validation-host.mjs"]) cpSync(path.join(here, name), path.join(plan, name));
  writeFileSync(path.join(plan, "lanes.json"), JSON.stringify(definitions.map((_, index) => `lane ${index}`)));
  for (const [index, definition] of definitions.entries()) writeFileSync(path.join(plan, `lane-${index}.json`), JSON.stringify({ version: 1, ...definition, matrix: {} }));
  writeFileSync(path.join(plan, "reporter-spec"), Buffer.from(JSON.stringify({ commit: f.commit })).toString("base64url"));
  const temporary = mkdtempSync(path.join(f.root, "tmp-"));
  chmodSync(temporary, 0o755);
  const runner = (...args) => {
    const [out, err] = ["stdout", "stderr"].map((name) => path.join(f.root, `${args.join("-") || "none"}.${name}`));
    const fds = [openSync(out, "w"), openSync(err, "w")];
    const command = [process.execPath, path.join(plan, "cloud-workflow-runner.mjs"), ...args];
    const options = { cwd: f.checkout, env: { PATH: process.env.PATH, TMPDIR: temporary }, stdio: ["ignore", ...fds] };
    try {
      const child = umask === null ? spawnSync(command[0], command.slice(1), options) : spawnSync("sh", ["-c", `umask ${umask}; exec "$@"`, "sh", ...command], options);
      return { status: child.status, stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8") };
    } finally { for (const fd of fds) closeSync(fd); }
  };
  return { runner, temporary };
}

test("AC-68 the runner command runs one planned lane, removes its private copy, and refuses a lane it cannot run with a NOT_RUN line", (t) => {
  const f = lane(t);
  const definitions = [job([{ uses: "actions/checkout@v4" }, { run: "echo lane output\necho lane warning >&2" }]), job([{ uses: "actions/cache@v4" }])];
  const { runner, temporary } = runnerCommand(f, definitions);
  const ran = runner("0");
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^lane output$/m);
  assert.match(ran.stderr, /^lane warning$/m, "a lane writing to a write-only stderr file still runs to its exit");
  assert.match(ran.stdout.trim().split("\n").at(-1), /^CLOUD_WORKFLOW_LANE \{"exitCode":0,/);
  assert.deepEqual(readdirSync(temporary), [], "the lane's private copy is removed after it ends");
  for (const [args, reason] of [[["1"], /uses actions\/cache, which the cloud runner does not provide/], [["2"], /outside the plan's 2 lanes/], [[], /run it as cloud-workflow-runner\.mjs <lane index>/]]) {
    const refused = runner(...args);
    assert.equal(refused.status, 78);
    assert.match(refused.stderr.trim().split("\n").at(-1), new RegExp("^CLOUD_WORKFLOW_NOT_RUN .*" + reason.source));
  }
  assert.equal(pullRequestBase(f.checkout), "main", "the base branch is the one the checkout's origin names");
  git(f.checkout, ["remote", "set-head", "origin", "--delete"], f.home);
  assert.equal(pullRequestBase(f.checkout), null);
});

test("AC-68 every lane step runs under umask 022 as on GitHub's runner, whatever the agent's shell sets, and the caller's umask comes back", (t) => {
  const f = lane(t);
  const create = `node -e 'const fs = require("node:fs"); fs.writeFileSync("made", ""); console.log("mode", (fs.statSync("made").mode & 0o777).toString(8))'`;
  const { runner } = runnerCommand(f, [job([{ uses: "actions/checkout@v4" }, { run: `umask\n${create}` }])], "077");
  const ran = runner("0");
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^0022$/m, "a lane command started from a 077 shell runs under GitHub's 022");
  assert.match(ran.stdout, /^mode 644$/m, "a file it creates is 0644, as main's CI tests require");
  // In a child process, so this test's own umask never changes: 022 only while the lane runs.
  const probe = `import { spawnSync } from "node:child_process"; import { runWorkflowLane } from ${JSON.stringify(pathToFileURL(path.join(here, "cloud-workflow-runner.mjs")).href)};
const shell = () => spawnSync("sh", ["-c", "umask"], { encoding: "utf8" }).stdout.trim();
const [checkout, commit, work] = process.argv.slice(1);
process.umask(0o077);
let inside = null;
runWorkflowLane({ checkout, commit, work, definition: { workflow: {}, job: { steps: [{ run: "true" }] } }, environment: { PATH: process.env.PATH }, log: () => {},
  run: () => { inside = shell(); return { exitCode: 0 }; } });
process.stdout.write(JSON.stringify({ inside, after: shell() }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe, f.checkout, f.commit, f.work], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { inside: "0022", after: "0077" }, "the lane step sees 022, and the caller's 077 is back after the lane");
});
