import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, openSync, readSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, lchownSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const NO_INPUT = "ignore";
const UNPRIVILEGED_FALLBACK = 65534;
const RANGE = Object.freeze({ first: 20000, last: 39999, width: 32 });
const READY_CHROMIUM = new Map();
const WORKSPACE = /^[A-Za-z0-9_@./: +%=\[\]-]+$/;
const BROWSER_VERSION = "1.65.0";
const BROWSER_STORE = "/opt/pw-browsers";
const HEADLESS_SHELL = path.join(BROWSER_STORE, "chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell");
const HOST_TIMEOUT = 15 * 60_000;

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const API_VALUES = {
  AWS_ACCESS_KEY_ID: /^test-(?:aws-)?(?:access-)?key(?:-id)?$/,
  AWS_SECRET_ACCESS_KEY: /^test-(?:aws-)?(?:secret-)?key$/,
  AWS_REGION: /^(?:us|eu|ap|ca|sa|af|me|il|mx)-[a-z]+-[1-9]$/,
};

function optional(read, file) {
  try { return read(file); } catch { return null; }
}

function apiFixture(read, recipe) {
  if (!recipe?.apiFixture || !recipe.apiWorkflowPattern) return null;
  const { apiFixture: fixturePath, apiSetup: setupPath, apiWorkflow: workflowPath } = recipe;
  const bytes = optional(read, fixturePath);
  if (typeof bytes !== "string" || bytes.length > 512) return null;
  const setup = optional(read, setupPath);
  const workflow = optional(read, workflowPath);
  const source = /^\s*(?:dotenv\.config|dotenvConfig)\s*\(\s*\{[^;]*["']\.env\.test["']/m.test(setup ?? "") ? setupPath
    : new RegExp(recipe.apiWorkflowPattern, "m").test(workflow ?? "") ? workflowPath : null;
  if (!source) return null;
  const values = {};
  for (const raw of bytes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_]+)=([a-z0-9-]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]) || !Object.hasOwn(API_VALUES, match[1]) || !API_VALUES[match[1]].test(match[2])) return null;
    values[match[1]] = match[2];
  }
  const keys = Object.keys(values).sort();
  if (keys.length !== Object.keys(API_VALUES).length) return null;
  return { metadata: { path: fixturePath, source, sha256: digest(bytes), sourceSha256: digest(source === setupPath ? setup : workflow), keys }, values };
}

/** Bind API test fixture metadata to exact committed bytes. Keep its values out of requests and receipts. */
export function cloudApiEnvironment(read, commit, recipe) {
  const fixture = apiFixture(read, recipe);
  return fixture ? { ...fixture.metadata, commit } : null;
}

function hostApiEnvironment(root, declaration, run, recipe, options) {
  const read = (file) => {
    const result = run("git", ["show", `HEAD:${file}`], options);
    if (result.exitCode !== 0) throw new Error("approved fixture file is missing");
    return result.stdoutTail;
  };
  const head = run("git", ["rev-parse", "HEAD"], options);
  const fixture = apiFixture(read, recipe);
  if (!fixture || head.exitCode !== 0 || declaration.commit !== head.stdoutTail.trim() ||
      !isDeepStrictEqual(declaration, { ...fixture.metadata, commit: declaration.commit })) return null;
  return fixture.values;
}

function redactFixture(result, values) {
  for (const field of ["stdoutTail", "stderrTail", "diagnosis"]) {
    for (const value of Object.values(values ?? {})) result[field] = String(result[field] ?? "").replaceAll(value, "[test fixture]");
  }
  return result;
}

