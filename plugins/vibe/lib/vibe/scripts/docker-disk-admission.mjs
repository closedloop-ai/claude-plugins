import { installedProviders } from "./provider.mjs";
import { commandPrefix, commandSegments } from "../../../hooks/command-segments.mjs";
import { segmentCalls } from "../../../hooks/command-calls.mjs";
import { capturedJson } from "./captured-json.mjs";
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_FREE_BYTES = 64_000_000_000n;

function systemRun(binary, args) {
  return spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
}

function sameInode(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function output(binary, args, run) {
  const result = run(binary, args);
  if (result.error || result.status !== 0) throw new Error(binary + ' probe is unreadable: '
    + String(result.stderr ?? result.error ?? '').trim());
  return String(result.stdout ?? '').trim();
}

/** Resolve the commands executed by a shell lane while retaining the original argv for direct callers. */
function invocationSegments(command, args) {
  const shell = ["sh", "bash", "zsh"].includes(path.basename(command ?? "")) && /^-[a-z]*c$/.test(args[0] ?? "") && typeof args[1] === "string";
  if (shell) return commandSegments(args[1], { expandShellPayloads: true }).filter(entry=>!entry.unreachable);
  const raw = [command,...args];
  const {index,...prefix} = commandPrefix(raw);
  return [{words:raw.slice(index),scope:"root",substitutions:[],...prefix}];
}

function commandWords(command,args) {
  return invocationSegments(command,args).map(segment => segment.words);
}

/** Resolve the executable and the package directory selected by each exec wrapper. */
function executable(words,cwd) {
  const [bin,...args] = words;
  if (path.basename(bin ?? "") === "pnpm") {
    let workspace = false;
    while (args.length) {
      if (["-w","--workspace-root"].includes(args[0])) {workspace = true; args.shift(); continue;}
      let directory;
      if (["-C","--dir"].includes(args[0])) {args.shift(); directory = args.shift() ?? "";}
      else if (args[0].startsWith("--dir=")) directory = args.shift().slice(6);
      else if (/^-C.+/.test(args[0])) directory = args.shift().slice(2);
      else break;
      cwd = directory && cwd && !/[$`]/.test(directory) ? path.resolve(cwd,directory) : undefined;
    }
    if (args[0] === "exec") return executable(args.slice(args[1] === "--" ? 2 : 1),cwd);
    return {argv:["pnpm",...(args[0] === "run" ? args.slice(1) : args)],cwd,workspace};
  }
  if ((["npm","yarn"].includes(bin) && args[0] === "exec") || bin === "npx") {
    return executable(args.slice(bin === "npx" ? 0 : 1),cwd);
  }
  return {argv:words,cwd};
}
function executableWords(words) { return executable(words).argv; }

// Resolve the script in executable position. A runner passed as data to another command stays data.
function runnerPath(words, admission) {
  const bin = path.basename(words[0] ?? "");
  const interpreter = ["sh", "bash", "zsh"].includes(bin) || (admission && ["node", "nodejs"].includes(bin));
  if (!interpreter) return words[0] ?? "";
  let index = 1;
  while (/^-[euxv]+$/.test(words[index] ?? "")) index++;
  if (words[index] === "--") index++;
  return words[index] ?? "";
}

function composeRunner(words, admission = false) {
  const argv = executableWords(words);
  if (path.basename(argv[0] ?? "") === "pnpm") return argv[argv[1] === "run" ? 2 : 1] === "e2e:containerized";
  return /(?:^|\/)run-containerized\.sh$/.test(runnerPath(argv, admission));
}

const stackRecipe = installedProviders()[0]?.contract.data?.recipes?.e2e;
const stackProducers = stackRecipe?.stackProducers ?? [];
function providerStackRunner(words) {
  const argv = executableWords(words);
  for (const rule of stackRecipe?.stackCommands ?? []) {
    if (!rule.prefix.every((word,index)=>argv[index] === word)) continue;
    if (argv.some((word,index)=>word === rule.option && argv[index+1] === rule.value || word === rule.option+"="+rule.value)) return true;
  }
  const script = runnerPath(argv, true).replace(/^\.\//, "");
  return stackProducers.some(relative => script === relative || (path.isAbsolute(script) && script.endsWith("/" + relative)));
}

/** Only building the Compose runner reserves local service tags and installs the owned builder. */
export function buildsComposeImages(command, args = []) {
  return commandWords(command, args).some(words => composeRunner(words) && !words.includes("--no-build"));
}

/** Compose's explicit build commands, excluding inspection, help, reuse, and simulated runs. */
function composeInvocation(raw, initial = process.cwd()) {
  const {argv:words,cwd} = executable(raw,initial);
  const binary = path.basename(words[0] ?? "");
  let pos = 1, clientOverride = false;
  if (binary === "docker") {
    while (pos < words.length && words[pos] !== "compose") {
      const option = words[pos++];
      if (["--context","-c","--host","-H","--config"].includes(option)) pos++;
      else if (!/^(?:--(?:context|host|config)=.+|-[cH].+)$/.test(option)) return null;
      clientOverride = true;
    }
    if (words[pos++] !== "compose") return null;
  } else if (binary !== "docker-compose") return null;
  const args = words.slice(pos);
  if (args.some(arg => ["--help", "-h", "--dry-run", "--print", "--check"].includes(arg))) return null;
  const files = [];
  let project, projectDirectory, index = 0;
  const valueOptions = new Set(["-f","--file","-p","--project-name","--env-file","--project-directory","--profile","--parallel","--progress","--ansi"]);
  while (index < args.length) {
    const raw = args[index];
    if (["--compatibility","--all-resources"].includes(raw)) { index++; continue; }
    const equal = raw.indexOf("=");
    const compact = /^(-[pf])([^=].*)$/.exec(raw);
    const option = compact ? compact[1] : equal < 0 ? raw : raw.slice(0,equal);
    if (!valueOptions.has(option)) break;
    const value = compact ? compact[2] : equal < 0 ? args[++index] : raw.slice(equal+1);
    if (!value) return null;
    if (option === "-p" || option === "--project-name") project = value;
    if (option === "--project-directory") projectDirectory = value;
    if (option === "-f" || option === "--file") files.push(value);
    index++;
  }
  return { files, cwd, clientOverride, projectDirectory, manifest:files.some(file => /(?:^|\/)e2e\/compose\.ya?ml$/.test(cwd ? path.resolve(cwd,file) : file)), project, verb:args[index], args:args.slice(index+1) };
}

function explicitComposeBuild(words) {
  const call = composeInvocation(words);
  return !!call && !call.args.includes("--no-build") &&
    (call.verb === "build" || (["up","run"].includes(call.verb) && call.args.includes("--build")));
}

/** Bind the slot holder to the explicit Docker CLI project, which overrides the environment. */
export function explicitComposeProject(command,args = [], inherited = process.env.COMPOSE_PROJECT_NAME) {
  const projects = new Set();
  const segments = invocationSegments(command,args);
  // The launcher always exports this variable, generating its value when the caller supplied none.
  const environment = {COMPOSE_PROJECT_NAME:inherited};
  for (const entry of segmentCalls(segments,process.cwd(),{environment})) {
    const {words,exported} = entry;
    if (!words) continue;
    const call = composeInvocation(words);
    if (!call?.verb && !composeRunner(words,true) && !providerStackRunner(words)) continue;
    const project = call?.project ?? (Object.hasOwn(exported,"COMPOSE_PROJECT_NAME") ? exported.COMPOSE_PROJECT_NAME : inherited);
    if (project === undefined) continue;
    if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error("E2E lane has an unverifiable Compose project");
    projects.add(project);
  }
  if (projects.size > 1) throw new Error("E2E lane names more than one Compose project");
  return [...projects][0];
}

/** Any actual build can replace an existing service tag, including a partial project build. */
export function changesComposeImages(command,args = []) {
  return segmentCalls(invocationSegments(command,args),process.cwd(),{resolveShellCwd:true}).some(({words}) =>
    words && (explicitComposeBuild(words) || (composeRunner(words) && !words.includes("--no-build"))));
}

/** Resolve inputs against the command directory and verify ownership of existing paths. */
function ownedInput(worktree, cwd, file, accepted) {
  const actual = path.resolve(cwd,file);
  if (!accepted.some(name => actual === path.resolve(worktree,name))) return false;
  // A successful local build can never gain caller ownership through a linked manifest or runner.
  return !existsSync(actual) || realpathSync(actual) === path.resolve(realpathSync(worktree),path.relative(worktree,actual));
}

/** Only one unconditional build invocation can certify the caller-owned project's images. */
export function certifiesComposeImages(command,args = [], worktree = process.cwd(), cwd = worktree) {
  const segments = invocationSegments(command,args);
  if (segments.length !== 1) return false;
  const [{words,chdir,chdirPayload,remote,hasSubstitution,background,conditional,scope,controls}] = segments;
  if (chdir || chdirPayload || remote || hasSubstitution || background || conditional || controls?.length || scope && scope !== "root") return false;
  if (explicitComposeBuild(words)) {
    const invocation = composeInvocation(words,cwd);
    if (invocation.clientOverride || !invocation.cwd || invocation.verb === "run" || invocation.projectDirectory || invocation.files.length !== 1) return false;
    if (!ownedInput(worktree,invocation.cwd,invocation.files[0],["e2e/compose.yml","e2e/compose.yaml"])) return false;
    const options = invocation.args;
    // Unknown options or positional service selectors cannot establish whole-project coverage.
    return options.every(arg => ["--build","-d","--detach","--wait","--pull","--no-cache","--with-dependencies","--quiet","-q"].includes(arg));
  }
  if (!composeRunner(words) || words.includes("--no-build")) return false;
  const operation = executable(words,cwd);
  const argv = operation.argv;
  cwd = operation.cwd;
  if (!cwd) return false;
  if (argv[0] === "pnpm") {
    // Prefer conservative invalidation if the selected package does not directly run our foreground build.
    const workspace = operation.workspace;
    const packageDir = workspace ? worktree : cwd;
    if (workspace && path.resolve(cwd) !== path.resolve(worktree)) {
      let dir = path.resolve(cwd);
      while (dir !== path.dirname(dir) && !existsSync(path.join(dir,"pnpm-workspace.yaml"))) dir = path.dirname(dir);
      if (dir !== path.resolve(worktree)) return false;
    }
    const manifest = path.resolve(packageDir,"package.json");
    const relative = path.relative(path.resolve(worktree),manifest);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(manifest) || !ownedInput(worktree,packageDir,"package.json",[relative])) return false;
    try {
      const script = JSON.parse(readFileSync(manifest,"utf8")).scripts?.["e2e:containerized"];
      if (typeof script !== "string") return false;
      const calls = invocationSegments("sh",["-c",script]);
      if (calls.length !== 1 || calls[0].clearEnv || calls[0].unset || Object.keys(calls[0].env).length || !composeRunner(calls[0].words) || executableWords(calls[0].words)[0] === "pnpm") return false;
      return certifiesComposeImages("sh",["-c",script],worktree,packageDir);
    } catch { return false; }
  }
  return ownedInput(worktree,cwd,runnerPath(argv,false),["e2e/run-containerized.sh"]);
}

/** Classify shell-selected lanes and direct argv with the same Compose and Dagger semantics. */
export function containerizedIntent(command, args = [], cwd = process.cwd()) {
  let reuse = false;
  for (const entry of segmentCalls(invocationSegments(command,args),cwd,{resolveShellCwd:true})) {
    if (!entry.words) continue;
    const words = entry.words;
    const [bin,verb,target] = executableWords(words);
    if (path.basename(bin ?? "") === "dagger" && verb === "call" && target === "e-2-e") return "build";
    const compose = composeInvocation(words,entry.cwd);
    if ((entry.uncertainCwd || !compose?.cwd) && compose?.files.some(file=>!path.isAbsolute(file)) && ["up","build","run","start","restart"].includes(compose.verb)) {
      throw new Error("E2E lane has an unverifiable Compose manifest directory");
    }
    if (compose?.manifest && ["up","build","run","start","restart"].includes(compose.verb)) {
      if (explicitComposeBuild(words)) return "build";
      reuse = true;
    }
    if (providerStackRunner(words)) reuse = true;
    if (!composeRunner(words, true)) continue;
    if (!words.includes("--no-build")) return "build";
    reuse = true;
  }
  return reuse ? "reuse" : null;
}

/** Both image builds and image reuse start a shared Compose stack. */
export function isContainerizedStack(command, args = []) { return containerizedIntent(command, args) !== null; }

/** Only an image-building stack needs the disk preflight. */
export function isContainerizedBuild(command, args = []) { return containerizedIntent(command, args) === "build"; }

/** Measure the Docker backing filesystem in integer 1024-byte df blocks. */
export function measureDockerDisk({ home = os.homedir(), run = systemRun, exists = existsSync,
  sameFile = sameInode, docker = process.env.VIBE_E2E_DOCKER || 'docker' } = {}) {
  const root = output(docker, ['info', '--format', '{{.DockerRootDir}}'], run);
  if (!root) throw new Error('Docker root probe is unreadable');
  const endpoint = output(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], run);
  if (!endpoint.startsWith('unix://')) throw new Error('Docker context is nonlocal: ' + endpoint);
  const socketPath = endpoint.slice('unix://'.length);
  let backing;
  const desktopSocket = path.join(home, '.docker', 'run', 'docker.sock');
  if (sameFile(socketPath, desktopSocket)) {
    const socket = path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'backend.sock');
    const settings = capturedJson(output('curl', ['-s', '--unix-socket', socket, 'http://localhost/app/settings'], run));
    backing = settings?.vm?.resources?.dataFolder;
    if (typeof backing !== 'string' || !exists(backing)) throw new Error('Docker Desktop data folder is unreadable');
  } else if (exists(root)) {
    backing = root;
  } else if (exists(home)) {
    // Dory, Colima and OrbStack expose a local Unix socket while DockerRootDir
    // lives inside their VM. The repository's own prepush contract measures
    // the host home filesystem that contains those VM disks.
    backing = home;
  } else {
    throw new Error('Docker context has no verified local backing path: ' + endpoint);
  }
  let diskTable;
  try { diskTable = output('df', ['-Pk', backing], run); }
  catch (error) { throw new Error('Docker free-space probe is unreadable under ' + backing + ': ' + error.message); }
  const lines = diskTable.split(/\r?\n/);
  const available = lines[1]?.trim().split(/\s+/)[3];
  if (!/^[0-9]+$/.test(available ?? '')) {
    throw new Error('Docker free-space probe is unreadable under ' + backing + '; requires 64,000,000,000 bytes');
  }
  const free = BigInt(available) * 1024n;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Docker free-space probe exceeds exact integer range');
  return { path: backing, freeBytes: Number(free), thresholdBytes: Number(MIN_FREE_BYTES) };
}

/** Warn and refuse a verified build below the repo's 64 GB decimal standard. */
export function requireDockerDisk(options = {}) {
  let measured;
  try { measured = measureDockerDisk(options); }
  catch (error) { throw new Error('Docker disk admission unavailable: '
    + String(error instanceof Error ? error.message : error) + '; requires 64,000,000,000 bytes'); }
  if (BigInt(measured.freeBytes) < MIN_FREE_BYTES) {
    throw new Error('Docker build refused: ' + measured.freeBytes + ' bytes free under ' + measured.path
      + '; requires 64,000,000,000 bytes');
  }
  return measured;
}
