import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import picomatch from "picomatch";
import type { ReportExecution } from "./main-sync-report-execution.js";
import { rejectReportReplay } from "./main-sync-report-execution.js";
import { referenceMatches, type InputReference, type NativeReferenceEnvironment } from "./main-sync-input-references.js";
import { isLocalPlanPath } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";

const packageSchema = z.object({ scripts: z.record(z.string()).optional() }).passthrough();
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DYNAMIC = /[$`<>|;]/;
const MODULE = /\.[cm]?[jt]sx?$/;
const NODE_LOADERS = new Set(["tsx/esm", "tsx"]);
const INSTALL_STAGES = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const WORKSPACE_PATTERN = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+(?:\/\*)?$/;
type PnpmOptions = { ignoreScripts?: boolean; ignoreWorkspace?: boolean; prePost?: boolean; observed: Map<string, string> };
type PathConstraint = Extract<InputReference, { kind: "path" }>;
/** Possible runtime locations contain constraints, never a certified directory. */
export type ReportCwd = { kind: "known"; path: string } | { kind: "possible"; suffix: string; constraints?: PathConstraint };
type CwdState = { context: ReportCwd; depth: number };

export type ReportCommandEntry = { file: string; context: ReportCwd; argv: NativeReferenceEnvironment["argv"] };

/** Resolves literal program operands; an unsupported launch shape never becomes an inactivity claim. */
export function reportCommandEntries(execution: ReportExecution): ReportCommandEntry[] {
  const entries = ordinaryEntries(execution.root, execution.argv, { kind: "known", path: execution.cwd });
  for (const task of execution.tasks ?? []) {
    const directory = task.package && workspaceDirectory(execution.root, task.package);
    const name = task.taskId.slice(task.taskId.lastIndexOf("#") + 1);
    if (directory) entries.push(...ordinaryEntries(execution.root, ["pnpm", "run", name], { kind: "known", path: join(execution.root, directory) }));
  }
  return entries;
}

function ordinaryEntries(root: string, argv: readonly string[], context: ReportCwd) {
  try {
    return resolveCommand(root, argv, context, new Set());
  }
  catch (error) {
    if (error instanceof UnsupportedReportSyntax) return [];
    throw error;
  }
}

function resolveCommand(root: string, argv: readonly string[], context: ReportCwd, seen: Set<string>): ReportCommandEntry[] {
  if (seen.size >= 32) throw unresolved("command expansion bound");
  const identity = JSON.stringify([context, argv]);
  if (seen.has(identity)) throw unresolved("recursive script invocation");
  seen = new Set(seen).add(identity);
  const program = argv[0];
  rejectReportReplay(argv.join(" "));
  if (!program) throw unresolved("missing program");
  if (["node", "tsx"].includes(program) || program === process.execPath) return nodeEntry(root, argv, context);
  if (program === "pnpm") return pnpmEntries(root, argv.slice(1), context, seen);
  if (["sh", "bash"].includes(program)) {
    const file = argv[1];
    if (!file || argv.length !== 2 || !file.endsWith(".sh")) throw unresolved("shell program operands");
    return targetFiles(root, file, context, path => path.endsWith(".sh"))
      .map(file => ({ file, context, argv: [...argv] }));
  }
  if (["true", "false", "echo", "printf"].includes(program) || program === "exit" && argv.length === 2 && /^[0-9]+$/.test(argv[1]!)) return [];
  const configs = selectedConfigs(root, argv, context);
  if (configs) return configs;
  // Installed command families are assessed through their actual config/collector owner, not their name alone.
  if (["vitest", "playwright", "tsc", "biome", "prisma", "fumadocs-mdx", "next", "turbo"].includes(program)) {
    throw unresolved(`installed command owner required: ${program}`);
  }
  throw unresolved(`unsupported program: ${program}`);
}

function nodeEntry(root: string, argv: readonly string[], context: ReportCwd): ReportCommandEntry[] {
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const argument = argv[index]!;
    if (argument === "--import") {
      if (!NODE_LOADERS.has(argv[index + 1] ?? "")) throw unresolved("unproved Node loader");
      index += 2;
    } else if (argument === "--input-type=module") index++;
    else throw unresolved("Node option/eval owner required");
  }
  const file = argv[index];
  if (!file || !MODULE.test(file)) throw unresolved("literal Node entry required");
  const paths = targetFiles(root, file, context);
  return paths.map(path => ({ file: path, context,
    argv: [process.execPath, join(root, path), ...argv.slice(index + 1)] }));
}

function pnpmEntries(root: string, args: readonly string[], initialContext: ReportCwd, seen: Set<string>): ReportCommandEntry[] {
  let context = initialContext;
  let selectedDirectory: string | undefined;
  const options: PnpmOptions = { observed: new Map() };
  let index = 0;
  while (args[index]?.startsWith("--") || args[index] === "-C") {
    if (args[index] === "--dir" || args[index] === "-C") {
      const directory = args[index + 1];
      if (!directory) throw unresolved("pnpm directory operand");
      context = reportRelativeCwd(root, context, directory);
      index += 2;
    } else if (args[index] === "--filter") {
      const selected = args[index + 1];
      const directory = selected && workspaceDirectory(root, selected);
      if (!directory) throw unresolved("nonliteral package selector");
      selectedDirectory = join(root, directory);
      index += 2;
    } else {
      const consumed = pnpmOption(args, index, options);
      if (!consumed) {
        const remaining = args.slice(index + 1);
        const native = remaining.findIndex(argument => argument === "install" || argument === "i");
        if (native >= 0 && !remaining.slice(0, native).some(argument => ["run", "exec", "--"].includes(argument))) {
          return possibleInstallEntries(root, context, { observed: new Map() }, seen);
        }
        throw unresolved("actual selected package/filter owner required");
      }
      index += consumed;
    }
  }
  if (args[index] === "install" || args[index] === "i") {
    for (let at = index + 1; at < args.length; at++) {
      const consumed = pnpmOption(args, at, options);
      if (consumed) at += consumed - 1;
    }
    return possibleInstallEntries(root, context, options, seen);
  }
  if (selectedDirectory) {
    context = { kind: "known", path: selectedDirectory };
  }
  if (args[index] === "exec") return resolveCommand(root, args.slice(index + 1), context, seen);
  if (context.kind === "possible") return possibleManifestDirectories(root, context)
    .flatMap(directory => selectedPnpmScript(root, args.slice(index), directory, options, seen, true));
  return selectedPnpmScript(root, args.slice(index), context.path, options, seen);
}

function scriptEntries(root: string, value: string, arguments_: readonly string[], context: ReportCwd,
  seen: Set<string>, state: CwdState = { context, depth: 0 }): ReportCommandEntry[] {
  rejectReportReplay(value);
  const commands = literalStatements(value);
  const result: ReportCommandEntry[] = [];
  for (const [index, statement] of commands.entries()) {
   const effect = cwdEffect(statement);
   const conditional = state.depth > 0 || effect.opens > 0;
   try {
    const words = [...literalCommands(statement)[0]!];
    while (words[0] && ASSIGNMENT.test(words[0])) {
      const assignment = words.shift()!;
      if (assignment.startsWith("PATH=") || assignment.startsWith("NODE_OPTIONS=")) {
        throw unresolved("execution-affecting environment assignment");
      }
    }
    if (words[0] === "cd") {
      if (words.length !== 2) throw unresolved("literal cd operand");
      const target = words[1]!;
      state.context = conditional ? { kind: "possible", suffix: "" } : reportRelativeCwd(root, state.context, target);
      continue;
    }
    if (index === commands.length - 1) words.push(...arguments_);
    result.push(...resolveCommand(root, words, state.context, seen));
   } catch (error) {
     if (!(error instanceof UnsupportedReportSyntax)) throw error;
     if (effect.cd) state.context = { kind: "possible", suffix: "" };
   } finally {
     state.depth = Math.max(0, state.depth + effect.opens - effect.closes);
     if (state.depth > 32) throw unresolved("conditional syntax bound");
   }
  }
  return result;
}

/** Splits only the already supported top-level conjunction, retaining quoted operators as literal words. */
function literalStatements(value: string) {
  if (value.length > 32768) throw unresolved("package command bound");
  const statements: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\") { index++; continue; }
    if (quote) { if (character === quote) quote = ""; }
    else if (character === "'" || character === '"') quote = character;
    else if (character === "&" && value[index + 1] === "&") {
      statements.push(value.slice(start, index));
      start = ++index + 1;
    }
  }
  statements.push(value.slice(start));
  if (statements.length > 128) throw unresolved("package statement bound");
  return statements;
}

/** This is a finite literal package-command grammar, not a shell evaluator. */
function literalCommands(value: string): string[][] {
  if (value.length > 32768 || DYNAMIC.test(value)) throw unresolved("dynamic/unsupported package command");
  const result: string[][] = [[]];
  let token = "";
  let started = false;
  let quote = "";
  const finish = () => {
    if (started) result[result.length - 1]!.push(token);
    token = "";
    started = false;
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\") throw unresolved("escaped package word");
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) finish();
    else if (character === "&" && value[index + 1] === "&") {
      finish();
      if (!result[result.length - 1]!.length) throw unresolved("empty sequential command");
      result.push([]);
      index++;
    } else if (character === "&" || character === "\\") throw unresolved("unsupported package operator");
    else { token += character; started = true; }
  }
  if (quote) throw unresolved("unclosed package quote");
  finish();
  if (result.some(command => !command.length)) throw unresolved("empty package command");
  return result;
}

/** Explicit native loader options reuse literal words, never shell execution or caller-provided argv. */
export function reportLiteralWords(value: string) {
  try {
    const commands = literalCommands(value);
    return commands.length === 1 ? commands[0] : undefined;
  } catch (error) {
    if (error instanceof UnsupportedReportSyntax) return undefined;
    throw error;
  }
}

function ownedFile(root: string, cwd: string, file: string) {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  if (!within(root, absolute) || !existsSync(absolute)) throw unresolved("entry outside/missing from owned execution root");
  return relative(root, absolute);
}

function within(root: string, path: string) { return path === root || path.startsWith(`${root}/`); }
function unresolved(reason: string) {
  return new UnsupportedReportSyntax(reason);
}

/** Unsupported ordinary statements are not report evidence; supported literal statements retain their guards. */
export function reportShellEntries(execution: ReportExecution, file: string, context: ReportCwd) {
  const source = readFileSync(join(execution.root, file), "utf8");
  if (source.length > 65536) throw unresolved("shell owner size");
  const lines = source.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const result: ReportCommandEntry[] = [];
  const state: CwdState = { context, depth: 0 };
  for (const line of lines) {
    if (["set -e", "set -eu", "set -euo pipefail"].includes(line)) continue;
    rejectReportReplay(line);
    try { result.push(...scriptEntries(execution.root, line, [], context, new Set(), state)); }
    catch (error) {
      if (!(error instanceof UnsupportedReportSyntax)) throw error;
    }
  }
  return result;
}

/** Missing ordinary syntax support is not evidence that retained report bytes are consumed. */
class UnsupportedReportSyntax extends Error {}

/** Candidate selection is limited to public committed paths, never the filesystem population. */
function possibleFiles(root: string, file: string, context: Extract<ReportCwd, { kind: "possible" }>, accepts: (path: string) => boolean = path => MODULE.test(path)) {
  if (isAbsolute(file)) return [ownedFile(root, root, file)];
  const reference = context.constraints
    ? { ...context.constraints, value: join(context.constraints.value, context.suffix, file), base: "runtime" as const, possibleOnly: true }
    : { kind: "path" as const, value: join(context.suffix, file), base: "runtime" as const,
      possibleOnly: true, unknownPrefix: false, uncertainTerms: [] };
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0")
    .filter(path => path && accepts(path) && !isLocalPlanPath(path)
      && referenceMatches(root, "", reference, [path]));
  if (files.length > 4096) throw unresolved("possible committed entry bound");
  return files;
}

/** Recognizes conditional syntax and cd receivers without evaluating branches or substitutions. */
function cwdEffect(value: string) {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  const finish = () => { if (token) tokens.push(token); token = ""; };
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; token += "quoted"; }
    else if (character === "\\") { index++; token += "escaped"; }
    else if (/\s/.test(character)) finish();
    else if (";|&{}()".includes(character)) { finish(); tokens.push(";"); }
    else token += character;
  }
  finish();
  let position = true;
  let opens = 0;
  let closes = 0;
  let cd = false;
  for (const word of tokens) {
    if (word === ";") { position = true; continue; }
    if (!position) continue;
    if (["if", "for", "while", "until", "case", "select"].includes(word)) opens++;
    if (["fi", "done", "esac"].includes(word)) closes++;
    if (["then", "do", "else", "elif"].includes(word)) continue;
    if (word === "cd") cd = true;
    position = false;
  }
  return { opens, closes, cd };
}

/** Configuration operands are actual source inputs, not a tool-name safety certificate. */
function selectedConfigs(root: string, argv: readonly string[], context: ReportCwd): ReportCommandEntry[] | undefined {
  const program = argv[0];
  if (!["vitest", "playwright", "tsc"].includes(program ?? "")) return undefined;
  const flags = program === "tsc" ? ["--project", "-p"] : ["--config", "-c"];
  let selected: string | undefined;
  for (const [index, value] of argv.entries()) {
    if (flags.includes(value)) selected = argv[index + 1];
    else for (const flag of flags) if (value.startsWith(`${flag}=`)) selected = value.slice(flag.length + 1);
  }
  const defaults = program === "tsc" ? ["tsconfig.json"] : [`${program}.config.ts`, `${program}.config.mts`, `${program}.config.js`, `${program}.config.mjs`];
  const paths = selected ? [selected] : context.kind === "possible" ? defaults : defaults.filter(file => existsSync(resolve(context.path, file)));
  const files = paths.flatMap(path => targetFiles(root, path, context, candidate => MODULE.test(candidate) || candidate.endsWith(".json")));
  return files.map(file => ({ file, context, argv: [...argv] }));
}

/** Exact package filters and actual Turbo task packages reuse committed manifest identity, not guessed selectors. */
export function workspaceDirectory(root: string, name: string) {
  const files = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", "apps", "packages", "containers"])
    .split("\n").filter(file => /^(?:apps|packages|containers)\/[^/]+\/package\.json$/.test(file));
  const matches = files.filter(file => {
    const data = z.object({ name: z.string().optional() }).passthrough().parse(JSON.parse(readFileSync(join(root, file), "utf8")));
    return data.name === name;
  });
  return matches.length === 1 ? dirname(matches[0]!) : undefined;
}

/** Only actual explicit false options exclude possible lifecycle execution; ambient config never supplies inactivity. */
function pnpmOption(args: readonly string[], index: number, options: PnpmOptions) {
  const argument = args[index] ?? "";
  const [name, encoded] = argument.split("=", 2);
  const key = name === "--ignore-scripts" ? "ignoreScripts" : name === "--ignore-workspace" ? "ignoreWorkspace"
    : name === "--enable-pre-post-scripts" ? "prePost" : undefined;
  if (!key) return ["--frozen-lockfile", "--no-frozen-lockfile", "--prefer-offline", "--recursive-install"].includes(name!) ? 1 : 0;
  const next = args[index + 1];
  const separate = encoded === undefined && (next === "true" || next === "false");
  const value = encoded ?? (separate ? next : "true");
  const previous = options.observed.get(key);
  const known = (value === "true" || value === "false") && (previous === undefined || previous === value);
  options.observed.set(key, known ? value : "unknown");
  options[key] = known ? value === "true" : undefined;
  return separate ? 2 : 1;
}

/** Native install uses each possible committed importer CWD and a separate lockfile-root devPreinstall. */
function installEntries(root: string, cwd: string, options: PnpmOptions, seen: Set<string>) {
  if (options.ignoreScripts === true) return [];
  const workspace = join(root, "pnpm-workspace.yaml");
  const standalone = options.ignoreWorkspace === true || !existsSync(workspace);
  const directories = standalone ? [cwd] : workspaceDirectories(root, workspace);
  const roots = new Set(standalone ? [cwd] : options.ignoreWorkspace === false ? [root] : [root, cwd]);
  const entries: ReportCommandEntry[] = [];
  for (const lockRoot of roots) {
    const scripts = scriptsAt(lockRoot);
    if (scripts["pnpm:devPreinstall"]) entries.push(...supportedScript(root, scripts["pnpm:devPreinstall"], [], lockRoot, seen));
  }
  for (const directory of new Set([...directories, cwd])) {
    const scripts = scriptsAt(directory);
    for (const stage of INSTALL_STAGES) {
      if (scripts[stage]) entries.push(...supportedScript(root, scripts[stage]!, [], directory, seen));
    }
  }
  return entries;
}

function scriptsAt(directory: string) {
  const file = join(directory, "package.json");
  return existsSync(file) ? packageSchema.parse(JSON.parse(readFileSync(file, "utf8"))).scripts ?? {} : {};
}

/** Current finite workspace patterns use tracked manifests; unsupported selection keeps the bounded possible set. */
function workspaceDirectories(root: string, workspace: string) {
  const files = git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
    .filter(file => file.endsWith("/package.json") || file === "package.json");
  if (files.length > 4096) throw unresolved("workspace manifest bound");
  const config = z.object({ packages: z.array(z.string()).optional() }).passthrough().parse(parse(readFileSync(workspace, "utf8")));
  const patterns = config.packages ?? [];
  const finite = config.packages !== undefined && patterns.every(pattern => WORKSPACE_PATTERN.test(pattern));
  const matches = finite ? picomatch(patterns, { dot: true }) : undefined;
  return files.filter(file => file === "package.json" || !matches || matches(dirname(file))).map(file => join(root, dirname(file)));
}

function supportedScript(root: string, value: string, args: readonly string[], cwd: string, seen: Set<string>) {
  try { return scriptEntries(root, value, args, { kind: "known", path: cwd }, seen); }
  catch (error) {
    if (error instanceof UnsupportedReportSyntax) return [];
    throw error;
  }
}

/** The selected manifest makes script CWD concrete; unknown launch directories never supply a guessed root. */
function possibleManifestDirectories(root: string, context: Extract<ReportCwd, { kind: "possible" }>) {
  return possibleFiles(root, "package.json", context, path => path === "package.json" || path.endsWith("/package.json"))
    .map(file => join(root, dirname(file)));
}

/** Native install keeps each possible importer and the existing lockfile-root lifecycle contract. */
function possibleInstallEntries(root: string, context: ReportCwd, options: PnpmOptions, seen: Set<string>) {
  const directories = context.kind === "possible" ? possibleManifestDirectories(root, context) : [context.path];
  return directories.flatMap(directory => installEntries(root, directory, options, seen));
}

/** Possible manifests without the selected script cannot erase another manifest's selected consumer. */
function selectedPnpmScript(root: string, args: readonly string[], cwd: string, options: PnpmOptions,
  seen: Set<string>, possible = false) {
  const index = args[0] === "run" ? 1 : 0;
  const script = args[index];
  if (!script) throw unresolved("pnpm script operand");
  const scripts = scriptsAt(cwd);
  const value = Object.hasOwn(scripts, script) ? scripts[script] : undefined;
  if (!value) {
    if (possible) return [];
    throw unresolved(`selected script missing: ${script}`);
  }
  const result: ReportCommandEntry[] = [];
  if (options.prePost !== false && scripts[`pre${script}`] && !value.includes(`pre${script}`)) {
    result.push(...supportedScript(root, scripts[`pre${script}`]!, [], cwd, seen));
  }
  result.push(...supportedScript(root, value, args.slice(index + 1), cwd, seen));
  if (options.prePost !== false && scripts[`post${script}`] && !value.includes(`post${script}`)) {
    result.push(...supportedScript(root, scripts[`post${script}`]!, [], cwd, seen));
  }
  return result;
}

/** Native children must supply their actual derived context, never the fixed operation's fallback. */
export function reportChildEntries(execution: ReportExecution, argv: readonly string[], context: ReportCwd) {
  return ordinaryEntries(execution.root, argv, context);
}

/** An absolute selected file does not make the runtime directory known. */
function targetFiles(root: string, target: string, context: ReportCwd, accepts: (path: string) => boolean = path => MODULE.test(path)) {
  return context.kind === "known" ? [ownedFile(root, context.path, target)] : possibleFiles(root, target, context, accepts);
}

/** Only an actual absolute directory reset can resolve a possible context. */
export function reportRelativeCwd(root: string, context: ReportCwd, target: string): ReportCwd {
  if (isAbsolute(target)) {
    const path = resolve(target);
    if (!within(root, path)) throw unresolved("execution cwd outside owned root");
    return { kind: "known", path };
  }
  if (context.kind === "known") {
    const path = resolve(context.path, target);
    if (!within(root, path)) throw unresolved("execution cwd outside owned root");
    return { kind: "known", path };
  }
  return { ...context, suffix: join(context.suffix, target) };
}

/** Explicit loaders reuse the same bounded target selection and retain the child runtime context. */
export function reportLoaderEntries(execution: ReportExecution, importer: string, target: string | PathConstraint, context: ReportCwd): ReportCommandEntry[] {
  let files: string[];
  if (typeof target === "string") files = targetFiles(execution.root, target, context);
  else {
    files = git(execution.root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
      .filter(file => MODULE.test(file) && !isLocalPlanPath(file)
        && referenceMatches(execution.root, importer, target, [file]));
    if (files.length > 4096) throw unresolved("possible committed loader bound");
  }
  return files.map(file => ({ file, context, argv: [] }));
}