/** Reserve an exclusive per-lane range in the cloud host's private state and release it only by exact owner. */
export function reserveCloudPorts(directory, { first, last, width } = RANGE) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isSafeInteger(width) || width < 2 ||
    first < 1024 || last > 65535 || first + width - 1 > last) throw new Error("cloud port range bounds are invalid");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let start = first; start + width - 1 <= last; start += width) {
    const claim = path.join(directory, String(start));
    try { mkdirSync(claim, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    const token = randomUUID();
    const marker = path.join(claim, "owner");
    try { writeFileSync(marker, token, { mode: 0o600, flag: "wx" }); }
    catch (error) { rmSync(claim, { recursive: true }); throw error; }
    return {
      first: start, last: start + width - 1,
      release() {
        if (existsSync(marker) && readFileSync(marker, "utf8") === token) rmSync(claim, { recursive: true });
      },
    };
  }
  throw new Error("CLOUD_PORT_RANGE_EXHAUSTED: all validation lane ranges are reserved");
}

/** Normalize the two legitimate UTC spellings and reject non-UTC or unrepresentable fixture times. */
export function canonicalGitTimestamp(input) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|\+00:00)$/.test(input ?? "")) throw new Error("a valid UTC Git timestamp is required");
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error("a valid UTC Git timestamp is required");
  const normalized = d.toISOString().replace(".000Z", "Z");
  if (normalized.slice(0, 19) !== input.slice(0, 19)) throw new Error("a valid UTC Git timestamp is required");
  return normalized;
}

// The cloud VM reaches registries through a TLS-intercepting proxy that only the host CA bundle trusts, so the
// non-root actor needs the same trust settings to install packages. Only paths, the system-CA switch and proxy
// addresses without credentials cross over; tokens and other secrets never do.
const TRUST_PATHS = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
function trustSetting([key, value]) {
  if (TRUST_PATHS.includes(key)) return typeof value === "string" && path.isAbsolute(value) && !/[\s;&|`$<>]/.test(value);
  if (key === "NODE_USE_SYSTEM_CA") return value === "1";
  if (PROXIES.includes(key)) return typeof value === "string" && value.length < 2048 && !/@/.test(value) && !/[\s;&|`$<>]/.test(value);
  return false;
}

/** Standard Git and process environment for the dedicated non-root cloud subprocess. */
export function cloudHostEnvironment(current, home, registry) {
  const settings = Object.entries(current).filter((entry) => ["PATH", "CI", "TERM", "PNPM_HOME"].includes(entry[0]) || trustSetting(entry));
  return { ...Object.fromEntries(settings), HOME: home, PLAYWRIGHT_BROWSERS_PATH: BROWSER_STORE, XDG_CACHE_HOME: path.join(home, ".cache"), TZ: "UTC", LC_ALL: "C", CONTROL_REGISTRY_DIR: registry,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "log.date", GIT_CONFIG_VALUE_0: "iso-strict-local" };
}

function processResult(child) {
  const exitCode = Number.isInteger(child.status) ? child.status : child.error?.code === "ETIMEDOUT" ? 124 : 78;
  return { exitCode, stdoutTail: String(child.stdout ?? ""), stderrTail: String(child.stderr ?? ""),
    diagnosis: child.error ? String(child.error.code ?? child.error.message) : child.signal ? `terminated by ${child.signal}` : "" };
}

