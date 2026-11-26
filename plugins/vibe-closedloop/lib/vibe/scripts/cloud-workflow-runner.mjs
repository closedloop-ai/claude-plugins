// Runs one committed GitHub workflow lane for cloud validation, as GitHub's runner does (AC-68, item 116; team-lead,
// 2026-11-25: "Every step runs as the actor, and the actor gets passwordless sudo for setup"): every `run` step runs as
// the non-root actor through the managed host's lane supervisor, in a private clone of the commit that the actor owns,
// and reaches root only through `sudo`. The host's package repair has already run once as root (the plan step). The
// cloud agent runs it once per lane from its checkout, `node "$p/cloud-workflow-runner.mjs" <index> <results dir>`, where
// $p is the private directory prepareWorkflowPlan wrote (lanes.json, lane-<index>.json and reporter-spec). The runner
// writes the lane's record, <index>.json, into the results directory itself (writeLaneRecord).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudHostEnvironment, HOST_NETWORK, hostNetworkEnvironment, ownTree, PACKAGE_REPAIR_FILE, redactUserinfo, runLaneGroup, runsAsScript, validationHostActor } from "./cloud-validation-host.mjs";

export const WORKFLOW_NOT_RUN = "CLOUD_WORKFLOW_NOT_RUN";
// The managed host's per-lane limit, for a job that sets none.
const JOB_MINUTES = 15;
// GitHub's runner leaves a new file 0644: main's CI passes the tests that require it. The agent's own umask is unknown,
// and under 077 four Node tests failed (the r12 kit's cloud emulation), so a lane never inherits it.
const LANE_UMASK = 0o022;
const BASE_REF = "${{ github.event.pull_request.base.ref }}";
// The actions the runner provides, each with the inputs it honors; any other action or input refuses the lane.
const ACTIONS = new Map([
  ["actions/checkout", ["fetch-depth"]],
  ["actions/setup-node", ["node-version", "cache", "cache-dependency-path"]],
  ["astral-sh/setup-uv", ["python-version"]],
]);
// Where root setup grants the actor passwordless sudo for one lane. sudo reads every file here whose name has no "."
// (so an entry still being written, named with ".new", is never read) and stops working for everyone if one fails to
// parse, so each entry passes `visudo -c` before it takes its name.
export const SUDOERS_DIRECTORY = "/etc/sudoers.d";
// A lane's entry, named for the runner process that wrote it; a pending one ends in ".new".
const LANE_ENTRY = /^vibe-workflow-lane-([1-9]\d*)-[0-9a-f]{8}(?:\.new)?$/;

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const strings = (values) => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, String(value)]));
const label = (step, index) => `step ${index + 1} (${String(step.name ?? step.uses ?? step.run.trim().split("\n")[0]).slice(0, 80)})`;
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(-300);

/**
 * The lane's steps in order. An action is the runner's own setup: it copies a host tool into the lane and runs nothing
 * from the commit. Every `run` step is the actor's, whatever it runs or chains, as on GitHub's runner.
 */
export function workflowLanePlan({ workflow = {}, job }) {
  return job.steps.map((step, index) => {
    const name = label(step, index);
    conditionHolds(step.if, false);
    if (step.uses) {
      const action = step.uses.split("@")[0], inputs = ACTIONS.get(action);
      if (!inputs) refuse(`${name} uses ${action}, which the cloud runner does not provide`);
      const extra = Object.keys(step.with ?? {}).find((key) => !inputs.includes(key));
      if (extra) refuse(`${name} sets the ${action} input ${extra}, which the cloud runner does not provide`);
      return { index, role: "action", name, step };
    }
    const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
    if (shell !== undefined && !["bash", "sh"].includes(shell)) refuse(`${name} uses the shell ${shell}`);
    const directory = path.posix.normalize(step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? ".");
    if (path.posix.isAbsolute(directory) || directory === ".." || directory.startsWith("../")) refuse(`${name} works outside the checkout`);
    return { index, role: "actor", name, step, shell, directory };
  });
}