function execFile(command, args, options) {
  return processResult(spawnSync(command, args, { ...options, timeout: options.timeout ?? HOST_TIMEOUT, encoding: "utf8",
    stdio: [NO_INPUT, "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }));
}

/** Direct lane streams into private files so verbose output never terminates the child or masks its exit. */
function runLane(command, args, options, directory, index) {
  const streamFiles = {};
  const descriptors = [];
  try {
    for (const channel of ["stdout","stderr"]) {
      const file = path.join(directory,index+"."+channel);
      descriptors.push(openSync(file,"wx+",0o600));
      streamFiles[channel] = file;
    }
    const result = processResult(spawnSync(command,args,{...options, timeout:HOST_TIMEOUT, stdio:[NO_INPUT,...descriptors]}));
    for (const [position,channel] of ["stdout","stderr"].entries()) {
      const fd = descriptors[position], size = fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(4096,size));
      readSync(fd,bytes,0,bytes.length,size-bytes.length);
      result[channel+"Tail"] = bytes.toString("utf8");
    }
    return {...result,streamFiles};
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

function inControlNamespace(binary,args) {
  return ["unshare",["--user","--map-current-user","--net","--","sh","-ec",
    'ip link set lo up || exit 78; exec "$@"',"control-lane",binary,...args]];
}

/** Install only the committed workspace's Chromium and prove a headless launch before allowing a browser lane. */
export function prepareHostChromium(cwd, { environment, run = execFile, actor, home }) {
  let lock;
  try { lock = readFileSync(path.join(cwd, "pnpm-lock.yaml")); }
  catch { return { exitCode: 78, stdoutTail: "", stderrTail: "", diagnosis: "no committed pnpm lockfile for Chromium setup" }; }
  const key = `${realpathSync(cwd)}:${home}:${actor.uid}:${digest(lock)}`;
  if (READY_CHROMIUM.has(key)) return READY_CHROMIUM.get(key);
  const credentialFree = { cwd, env: environment, ...actor, timeout: 120_000 };
  const revision = run("test", ["-x",HEADLESS_SHELL], credentialFree);
  if (revision.exitCode !== 0) return {...revision,diagnosis:"required Chromium headless shell revision 1254 is missing"};
  const version = run("pnpm", ["exec","playwright","--version"], credentialFree);
  if (version.exitCode !== 0 || version.stdoutTail.trim() !== "Version " + BROWSER_VERSION) {
    return {...version,exitCode:78,diagnosis:"workspace Playwright differs from the installed browser setup " + BROWSER_VERSION};
  }
  const installed = run("pnpm", ["exec", "playwright", "install", "chromium"], credentialFree);
  if (installed.exitCode !== 0) return installed;
  const probe = path.join(home, "chromium-preflight.png");
  const launched = run("pnpm", ["exec", "playwright", "screenshot", "--browser=chromium", "data:text/html,probe", probe], credentialFree);
  if (launched.exitCode === 0) READY_CHROMIUM.set(key, launched);
  return launched;
}

/** Decode quotes around literal argv fragments without interpreting shell expansions. */
export function literalArgv(command) {
  const words = [];
  let current = "", quote = "", started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === "'" || ch === '"') { quote = ch; started = true; }
    else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = ""; started = false;
    } else { current += ch; started = true; }
  }
  if (quote) throw new Error("cloud runtime needs a literal supported argv lane");
  if (started) words.push(current);
  return words;
}

/** Check the decoded program and arguments against the managed host's allowed entry points. */
export function routeArgv(command, bootstrap) {
  const words = literalArgv(command);
  if (words.some((word) => !WORKSPACE.test(word)) || !["node", "pnpm", "uv", "pytest", "ruff", "pyright", bootstrap].includes(words[0])) {
    throw new Error("cloud runtime needs a literal supported argv lane");
  }
  return words;
}

/** Normalize equivalent pnpm entry points for prerequisite selection and serial typechecking. */
export function canonicalCloudArgv(words) {
  if (words[0] !== "pnpm") return words;
  const args = words.slice(1).map(word => word === "-F" ? "--filter" : word.replace(/^-F=/, "--filter="));
  while (["-w", "--workspace-root"].includes(args[0])) args.shift();
  if (["run", "exec"].includes(args[0])) args.shift();
  if (args[0] === "turbo" && args[1] === "run") args.splice(1, 1);
  return ["pnpm", ...args];
}

/** Turbo task names belong to the selected binary before the task argument separator. */
export function cloudTurboTasks(argv,read) {
  if (argv[0] !== "pnpm") return [];
  const end=argv.indexOf("--"), words=argv.slice(1,end < 0 ? undefined : end);
  while (["-w","--workspace-root"].includes(words[0])) words.shift();
  const binary=words[0] === "exec";
  if (binary) words.shift();
  if (words.shift() !== "turbo") return [];
  if (!binary && read) {
    try { if (JSON.parse(read("package.json"))?.scripts?.turbo) return []; } catch { /* A missing manifest cannot shadow the binary. */ }
  }
  if (words[0] === "run") words.shift();
  const tasks=[];
  for (let i=0;i<words.length;i++) {
    const word=words[i];
    if (["--filter","-F","--concurrency","--cwd","--output-logs","--cache-dir","--env-mode"].includes(word)) i++;
    else if (!word.startsWith("-")) tasks.push(word);
  }
  return tasks;
}

// Ask the installed command registry before expanding shorthand. Use a private empty directory
// so help cannot evaluate a checkout's own configuration or select/download another toolchain.
const scriptLookups = new Map();
function pnpmScriptShorthand(name, manager) {
  if (manager !== undefined && !/^pnpm@\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(manager)) return false;
  const identity = JSON.stringify([process.env.PATH,manager,name]);
  if (!scriptLookups.has(identity)) {
    const cwd = mkdtempSync(path.join(os.tmpdir(),"pnpm-command-"));
    try {
      if (manager) writeFileSync(path.join(cwd,"package.json"),JSON.stringify({packageManager:manager}));
      const probe = spawnSync("pnpm",["help",name],{cwd,encoding:"utf8",timeout:5000,
        env:{PATH:process.env.PATH,HOME:os.homedir(),COREPACK_ENABLE_NETWORK:"0",LC_ALL:"C"}});
      if (probe.error || probe.status !== 0) throw new Error("cannot verify pnpm command precedence for "+name);
      const lines = probe.stdout.trim().split(/\r?\n/);
      const version = /^Version (\d+)\./.exec(lines[0]);
      if (!version) throw new Error("unrecognized pnpm help response for "+name);
      const absent = lines.at(-1) === 'No results for "'+name+'"';
      // pnpm 11 explicitly permits these built-in command names to be overridden by root package scripts.
      const overridable = version[1] === "11" && ["rebuild","rb","setup","deploy","clean","purge"].includes(name);
      scriptLookups.set(identity,absent || overridable);
    } finally { rmSync(cwd,{recursive:true,force:true}); }
  }
  return scriptLookups.get(identity);
}

/** A committed root script that delegates directly to one literal Turbo typecheck can share its execution policy. */
export function cloudTypecheckArgv(argv, read) {
  if (argv[0] !== "pnpm" || !read) return argv;
  let index = 1;
  while (["-w","--workspace-root"].includes(argv[index])) index++;
  if (argv[index] === "exec") return argv;
  const explicit = argv[index] === "run";
  if (explicit) index++;
  const scriptName = argv[index];
  if (!scriptName || scriptName.startsWith("-")) return argv;
  let target, literal, manager;
  try {
    const manifest = JSON.parse(read("package.json"));
    manager = manifest?.packageManager;
    const script = manifest?.scripts?.[scriptName];
    if (typeof script !== "string") return argv;
    literal = routeArgv(script);
    target = canonicalCloudArgv(literal);
  } catch { return argv; }
  if (target[2] !== "typecheck" || !cloudTurboTasks(literal,read).includes("typecheck")) return argv;
  // Only package selection may qualify this exact committed alias. Other scripts execute as written.
  for (let i=3; i<target.length; i++) {
    if (target[i] === "--filter" && target[i+1] && !target[i+1].startsWith("-")) { i++; continue; }
    if (!/^--filter=.+/.test(target[i])) return argv;
  }
  if (!explicit && !pnpmScriptShorthand(scriptName,manager)) return argv;
  return [...literal,...argv.slice(index+1)];
}

function ownTree(root, actor) {
  lchownSync(root, actor.uid, actor.gid);
  if (lstatSync(root).isDirectory()) for (const entry of readdirSync(root)) ownTree(path.join(root, entry), actor);
}

/** Use a host account with no privilege escalation, or drop root to the locked-down Linux uid/gid before argv execution. */
export function validationHostActor({ uid = process.getuid?.(), gid = process.getgid?.() } = {}) {
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error("cloud runtime cannot establish a Unix user");
  return uid === 0 ? { uid: UNPRIVILEGED_FALLBACK, gid: UNPRIVILEGED_FALLBACK } : { uid, gid: gid || uid };
}

function skipped(name, why) { return { name, exitCode: null, notRun: why, stdoutTail: "", stderrTail: "", diagnosis: why }; }

/**
 * Execute a committed plan with a non-root child, dedicated state and a port lease for every lane. Workspace
 * preparation runs before requested lanes and leaves each result available to the existing per-lane importer.
 */
export function runCloudHostPlan({ checkout, directory, lanes, uid, gid, environment = process.env,
  contract, run = execFile, provision = ownTree, allocate = reserveCloudPorts, browser = prepareHostChromium, leaseDirectory,
}) {
  const actor = validationHostActor({ uid, gid });
  const root = realpathSync(checkout);
  const work = realpathSync(directory);
  const home = path.join(work, "home");
  const leases = leaseDirectory ?? path.join(work, "ports");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(leases, { recursive: true, mode: 0o700 });
  const asRoot = (uid ?? process.getuid?.()) === 0;
  if (asRoot) { provision(root, actor); provision(home, actor); }
  const streams = run === execFile ? mkdtempSync(path.join(work,"streams-")) : null;
  let prerequisiteFailure;
  // Environment setup is not a lane (operator ruling 2026-11-24 on AC-68, item 116): the provider's declared services
  // start once as root before any lane, and every lane command, a lane's tests included, still runs as the actor.
  if (asRoot) {
    for (const service of contract?.data?.recipes?.cloudValidation?.rootServices ?? []) {
      const started = /^[a-z0-9][a-z0-9.-]{0,63}$/.test(service)
        ? run("service", [service, "start"], { cwd: root, env: { PATH: environment.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin" }, timeout: 120_000 })
        : { exitCode: 78 };
      if (started.exitCode !== 0) { prerequisiteFailure = `root setup: service ${service} start`; break; }
    }
  }
  const reserved = [];
  try {
    for (const lane of lanes) reserved.push(allocate(leases));
    return lanes.map((lane, index) => {
      if (prerequisiteFailure) return skipped(lane.name, `prerequisite ${prerequisiteFailure} failed`);
      const ports = reserved[index];
      const registry = path.join(home, `control-${index}-${ports.first}-${ports.last}`);
      mkdirSync(registry, { mode: 0o700 });
      if ((uid ?? process.getuid?.()) === 0) provision(registry, actor);
      const env = cloudHostEnvironment(environment, home, registry);
      const read = file => readFileSync(path.join(root,file),"utf8");
      const [command, ...args] = cloudTypecheckArgv(routeArgv(lane.command, contract?.data?.recipes?.bootstrap?.command), read);
      const [,program] = canonicalCloudArgv([command,...args]);
      if (cloudTurboTasks([command,...args],read).includes("typecheck")) {
        const separator = args.indexOf("--");
        const forwarded = separator < 0 ? [] : args.splice(separator);
        for (let i=0; i<args.length;) {
          if (args[i] === "--concurrency") args.splice(i,2);
          else if (args[i].startsWith("--concurrency=")) args.splice(i,1);
          else i++;
        }
        args.push("--concurrency=1",...forwarded);
      }
      if (command === "pnpm" && program === "typecheck") env.TURBO_TYPECHECK_CONCURRENCY = "1";
      const values = lane.envSource ? hostApiEnvironment(root, lane.envSource, run, contract?.data?.recipes?.cloudValidation,{cwd:root,env,...actor}) : null;
      if (lane.envSource && !values) return skipped(lane.name, "approved committed non-secret test fixture differs; run on L2 (remote slot heavy)");
      // The repository bootstrap is environment setup: it runs once as root, and the actor then owns what it wrote.
      const rootSetup = asRoot && lane.prerequisite === true && lane.name === "setup:repo-bootstrap";
      const options = rootSetup ? { cwd: root, env: { ...env, ...values } } : { cwd: root, env: { ...env, ...values }, ...actor };
      if (command === "pnpm" && args.slice(0, 3).join(" ") === "control up web") {
        args.push("--app-port", String(ports.first), "--api-port", String(ports.first + 1));
      }
      const preflight = lane.browser ? browser(root, { environment: env, run, actor, home }) : null;
      let validCommand = lane.displayless ? ["xvfb-run", ["-a", "--server-args=-screen 0 1920x1080x24", command, ...args]] : [command, args];
      // Nested control tests select from their own fixed port range. Give them a fresh loopback namespace.
      if (lane.isolateControlPorts) validCommand = inControlNamespace(...validCommand);
      const failedPreflight = preflight && preflight.exitCode !== 0;
      const includingBrowser = failedPreflight
        ? { ...preflight, stderrTail:[preflight.stderrTail,preflight.diagnosis].filter(Boolean).join("\n"), diagnosis: "Chromium preflight failed" }
        : streams ? runLane(...validCommand, options, streams, index) : run(...validCommand, options);
      if (!failedPreflight && lane.isolateControlPorts && includingBrowser.exitCode !== 0 &&
          /unshare:|no free app\/api port pair|cannot find device|operation not permitted/i.test((includingBrowser.stderrTail + "\n" + includingBrowser.stdoutTail))) {
        includingBrowser.diagnosis = "CLOUD_PORT_RANGE_UNAVAILABLE: isolated control port pairs unavailable; run on L2";
      }
      if (rootSetup) { provision(root, actor); provision(home, actor); }
      if (lane.prerequisite && includingBrowser.exitCode !== 0) prerequisiteFailure = lane.name;
      return { name: lane.name, ...redactFixture(includingBrowser, values), runtime: { uid: rootSetup ? 0 : actor.uid, ports: [ports.first, ports.last] } };
    });
  } finally {
    for (const ports of reserved) ports.release();
  }
}

/** Bind a retained private stream without loading its entire contents into memory. */
function streamReceipt(file) {
  const fd = openSync(file,"r"), hash = createHash("sha256"), chunk = Buffer.alloc(64*1024);
  let bytes = 0;
  try {
    for (let size; (size = readSync(fd,chunk,0,chunk.length,null)) !== 0;) {
      hash.update(chunk.subarray(0,size));
      bytes += size;
    }
    return {file,bytes,sha256:hash.digest("hex")};
  } finally { closeSync(fd); }
}

/** Keep full per-lane evidence outside the checkout and print only a compact pointer to it. */
export function persistHostOutcomes(root, lanes) {
  const directory = mkdtempSync(path.join(root,"vibe-lane-results-"));
  try {
    for (const [index,lane] of lanes.entries()) {
      let saved = lane;
      if (lane.streamFiles) {
        const streamFiles = {}, privateStreams = {};
        for (const channel of ["stdout","stderr"]) {
          const target = path.join(directory,index+"."+channel);
          copyFileSync(lane.streamFiles[channel],target);
          streamFiles[channel] = target;
          privateStreams[channel] = streamReceipt(target);
        }
        saved = {...lane,streamFiles,privateStreams};
      }
      // A skipped command and a failed browser preflight produced no validation process streams.
      // Keep the preflight output in the private metadata, separate from the two empty lane files.
      if (!lane.streamFiles && (lane.exitCode===null && lane.notRun || lane.exitCode!==0 && lane.diagnosis==="Chromium preflight failed")) {
        for (const channel of ["stdout","stderr"]) writeFileSync(path.join(directory,index+"."+channel),"",{flag:"wx",mode:0o600});
      }
      writeFileSync(path.join(directory,index+".json"),JSON.stringify(saved),{flag:"wx",mode:0o600});
    }
    return "CLOUD_HOST_LANES " + JSON.stringify({directory,count:lanes.length});
  } catch (error) {
    rmSync(directory,{recursive:true,force:true});
    throw error;
  }
}

const REPORTER_FILE = /^[a-z0-9-]+\.mjs$/;
const TOOL_ROOT = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/**
 * Run the shipped outcome reporter from the exact tool commit on this run's lane directory, so the machine record or
 * the result-branch push never depends on a later agent step.
 */
export function runHostReporter(checkout, reporter, laneDirectory, run = spawnSync) {
  if (!/^[a-f0-9]{40}$/.test(reporter?.tool ?? "") || !TOOL_ROOT.test(reporter.root ?? "") || typeof reporter.spec !== "string"
    || !Array.isArray(reporter.files) || !reporter.files.includes("cloud-outcome-writer.mjs") || !reporter.files.every((name) => REPORTER_FILE.test(name))) {
    throw new Error("the host plan names no valid shipped reporter");
  }
  const directory = mkdtempSync(path.join(checkout, ".git", "vibe-outcomes-host-"));
  try {
    for (const name of reporter.files) {
      const shown = run("git", ["show", `${reporter.tool}:${reporter.root}/lib/vibe/scripts/${name}`],
        { cwd: checkout, encoding: "utf8", stdio: [NO_INPUT, "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
      if (shown.status !== 0) throw new Error(`cannot read reporter file ${name} at the tool commit`);
      writeFileSync(path.join(directory, name), shown.stdout, { mode: 0o600 });
    }
    return processResult(run(process.execPath, [path.join(directory, "cloud-outcome-writer.mjs"), reporter.spec, laneDirectory],
      { cwd: checkout, encoding: "utf8", stdio: [NO_INPUT, "pipe", "pipe"], timeout: HOST_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** The runner's own record of what it printed and how it ended; the exit file is written last so a poll sees both. */
export function writeHostRunFiles(runner, output, exitCode) {
  writeFileSync(runner + ".out", output, { mode: 0o600 });
  writeFileSync(runner + ".exit", `${exitCode}\n`, { mode: 0o600 });
}

/** Exercise the actual cloud image using fixed files and commands before its capability receipt becomes eligible. */
export function probeCloudHostRuntime(directory, checkout = process.cwd(), run = execFile) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "vibe-runtime-"));
  const actor = validationHostActor();
  const runtime = { workspace: false, nonRoot: false, ports: false, chromium: false, gitUtc: false };
  const details = {};
  try {
    const marker = path.join(sandbox, "restricted");
    const child = path.join(sandbox, "probe.cjs");
    writeFileSync(marker, "probe", { mode: 0 });
    writeFileSync(child, `const fs = require("node:fs"); let denied = false; try { fs.readFileSync(process.argv[2]); } catch (error) { denied = error.code === "EACCES"; } process.exit(process.getuid() > 0 && denied ? 0 : 1);\n`);
    if (process.getuid() === 0) ownTree(sandbox, actor);
    const environment = cloudHostEnvironment(process.env, sandbox, path.join(sandbox, "control"));
    const options = { cwd: sandbox, env: environment, ...actor, timeout: 120_000 };
    details.nonRoot = run(process.execPath, [child, marker], options);
    runtime.nonRoot = details.nonRoot.exitCode === 0;
    const [binary,argv] = inControlNamespace(process.execPath,["-e","const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>s.close());"]);
    details.controlNamespace = run(binary,argv,options);
    runtime.controlNamespace = runtime.nonRoot && details.controlNamespace.exitCode === 0;
    const leases = [];
    try {
      for (let index = 0; index < 10; index++) leases.push(reserveCloudPorts(path.join(directory, "capability-ports")));
      runtime.ports = leases.every((lease, index) => index === 0 || lease.first > leases[index - 1].last);
    } finally { for (const lease of leases) lease.release(); }
    const sample = path.join(sandbox, "packages/check");
    mkdirSync(sample, { recursive: true });
    writeFileSync(path.join(sandbox, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(path.join(sandbox, "package.json"), '{"name":"vibe-runtime-proof","private":true}');
    writeFileSync(path.join(sample, "package.json"), '{"name":"vibe-runtime-workspace","scripts":{"build":"node build.cjs"}}');
    writeFileSync(path.join(sample, "build.cjs"), 'require("node:fs").writeFileSync("dist.js", "workspace build ran")');
    if (process.getuid() === 0) ownTree(sandbox, actor);
    details.workspace = run("pnpm", ["--filter", "vibe-runtime-workspace", "build"], options);
    runtime.workspace = details.workspace.exitCode === 0 && existsSync(path.join(sample, "dist.js"));
    const playwright = ["--package=playwright@" + BROWSER_VERSION, "dlx", "playwright"];
    details.chromiumInstall = run("test", ["-x", HEADLESS_SHELL], options);
    if (details.chromiumInstall.exitCode === 0) {
      details.chromiumLaunch = run("pnpm", [...playwright, "screenshot", "--browser=chromium", "data:text/html,probe", path.join(sandbox, "probe.png")], options);
      runtime.chromium = details.chromiumLaunch.exitCode === 0;
    }
    runtime.chromium1254 = runtime.chromium;
    details.gitUtc = run("git", ["log", "-1", "--format=%ad", "--date=iso-strict-local"], { cwd: checkout, env: environment });
    try { runtime.gitUtc = details.gitUtc.exitCode === 0 && Boolean(canonicalGitTimestamp(details.gitUtc.stdoutTail.trim())); }
    catch { /* Preserve the failed exact UTC probe. */ }
    return { checks: runtime, details };
  } finally { rmSync(sandbox, { recursive: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output = "";
  const emit = (line, stream = process.stdout) => { stream.write(line + "\n"); output += line + "\n"; };
  try {
    if (process.platform !== "linux" || process.env.CLAUDE_CODE_REMOTE !== "true" || process.argv.length !== 3) {
      throw new Error("run the exact checked Cloud validation host plan on Claude cloud Linux");
    }
    const plan = JSON.parse(process.argv[2]);
    const checkout = realpathSync(process.cwd());
    const head = execFile("git", ["rev-parse", "HEAD"], { cwd: checkout });
    if (head.exitCode !== 0 || head.stdoutTail.trim() !== plan.commit) throw new Error("cloud host plan checkout differs from the exact validation commit");
    const directory = mkdtempSync(path.join(os.tmpdir(), "vibe-validation-"));
    const target = path.join(directory, "checkout");
    try {
      const clone = execFile("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", checkout, target], { cwd: checkout });
      const checkoutHead = clone.exitCode === 0 && execFile("git", ["checkout", "--quiet", "--detach", plan.commit], { cwd: target });
      if (!checkoutHead || checkoutHead.exitCode !== 0) throw new Error("could not materialize the exact commit for a non-root lane");
      chmodSync(directory, 0o711);
      const ports = path.join(os.tmpdir(), "vibe-cloud-validation-ports");
      const recipeFile = fileURLToPath(import.meta.url) + ".provider.json";
      const contract = existsSync(recipeFile) ? JSON.parse(readFileSync(recipeFile, "utf8")) : null;
      const lanes = runCloudHostPlan({ checkout: target, directory, lanes: plan.lanes, leaseDirectory: ports, contract });
      const persisted = persistHostOutcomes(os.tmpdir(),lanes);
      emit(persisted);
      if (plan.reporter) {
        const report = runHostReporter(checkout, plan.reporter, JSON.parse(persisted.slice("CLOUD_HOST_LANES ".length)).directory);
        if (report.stdoutTail.trim()) emit(report.stdoutTail.trim());
        if (report.exitCode !== 0) {
          emit(`CLOUD_HOST_REPORTER_FAILED ${report.exitCode}: ${report.stderrTail.trim().slice(-400)}`, process.stderr);
          process.exitCode = 1;
        }
      }
    } finally { rmSync(directory, { recursive: true }); }
  } catch (error) {
    emit(`CLOUD_HOST_UNAVAILABLE: ${error.message}`, process.stderr);
    process.exitCode = 78;
  } finally {
    writeHostRunFiles(fileURLToPath(import.meta.url), output, process.exitCode ?? 0);
  }
}