function visudoCheck(file) {
  const checked = spawnSync("visudo", ["-cqf", file], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${process.env.PATH ?? "/usr/bin:/bin"}:/usr/local/sbin:/usr/sbin:/sbin` } });
  return { exitCode: checked.status ?? 1, detail: oneLine(checked.stderr || checked.stdout || checked.error?.code) };
}

/**
 * Root setup's grant for one lane: passwordless sudo for the actor, as GitHub's runner gives its user, proved with the
 * actor's own `sudo -n true` through the supervisor the steps run under. Returns the function that removes the grant,
 * which runLane calls in its `finally` at the lane's end. A runner killed mid-lane never reaches that `finally` (its
 * steps run synchronously, so it installs no signal handler; team-lead, 2026-11-25), and the stale-entry sweep at the
 * next grant removes the entry it left; the cloud sandbox is discarded after the run anyway. Each lane has its own
 * entry, so one lane's removal never ends another's grant. When the entry cannot be installed or the actor's sudo fails
 * (no sudo, no include of the directory, a "no new privileges" flag), the lane is refused by name and no step runs: a
 * lane never falls back to root.
 */
export function grantActorSudo({ actor, run, cwd, env, directory = SUDOERS_DIRECTORY, check = visudoCheck, alive = processAlive }) {
  const unavailable = (why) => refuse(`root setup: the actor's passwordless sudo is unavailable: ${why}`);
  if (!existsSync(directory)) unavailable(`${directory} does not exist`);
  // The stale-entry sweep: a runner killed before its lane ended left its entry, and this grant removes it (ADV-R11-4).
  for (const name of readdirSync(directory)) {
    const pid = Number(LANE_ENTRY.exec(name)?.[1]);
    if (pid > 1 && pid !== process.pid && !alive(pid)) rmSync(path.join(directory, name), { force: true });
  }
  const entry = path.join(directory, `vibe-workflow-lane-${process.pid}-${randomBytes(4).toString("hex")}`), pending = `${entry}.new`;
  try {
    // sudo resets a command's environment, so the actor's sudo keeps the host's CA and proxy settings its step has.
    writeFileSync(pending, actorSudoers(actor.uid), { flag: "wx", mode: 0o440 });
    chmodSync(pending, 0o440);
    const checked = check(pending);
    if (checked.exitCode !== 0) unavailable(`visudo refused the entry: ${checked.detail}`);
    renameSync(pending, entry);
  } finally { rmSync(pending, { force: true }); }
  const release = () => rmSync(entry, { force: true });
  const proof = run("sudo", ["-n", "true"], { cwd, env, ...actor, stdio: ["ignore", "pipe", "pipe"] }, { timeout: 60_000 });
  if (proof.exitCode !== 0) {
    release();
    unavailable(`the actor's sudo -n true exited ${proof.exitCode ?? "without a code"}: ${oneLine(proof.stderrTail || proof.diagnosis)}`);
  }
  return release;
}

/** The actor's sudoers entry: passwordless sudo, keeping the host's CA and proxy settings through sudo's reset. */
export function actorSudoers(uid) {
  return `#${uid} ALL=(ALL:ALL) NOPASSWD: ALL\nDefaults:#${uid} env_keep += "${HOST_NETWORK.join(" ")}"\n`;
}

/** Whether a process lives, by a probe that sends no signal; one this process may not signal (EPERM) lives. */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** A step's CA and proxy settings, its proxy URLs without userinfo: no proxy credential reaches commit code (V11-5). */
export function stepNetworkEnvironment(current) {
  return Object.fromEntries(Object.entries(hostNetworkEnvironment(current)).map(([key, value]) =>
    [key, /^https?_proxy$/i.test(key) ? value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1") : value]));
}

/** A job or step condition for a pull request validation; one with no status function implies success(), as in CI. */
export function conditionHolds(condition, failed, event = "pull_request") {
  if (condition === undefined) return !failed;
  let text = String(condition).trim();
  if (text.startsWith("${{") && text.endsWith("}}")) text = text.slice(3, -2).trim();
  if (text === "always()") return true;
  if (text === "failure()") return failed;
  if (text === "cancelled()" || text === "false") return false;
  if (failed) return false;
  if (text === "true" || text === "success()") return true;
  const match = /^github\.event_name\s*(==|!=)\s*(['"])([a-z_]+)\2$/.exec(text);
  if (!match) refuse(`unsupported condition ${text}`);
  return (match[3] === event) === (match[1] === "==");
}

/** Whether the actor can search a directory: every component grants it execute by its owner, group or other bits. */
export function actorCanSearch(directory, actor, stat = statSync) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    let info;
    try { info = stat(current); } catch { return false; }
    const bits = info.uid === actor.uid ? info.mode >> 6 : info.gid === actor.gid ? info.mode >> 3 : info.mode;
    if (!info.isDirectory() || (bits & 1) === 0) return false;
    if (path.dirname(current) === current) return true;
  }
}

// The host CA settings that name a certificate file, and the one that names a certificate directory.
const CA_FILES = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"];
const CA_DIRECTORY = "SSL_CERT_DIR";

/**
 * Whether the actor can read `target` by its mode bits, through every directory above it and above the file a link
 * names; for a directory, also list and search it and read each certificate file in it.
 */
export function actorCanRead(target, actor) {
  let real, info;
  try { real = realpathSync(target); info = statSync(real); } catch { return false; }
  const bits = info.uid === actor.uid ? info.mode >> 6 : info.gid === actor.gid ? info.mode >> 3 : info.mode;
  if ((bits & 4) === 0 || !actorCanSearch(path.dirname(target), actor) || !actorCanSearch(path.dirname(real), actor)) return false;
  if (!info.isDirectory()) return true;
  return (bits & 1) !== 0 && readdirSync(real).every((name) => {
    const entry = path.join(real, name);
    try { return !statSync(entry).isFile() || actorCanRead(entry, actor); } catch { return true; }
  });
}

/**
 * The CA settings a root runner's steps receive (s5 lint smoke: uv as the actor loaded no CA certificate from a host
 * CA path only root could read). Each CA file, or certificate directory, the host names that the actor cannot read is
 * copied into `directory`, which is root's, 0755, inside the lane's private area and removed with it: a file 0644, and
 * a directory 0755 holding each certificate file under its own name (hash links become copies). That setting names the
 * copy. A setting the actor can read keeps the host's path, and one naming no such file or directory stays as the host
 * set it. Only these CA settings are copied; proxies and everything else pass as stepNetworkEnvironment leaves them.
 */
export function actorCertificates(network, directory, actor) {
  const staged = {};
  const copy = (source, target) => { copyFileSync(source, target); chmodSync(target, 0o644); };
  for (const key of [...CA_FILES, CA_DIRECTORY]) {
    const source = network[key];
    if (typeof source !== "string" || !path.isAbsolute(source)) continue;
    let info;
    try { info = statSync(source); } catch { continue; }
    if (!(key === CA_DIRECTORY ? info.isDirectory() : info.isFile()) || actorCanRead(source, actor)) continue;
    if (!existsSync(directory)) { mkdirSync(directory); chmodSync(directory, 0o755); }
    const target = path.join(directory, key);
    if (key === CA_DIRECTORY) {
      mkdirSync(target);
      chmodSync(target, 0o755);
      for (const name of readdirSync(source)) {
        try { if (statSync(path.join(source, name)).isFile()) copy(path.join(source, name), path.join(target, name)); } catch { /* a dangling link is no certificate */ }
      }
    } else copy(source, target);
    staged[key] = target;
  }
  return { ...network, ...staged };
}

/** The lane's PATH: the tools its setup actions installed, then each host directory the actor can search. */
export function lanePath(tools, hostPath, actor, stat = statSync) {
  const host = String(hostPath ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry) && actorCanSearch(entry, actor, stat));
  return [...tools, ...host].join(path.delimiter);
}

function onPath(name, hostPath, accept = () => true) {
  for (const entry of String(hostPath ?? "").split(path.delimiter)) {
    const candidate = path.join(entry, name);
    if (path.isAbsolute(entry) && existsSync(candidate) && statSync(candidate).isFile() && accept(candidate)) return realpathSync(candidate);
  }
  return null;
}

/** actions/setup-node: copy the host's Node distribution of the requested major into the lane's tools, as the action installs one. */
function setupNode(step, tools, hostPath, name) {
  const version = String(step.with?.["node-version"] ?? "");
  if (!/^\d+$/.test(version)) refuse(`${name} asks for Node ${version || "(unset)"}; the cloud runner provides a major version`);
  const prefixOf = (binary) => path.dirname(path.dirname(realpathSync(binary)));
  const binary = onPath("node", hostPath, (candidate) => {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return probe.status === 0 && probe.stdout.trim().startsWith(`v${version}.`) && existsSync(path.join(prefixOf(candidate), "lib/node_modules/npm/bin/npm-cli.js"));
  });
  if (!binary) refuse(`${name}: this host has no Node ${version} distribution`);
  const prefix = prefixOf(binary), target = path.join(tools, `node-${version}`);
  if (existsSync(target)) return path.join(target, "bin");
  mkdirSync(path.join(target, "bin"), { recursive: true });
  cpSync(binary, path.join(target, "bin", "node"));
  for (const part of ["lib/node_modules/npm", "lib/node_modules/corepack", "include/node"]) {
    if (existsSync(path.join(prefix, part))) cpSync(path.join(prefix, part), path.join(target, part), { recursive: true, verbatimSymlinks: true });
  }
  for (const [link, script] of [["npm", "npm/bin/npm-cli.js"], ["npx", "npm/bin/npx-cli.js"], ["corepack", "corepack/dist/corepack.js"]]) {
    if (existsSync(path.join(target, "lib/node_modules", script))) symlinkSync(path.join("..", "lib/node_modules", script), path.join(target, "bin", link));
  }
  return path.join(target, "bin");
}

/** astral-sh/setup-uv: copy the host's uv into the lane's tools and select the requested Python, as the action does. */
function setupUv(step, tools, hostPath, name, env) {
  const binary = onPath("uv", hostPath);
  if (!binary) refuse(`${name}: this host has no uv`);
  const target = path.join(tools, "uv");
  mkdirSync(target, { recursive: true });
  for (const tool of ["uv", "uvx"]) {
    const source = path.join(path.dirname(binary), tool);
    if (existsSync(source)) cpSync(source, path.join(target, tool));
  }
  if (step.with?.["python-version"] !== undefined) env.UV_PYTHON = String(step.with["python-version"]);
  return target;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) refuse(`git ${args[0]} failed: ${String(result.stderr ?? result.error?.message ?? "").trim().slice(-300)}`);
  return result.stdout;
}

/**
 * The actor's private copy of the exact commit, with the checkout's remote branches so a base-branch step finds them,
 * and whether it is shallow. Every read happens here, while the runner still owns the copy: once the actor owns it, Git
 * refuses a root caller there as dubious ownership (the r11 kit, as root).
 */
export function laneCheckout(checkout, commit, target) {
  git(checkout, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", checkout, target]);
  git(target, ["fetch", "--quiet", "--no-tags", checkout, "+refs/remotes/origin/*:refs/remotes/origin/*"]);
  git(target, ["checkout", "--quiet", "--detach", commit]);
  if (git(target, ["rev-parse", "HEAD"]).trim() !== commit) refuse("the lane checkout is not the validation commit");
  return { shallow: git(target, ["rev-parse", "--is-shallow-repository"]).trim() !== "false" };
}

/** The pull request's base branch: the branch the checkout's origin names as its default, or null when unrecorded. */
export function pullRequestBase(checkout) {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: checkout, encoding: "utf8" });
  const name = head.status === 0 ? head.stdout.trim() : "";
  return name.startsWith("origin/") && name.length > 7 ? name.slice(7) : null;
}

/**
 * Run one lane's job in declared order. Step output goes to `stdio`; each step's line names the identity it ran as. The
 * lane's exit code is its first failing step's, unless that step continues on error. The runner's own streams pass by
 * name, never by number: the agent opens them write-only (`2>file`), and runLaneGroup reads back a numbered stderr,
 * which failed every step that wrote to it with EBADF (the r11 kit's cloud emulation). The lane's checkout and every
 * step run under LANE_UMASK, and the caller's umask is restored afterwards. A root runner grants the actor
 * passwordless sudo (`sudo`, grantActorSudo) before the first step and removes it after the last. `repaired` names the
 * packages the plan's package repair finished before any lane; the lane's line carries them when there were any.
 */
export function runWorkflowLane(options) {
  const previous = process.umask(LANE_UMASK);
  try { return runLane(options); } finally { process.umask(previous); }
}

function runLane({ checkout, commit, definition, work, base = null, uid, gid, environment = process.env, repaired = [],
  run = runLaneGroup, provision = ownTree, sudo = grantActorSudo, stdio = ["ignore", "inherit", "inherit"], log = (line) => process.stdout.write(line + "\n"), now = Date.now }) {
  const { workflow = {}, job } = definition;
  const plan = workflowLanePlan(definition);
  if (!conditionHolds(job.if, false)) refuse(`the job condition ${job.if} is false for a pull request`);
  if (!base && plan.some(({ step }) => step.run?.includes(BASE_REF))) refuse("a step names the pull request base branch, which the cloud checkout does not record");
  const actor = validationHostActor({ uid, gid });
  const self = uid ?? process.getuid?.();
  const asRoot = self === 0;
  if (asRoot && process.getuid?.() === 0 && !actorCanSearch(work, actor)) refuse("the lane's temporary directory is closed to the actor");
  const clone = path.join(work, "checkout"), home = path.join(work, "home"), tools = path.join(home, "tools"), scripts = path.join(work, "steps");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(path.join(home, "runner-temp"));
  // Explicit modes: a umask can narrow the ones given at creation, and the actor reads every step script.
  mkdirSync(scripts);
  chmodSync(scripts, 0o755);
  const { shallow } = laneCheckout(checkout, commit, clone);
  const own = () => { if (asRoot) { provision(clone, actor); provision(home, actor); } };
  own();
  const github = { CI: "true", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: base ?? "",
    GITHUB_WORKSPACE: clone, RUNNER_OS: "Linux", RUNNER_TEMP: path.join(home, "runner-temp") };
  // Every step is the actor's, installs included, so the actor reaches the registries with the host's own network
  // settings, as GitHub's runner user does, its sudo keeps them, and a proxy URL's userinfo never reaches a step. A root
  // runner gives the actor a readable copy of each host CA path it cannot read (actorCertificates).
  const network = stepNetworkEnvironment(environment);
  const host = { ...cloudHostEnvironment(environment, home, home), ...(asRoot ? actorCertificates(network, path.join(work, "ca"), actor) : network) };
  const env = { ...strings(workflow.env), ...strings(job.env) };
  const bins = [];
  const deadline = now() + (job["timeout-minutes"] ?? JOB_MINUTES) * 60_000;
  const steps = [];
  let exitCode = 0;
  const release = asRoot ? sudo({ actor, run, cwd: clone, env: { ...host, PATH: lanePath([], environment.PATH, actor) } }) : () => {};
  try {
    for (const { index, role, name, step, shell, directory } of plan) {
      const as = role === "actor" ? actor.uid : self;
      if (!conditionHolds(step.if, exitCode !== 0)) { steps.push([index + 1, role, null, null]); continue; }
      log(`CLOUD_WORKFLOW_STEP ${JSON.stringify({ step: index + 1, name, role, uid: as })}`);
      if (role === "action") {
        const action = step.uses.split("@")[0];
        if (action === "actions/setup-node") bins.unshift(setupNode(step, tools, environment.PATH, name));
        else if (action === "astral-sh/setup-uv") bins.unshift(setupUv(step, tools, environment.PATH, name, env));
        else if (Number(step.with?.["fetch-depth"] ?? 1) === 0 && shallow) {
          refuse(`${name} needs the full history, and the cloud checkout is shallow`);
        }
        own();
        steps.push([index + 1, role, as, 0]);
        continue;
      }
      const script = path.join(scripts, `${index + 1}.sh`);
      writeFileSync(script, step.run.replaceAll(BASE_REF, base ?? ""));
      chmodSync(script, 0o644);
      const argv = shell === "sh" ? ["sh", ["-e", script]] : shell === "bash" ? ["bash", ["--noprofile", "--norc", "-eo", "pipefail", script]] : ["bash", ["-e", script]];
      const stepEnv = { ...host, ...github, ...env, ...strings(step.env), PATH: lanePath(bins, environment.PATH, actor) };
      const limit = Math.max(1000, Math.min((step["timeout-minutes"] ?? Infinity) * 60_000, deadline - now()));
      const result = run(argv[0], argv[1], { cwd: path.join(clone, directory), env: stepEnv, ...actor, stdio }, { timeout: limit });
      const code = Number.isInteger(result.exitCode) ? result.exitCode : 1;
      steps.push([index + 1, role, as, code]);
      if (code !== 0 && step["continue-on-error"] !== true && exitCode === 0) exitCode = code;
    }
  } finally { release(); }
  log(`CLOUD_WORKFLOW_LANE ${JSON.stringify({ exitCode, steps, ...(repaired.length ? { repaired } : {}) })}`);
  return { exitCode, steps };
}

/**
 * The lane record the shipped reporter reads: the lane's name, its exit code (or null and why it never ran), the
 * reporter's diagnosis, and redacted tails. Step output stays in the stream files the agent redirects.
 */
export function laneRecord(name, { exitCode, notRun = null, laneLine = "" }) {
  if (notRun !== null) {
    const reason = redactUserinfo(notRun);
    return { name, exitCode: null, notRun: reason, diagnosis: "lane was not run", stdoutTail: "", stderrTail: `${WORKFLOW_NOT_RUN} ${reason}` };
  }
  return { name, exitCode, diagnosis: exitCode === 0 ? "" : "process failed; see private stream evidence", stdoutTail: laneLine, stderrTail: "" };
}

/** The results directory the reporter reads: an existing private directory this process owns, as the reporter requires. */
function resultsDirectory(directory) {
  let info = null;
  try { info = lstatSync(directory); } catch { /* refused below */ }
  if (!path.isAbsolute(directory ?? "") || !info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    refuse("the results directory must be an existing private directory the runner owns");
  }
  return directory;
}

/**
 * Write `<results>/<index>.json` (s6 lint smoke: nothing wrote it, the reporter refused, and the cloud agent must never
 * write evidence itself). It is created 0600 under a pending name and linked into place, so the reporter never reads a
 * partial record and an existing record is never replaced.
 */
export function writeLaneRecord(results, index, record) {
  const target = path.join(results, `${index}.json`), pending = `${target}.${process.pid}.new`;
  try {
    writeFileSync(pending, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    linkSync(pending, target);
  } finally { rmSync(pending, { force: true }); }
}

if (runsAsScript(import.meta.url)) {
  const plan = path.dirname(fileURLToPath(import.meta.url));
  let work = null, lane = null, outcome, laneLine = "";
  const log = (line) => { if (line.startsWith("CLOUD_WORKFLOW_LANE ")) laneLine = line; process.stdout.write(line + "\n"); };
  try {
    const [index, results] = process.argv.slice(2);
    if (process.argv.length !== 4 || !/^(?:0|[1-9]\d*)$/.test(index ?? "")) refuse("run it as cloud-workflow-runner.mjs <lane index> <results directory>");
    resultsDirectory(results);
    const names = JSON.parse(readFileSync(path.join(plan, "lanes.json"), "utf8"));
    if (Number(index) >= names.length) refuse(`lane index ${index} is outside the plan's ${names.length} lanes`);
    lane = { results, index, name: names[Number(index)] };
    const definition = JSON.parse(readFileSync(path.join(plan, `lane-${index}.json`), "utf8"));
    const { commit } = JSON.parse(Buffer.from(readFileSync(path.join(plan, "reporter-spec"), "utf8"), "base64url").toString("utf8"));
    const repairFile = path.join(plan, PACKAGE_REPAIR_FILE);
    const repair = existsSync(repairFile) ? JSON.parse(readFileSync(repairFile, "utf8")) : null;
    if (repair && repair.exitCode !== 0) refuse(`root setup: the host's package repair failed before any lane: ${repair.detail}`);
    const checkout = realpathSync(process.cwd());
    if (git(checkout, ["rev-parse", "HEAD"]).trim() !== commit) refuse("the checkout is not the validation commit");
    work = mkdtempSync(path.join(os.tmpdir(), "vibe-workflow-lane-"));
    chmodSync(work, 0o711);
    outcome = { exitCode: runWorkflowLane({ checkout, commit, definition, work, base: pullRequestBase(checkout), repaired: repair?.partlyInstalled ?? [], log }).exitCode };
  } catch (error) {
    const reason = redactUserinfo(String(error.message).replace(/\s+/g, " ").slice(0, 300));
    process.stderr.write(`${WORKFLOW_NOT_RUN} ${reason}\n`);
    outcome = { exitCode: 78, notRun: reason };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
  process.exitCode = outcome.exitCode;
  if (lane) {
    try { writeLaneRecord(lane.results, lane.index, laneRecord(lane.name, { ...outcome, laneLine })); } catch (error) {
      process.stderr.write(`${WORKFLOW_NOT_RUN} the runner could not write its lane record: ${error.code ?? error.message}\n`);
      process.exitCode = 78;
    }
  }
}
