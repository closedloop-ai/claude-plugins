import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalEvalReport, codexCaseId, collectClaudeEval, collectCodexEval,
  finalizeLocalEval } from "./eval-collector.ts";
import type { EvalRuntimeRecord, EvalSuiteResult, ExpectedEvalPlugin,
  LocalEvalResult } from "./eval-collector.ts";
import { EVAL_POLICY, requireDeveloperMachine } from "./eval-policy.ts";
import type { EvalRuntime } from "./eval-policy.ts";
import { snapshotPluginsAtHead, snapshotPluginsAtWorktree } from "./plugin-snapshot.ts";
import { buildEvalBaseline, evalBaselineFileName, evalBaselineModelsMatchPolicy, publishEvalBaseline,
  evalQuarantineEntryIsActive, evalQuarantineStatus, reconcileEvalBaselineQuarantine,
  resolveLastGreenEvalBaseline,
  resolveLatestEvalBaseline } from "./eval-baseline.ts";
import type { EvalBaselineArtifact, EvalQuarantineEntry } from "./eval-baseline.ts";
import { evalCaseCatalog } from "./eval-selection.ts";
import type { EvalCaseDefinition } from "./eval-selection.ts";
import { classifyVibeChangeScopeBetween } from "./vibe-change-scope.ts";
import { isRetrySafeSlackFailure, KEPT_SANDBOX_LINE_PREFIX, nightlyChangesSince,
  SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { NightlyRegressionCase, NightlyRegressionReporter } from "./eval-slack.ts";
import { runOwnedProcess } from "./owned-process.ts";
import { mergeEvalSuiteResults, statefulInfrastructureInvalidReason,
  SystemUpgradeResumeRunner } from "./upgrade-resume-eval.ts";
import type { UpgradeResumeRunner } from "./upgrade-resume-eval.ts";
import { createClaudeEvalIsolation } from "./eval-claude-isolation.ts";
import { privateReplyDestination, privateTextProblem, writePrivateReply } from "./private-artifact.ts";
import { applyClaudeReplyCheckers, deterministicClaudeRecord,
  hasMappedReplyCheckers } from "./reply-checker.ts";

/** Explicit inputs for a local-only dual-runtime model eval. */
export interface LocalEvalOptions {
  repo: string;
  pluginSha: string;
  runRoot: string;
  outputDir: string;
  claudeExecutable: string;
  codexExecutable: string;
  uvExecutable: string;
  selectedCases?: string[];
  deterministicOnly?: boolean;
  snapshotMode?: "head" | "worktree";
  runtimes?: EvalRuntime[];
  concurrency?: number;
  deadline?: number;
  signal?: AbortSignal;
  statefulRunner?: UpgradeResumeRunner;
  statefulTargetRef?: string;
  /** Told what became of the Claude process's kept sandboxes, also when the run then throws. */
  onClaudeKeptFolders?: (kept: ClaudeKeptFolders) => void;
}

/** Process boundary injected by tests so no model command is launched there. */
export interface EvalCommands {
  readonly localModelExecution: boolean;
  readonly providesClaudeTraceArtifacts: boolean;
  /** The user a kept sandbox must belong to; the running process's user when absent. */
  readonly sandboxOwnerUid?: number;
  run(command: string, args: string[], cwd: string, options: {
    deadline: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ status: number; stdout: string; stderr: string }>;
}

/** Give model and grader processes only the documented local-runtime environment. */
export function evalModelProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forbidden = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  const present = forbidden.find((name) => env[name]?.trim());
  if (present) throw new Error(`eval-model-api-credential-forbidden:${present}`);
  const allowed = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "SHELL",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  return Object.fromEntries(allowed.flatMap((name) => env[name] === undefined
    ? [] : [[name, env[name]]])) as NodeJS.ProcessEnv;
}

class SystemEvalCommands implements EvalCommands {
  readonly localModelExecution = true;
  readonly providesClaudeTraceArtifacts = true;
  async run(command: string, args: string[], cwd: string, options: {
    deadline: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const onSignal = () => abort.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const result = await runOwnedProcess(command, args, { cwd, deadline: options.deadline,
        signal: abort.signal, maxBuffer: 16 * 1024 * 1024,
        env: { ...evalModelProcessEnv(), ...options.env } });
      return { status: result.exitCode ?? 128, stdout: result.stdout, stderr: result.stderr };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

function json(path: string): unknown {
  if (!existsSync(path)) throw new Error("eval-native-artifact-missing");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("eval-native-artifact-malformed"); }
}

function nativeObject(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(reason);
  return Object.fromEntries(Object.entries(value));
}

function nativeArray(value: unknown, reason: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(reason);
  return value;
}

function stableReason(error: unknown, runtime: "claude" | "codex"): string {
  const message = error instanceof Error ? error.message : "";
  return /^eval-[a-z0-9:-]+$/.test(message) ? message : `eval-${runtime}-artifact-invalid`;
}

function manifestVersion(pluginDir: string): string {
  const manifest = nativeObject(JSON.parse(readFileSync(
    join(pluginDir, ".claude-plugin/plugin.json"), "utf8")), "eval-plugin-manifest-invalid");
  if (typeof manifest.version !== "string") throw new Error("eval-plugin-version-invalid");
  return manifest.version;
}

/** What became of the sandbox folders one finished Claude eval process said it kept. */
interface ClaudeKeptFolders {
  /** Kept folders the process reported. */
  reported: number;
  /** Reported folders this run proved its own and removed. */
  removed: number;
  /** Proven folders that could not be removed. A folder the run cannot prove is never named. */
  remaining: string[];
}

// The Claude eval process prints one notice per kept sandbox on stderr. On
// macOS it creates the sandbox under /tmp whatever TMPDIR says, so the run's
// own temp folder cannot be the only accepted parent.
const CLAUDE_KEPT_NOTICE = /^\u26A0 kept (\/[^\s:]+): /;

/**
 * Whether a folder name is one the Claude eval process gives its sandbox on
 * this platform: e-<id> on macOS and claude-eval-<id> elsewhere, the id being
 * the six characters a temp folder gets.
 */
export function isClaudeSandboxName(name: string,
  platform: NodeJS.Platform = process.platform): boolean {
  return (platform === "darwin" ? /^e-[a-zA-Z0-9]{6}$/ : /^claude-eval-[a-zA-Z0-9]{6}$/).test(name);
}

function sumClaudeKeptFolders(runs: readonly ClaudeKeptFolders[]): ClaudeKeptFolders {
  return {
    reported: runs.reduce((sum, item) => sum + item.reported, 0),
    removed: runs.reduce((sum, item) => sum + item.removed, 0),
    remaining: runs.flatMap((item) => item.remaining),
  };
}

/** Scheduler log lines for one nightly's kept sandboxes. Only proven folders are named. */
export function keptSandboxLogLines(kept: ClaudeKeptFolders): string[] {
  return [
    `${KEPT_SANDBOX_LINE_PREFIX}SANDBOXES runtime=claude reported=${kept.reported} ` +
      `removed=${kept.removed} remaining=${kept.remaining.length}`,
    ...kept.remaining.map((path) => `${KEPT_SANDBOX_LINE_PREFIX}SANDBOX_REMAINING path=${path}`),
  ];
}

function createdMs(stat: Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
}

/** List the kept sandbox paths a Claude eval process reported, exactly as printed. */
function reportedClaudeKeptRoots(stderr: string): string[] {
  return [...new Set(stderr.split(/\r?\n/).flatMap((line) => {
    const root = CLAUDE_KEPT_NOTICE.exec(line)?.[1];
    return root ? [root] : [];
  }))];
}

/**
 * Keep only the reported sandboxes this run can prove are its own.
 *
 * A printed line proves nothing alone. The folder must also be a real
 * directory at its canonical path, carry a sandbox name, belong to this user
 * and be no older than the temp folder this run made before the launch.
 */
function provenClaudeKeptRoots(stderr: string, createdNotBeforeMs: number,
  uid: number | undefined): string[] {
  if (uid === undefined) return [];
  return reportedClaudeKeptRoots(stderr).filter((root) => {
    try {
      const stat = lstatSync(root);
      return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(root) === root &&
        isClaudeSandboxName(basename(root)) && stat.uid === uid &&
        createdMs(stat) >= createdNotBeforeMs;
    } catch { return false; }
  });
}

function isRealDirectoryWithin(path: string, provenRoot: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const canonical = realpathSync(path);
  return canonical === provenRoot || canonical.startsWith(`${provenRoot}${sep}`);
}

/** Give the owner access to the real directories of one proven sandbox, never through a link. */
function restoreOwnerAccess(path: string, provenRoot: string): void {
  if (!isRealDirectoryWithin(path, provenRoot)) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) restoreOwnerAccess(join(path, entry), provenRoot);
}

/** Remove the proven sandboxes; report the proven ones that are still there. */
function removeClaudeKeptRoots(stderr: string, createdNotBeforeMs: number,
  uid: number | undefined): ClaudeKeptFolders {
  const reported = reportedClaudeKeptRoots(stderr);
  const proven = provenClaudeKeptRoots(stderr, createdNotBeforeMs, uid);
  for (const root of proven) {
    try {
      // The process leaves the folder read-only and its sealed tree unreadable.
      // Removal unlinks a link it meets; it never descends through one.
      restoreOwnerAccess(root, root);
      rmSync(root, { recursive: true, force: true });
    } catch { /* still there, so listed as remaining */ }
  }
  const remaining = proven.filter((root) => {
    try { lstatSync(root); return true; }
    catch { return false; }
  });
  return { reported: reported.length, removed: proven.length - remaining.length, remaining };
}

function traceIsUnderRunTemp(tracePath: string, canonicalTrace: string,
  allowedTempParent: string): boolean {
  const outputDir = dirname(canonicalTrace);
  const tempRoot = dirname(outputDir);
  return !lstatSync(tracePath).isSymbolicLink() && basename(canonicalTrace) === "trace.jsonl" &&
    basename(outputDir) === "out" && /^e-[a-zA-Z0-9_-]+$/.test(basename(tempRoot)) &&
    realpathSync(dirname(tempRoot)) === realpathSync(allowedTempParent);
}

function traceIsUnderKeptRoot(tracePath: string, canonicalTrace: string,
  provenKeptRoots: readonly string[]): boolean {
  if (canonicalTrace !== tracePath ||
      !provenKeptRoots.some((root) => tracePath === join(root, "out", "trace.jsonl"))) return false;
  const outputStat = lstatSync(dirname(tracePath));
  const traceStat = lstatSync(tracePath);
  return outputStat.isDirectory() && !outputStat.isSymbolicLink() &&
    traceStat.isFile() && !traceStat.isSymbolicLink();
}

function claudeReplyText(tracePath: string, allowedTempParent: string,
  provenKeptRoots: readonly string[] = []): string {
  const canonicalTrace = realpathSync(tracePath);
  if (!traceIsUnderRunTemp(tracePath, canonicalTrace, allowedTempParent) &&
      !traceIsUnderKeptRoot(tracePath, canonicalTrace, provenKeptRoots)) {
    throw new Error("eval-claude-reply-trace-path-invalid");
  }
  let reply = "";
  for (const line of readFileSync(canonicalTrace, "utf8").split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = nativeObject(JSON.parse(line), "eval-claude-reply-trace-invalid"); }
    catch { throw new Error("eval-claude-reply-trace-invalid"); }
    if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
      reply = event.result;
      continue;
    }
    if (event.type !== "assistant") continue;
    const message = nativeObject(event.message, "eval-claude-reply-trace-invalid");
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.flatMap((block) => {
      const item = nativeObject(block, "eval-claude-reply-trace-invalid");
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("\n");
    if (text.trim()) reply = text;
  }
  if (!reply.trim()) throw new Error("eval-claude-reply-missing");
  return reply;
}

/** Materialize every validated Claude final reply in the same private case shape as Codex. */
export function preserveClaudeReplies(raw: unknown, outputDir: string,
  expectedCases: string[], allowedTempParent: string,
  provenKeptRoots: readonly string[] = []): Map<string, string> {
  const root = nativeObject(raw, "eval-claude-json-invalid");
  const cases = nativeArray(root.cases, "eval-claude-cases-invalid");
  const actual = cases.map((rawCase) => {
    const item = nativeObject(rawCase, "eval-claude-case-invalid");
    if (typeof item.name !== "string") throw new Error("eval-claude-case-invalid");
    return item.name;
  });
  if (new Set(actual).size !== actual.length || actual.slice().sort().join("\0") !==
      expectedCases.slice().sort().join("\0")) throw new Error("eval-claude-reply-coverage-mismatch");
  const replies = cases.map((rawCase) => {
    const item = nativeObject(rawCase, "eval-claude-case-invalid");
    const arms = nativeObject(item.arms, "eval-claude-arms-invalid");
    const runs = nativeArray(arms.with, "eval-claude-runs-invalid");
    if (runs.length !== 1) throw new Error("eval-claude-runs-invalid");
    const run = nativeObject(runs[0], "eval-claude-run-invalid");
    if (typeof run.tracePath !== "string") throw new Error("eval-claude-reply-trace-missing");
    if (typeof item.name !== "string") throw new Error("eval-claude-case-invalid");
    const caseId = codexCaseId(item.name);
    const reply = claudeReplyText(run.tracePath, allowedTempParent, provenKeptRoots);
    if (privateTextProblem(reply)) throw new Error("eval-private-reply-private-data");
    return { caseId: item.name,
      destination: privateReplyDestination(outputDir, caseId), reply };
  });
  for (const item of replies) {
    writePrivateReply(item.destination, item.reply);
  }
  return new Map(replies.map((item) => [item.caseId, item.reply]));
}

/** Require T2 to measure one exact clean main commit. */
export function requireCleanT2Snapshot(repo: string, pluginSha: string): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const status = git("status", "--porcelain");
  const head = git("rev-parse", "HEAD^{commit}");
  const branch = git("branch", "--show-current");
  const upstream = git("rev-parse", "origin/main^{commit}");
  const ancestry = git("merge-base", "--is-ancestor", "origin/main", pluginSha);
  const nightlyInvalid = branch.stdout.trim() !== "main" || upstream.stdout.trim() !== pluginSha;
  if (![status, head, branch, upstream].every((result) => result.status === 0) || ancestry.status !== 0 ||
      status.stdout.trim() || head.stdout.trim() !== pluginSha || nightlyInvalid) {
    throw new Error("eval-t2-main-snapshot-invalid");
  }
}

/** Discover every ordinary and stateful case once from the immutable snapshot. */
export function evalCaseIds(vibeDir: string): string[] {
  const ids = evalCaseCatalog(vibeDir).map((item) => item.id);
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("eval-case-manifest-invalid");
  return ids;
}

/** Keep prompt-backed native suites and stateful upgrade cases on their owning runners. */
export function partitionEvalCases(catalog: EvalCaseDefinition[], selected: string[]): {
  ordinary: string[];
  stateful: EvalCaseDefinition[];
} {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  if (new Set(selected).size !== selected.length || selected.some((id) => !byId.has(id))) {
    throw new Error("eval-case-selection-invalid");
  }
  const stateful = selected.flatMap((id) => {
    const item = byId.get(id)!;
    return item.kind === "upgrade-resume" ? [item] : [];
  });
  return { ordinary: selected.filter((id) => byId.get(id)?.kind !== "upgrade-resume"), stateful };
}

function wordingCaseIds(vibeDir: string, selected: string[]): string[] {
  return selected.filter((id) => ["plain-language.md", "plain-ready-message.md"].some((grader) =>
    existsSync(join(vibeDir, "evals", id, "graders", grader))));
}

/**
 * Use the driver revision's Codex adapter while evaluating an older subject
 * snapshot. A T2 baseline necessarily targets the pre-merge main tree, whose
 * adapter may not understand the current evidence contract yet.
 */
export function codexEvalRunnerPath(): string {
  return fileURLToPath(new URL("../../../plugins/vibe/evals/codex/run.py", import.meta.url));
}

/** Give a Codex corpus at least 90 seconds per case and a 30 minute floor. */
export function codexEvalBudgetSeconds(caseCount: number): number {
  if (!Number.isInteger(caseCount) || caseCount <= 0) throw new Error("eval-case-count-invalid");
  return Math.max(1800, caseCount * 90);
}

/**
 * A plugin and every plugin it depends on, transitively, read from the
 * manifests under one plugins folder. Each plugin is visited once, so a
 * dependency cycle ends; a dependency the folder lacks is refused.
 */
function evalPluginClosure(pluginsRoot: string, plugin: string): ExpectedEvalPlugin[] {
  const closure = new Map<string, ExpectedEvalPlugin>();
  const pending = [plugin];
  while (pending.length) {
    const name = pending.shift()!;
    if (closure.has(name)) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("eval-plugin-dependency-invalid");
    const manifestFile = join(pluginsRoot, name, ".claude-plugin", "plugin.json");
    if (!existsSync(manifestFile)) throw new Error("eval-plugin-dependency-missing");
    let manifest: Record<string, unknown>;
    try { manifest = nativeObject(JSON.parse(readFileSync(manifestFile, "utf8")), "eval-plugin-manifest-invalid"); }
    catch { throw new Error("eval-plugin-manifest-invalid"); }
    if (manifest.name !== name || typeof manifest.version !== "string") {
      throw new Error("eval-plugin-manifest-invalid");
    }
    const dependencies = manifest.dependencies === undefined ? []
      : nativeArray(manifest.dependencies, "eval-plugin-dependency-invalid");
    closure.set(name, { name, version: manifest.version,
      path: realpathSync(join(pluginsRoot, name)) });
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") throw new Error("eval-plugin-dependency-invalid");
      pending.push(dependency);
    }
  }
  return [...closure.values()];
}

const CASE_PLUGINS_LINE = /^plugins:[ \t]*(.*)$/;

/**
 * Give one staged case manifest every plugin of the closure it does not list.
 *
 * The Claude eval process loads exactly the plugin folders a case's front
 * matter lists, so a dependency missing there is an unmet dependency. A case
 * without a plugins list is left as it is; the collector then refuses the
 * suite unless the loaded set is the whole closure.
 */
function addClosureToStagedCase(caseDir: string, closureDirs: () => string[]): void {
  const file = join(caseDir, "prompt.md");
  const lines = readFileSync(file, "utf8").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return;
  const at = lines.slice(1, end).flatMap((line, index) => CASE_PLUGINS_LINE.test(line) ? [index + 1] : []);
  if (at.length === 0) return;
  if (at.length > 1) throw new Error("eval-focused-case-plugins-invalid");
  let listed: unknown;
  try { listed = JSON.parse(CASE_PLUGINS_LINE.exec(lines[at[0]!]!)![1]!); }
  catch { throw new Error("eval-focused-case-plugins-invalid"); }
  if (!Array.isArray(listed) || listed.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("eval-focused-case-plugins-invalid");
  }
  const entries = listed as string[];
  const present = new Set(entries.map((entry) => resolve(caseDir, entry)));
  for (const dir of closureDirs()) {
    if (!present.has(resolve(dir))) entries.push(relative(caseDir, dir));
  }
  lines[at[0]!] = `plugins: [${entries.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  writeFileSync(file, lines.join("\n"));
}

/**
 * Copy a focused Claude corpus into the run-owned plugin snapshot.
 *
 * Claude Code accepts only one case glob and does not expand brace unions, so
 * a copied suite is the only exact multi-case selection that also preserves
 * each case's relative sibling-plugin paths and shared fixture directory.
 * Each staged case manifest also lists every plugin vibe depends on,
 * transitively; the source manifests are never changed.
 */
export function stageFocusedClaudeEvalCases(vibeDir: string, selectedCases: string[]): string {
  if (selectedCases.length === 0) return "vibe/evals";
  const focused = join(vibeDir, "evals-focused");
  if (existsSync(focused)) throw new Error("eval-focused-suite-exists");
  mkdirSync(focused);
  const shared = join(vibeDir, "evals", "shared");
  if (existsSync(shared)) {
    cpSync(shared, join(focused, "shared"), { recursive: true, errorOnExist: true, force: false });
  }
  // Read only when a staged case lists plugins, from the same plugins folder those entries name.
  let closure: string[] | null = null;
  const closureDirs = () => closure ??= evalPluginClosure(dirname(vibeDir), basename(vibeDir))
    .map((plugin) => join(dirname(vibeDir), plugin.name));
  for (const id of [...selectedCases].sort()) {
    const source = join(vibeDir, "evals", id);
    if (!existsSync(join(source, "prompt.md"))) throw new Error("eval-focused-case-missing");
    cpSync(source, join(focused, id), { recursive: true, errorOnExist: true, force: false });
    addClosureToStagedCase(join(focused, id), closureDirs);
  }
  return "vibe/evals-focused";
}

async function version(commands: EvalCommands, executable: string, cwd: string, runtime: string,
  deadline: number, signal?: AbortSignal): Promise<string> {
  const result = await commands.run(executable, ["--version"], cwd, { deadline, signal });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`eval-${runtime}-version-unavailable`);
  return result.stdout.trim();
}

function record(runtime: "claude" | "codex", exitCode: number,
  collect: () => EvalSuiteResult): EvalRuntimeRecord {
  try {
    const result = collect();
    const expectedExit = result.failed === 0 ? 0 : 1;
    if (exitCode !== expectedExit) {
      return { runtime, exitCode, result: null, invalidReason: "eval-runtime-exit-mismatch" };
    }
    return { runtime, exitCode, result, invalidReason: null };
  } catch (error) {
    return { runtime, exitCode, result: null, invalidReason: stableReason(error, runtime) };
  }
}

function writeProcessLog(path: string, result: { status: number; stdout: string; stderr: string }): void {
  writeFileSync(path, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`,
    { flag: "wx", mode: 0o600 });
}

/** Run the native suites against one snapshot and preserve a hashed combined result. */
export async function runLocalEvals(options: LocalEvalOptions,
  commands: EvalCommands = new SystemEvalCommands()): Promise<{
    result: LocalEvalResult; jsonFile: string; reportFile: string;
    claudeKeptFolders: ClaudeKeptFolders;
  }> {
  if (commands.localModelExecution) requireDeveloperMachine();
  if (existsSync(options.runRoot)) throw new Error("eval-run-root-exists");
  mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const deadline = options.deadline ?? started + 3 * 60 * 60_000;
  if (deadline <= started) throw new Error("eval-run-budget-exhausted");
  const snapshot = options.snapshotMode === "worktree"
    ? snapshotPluginsAtWorktree(options.repo, options.pluginSha, options.runRoot)
    : snapshotPluginsAtHead(options.repo, options.pluginSha, options.runRoot);
  const catalog = evalCaseCatalog(snapshot.vibeDir);
  const available = catalog.map((item) => item.id);
  const selected = options.selectedCases?.length ? [...options.selectedCases].sort() : available;
  if (new Set(selected).size !== selected.length || selected.some((id) => !available.includes(id))) {
    throw new Error("eval-case-selection-invalid");
  }
  const partition = partitionEvalCases(catalog, selected);
  const runtimes = options.runtimes ?? ["claude", "codex"];
  if (!runtimes.length || new Set(runtimes).size !== runtimes.length ||
      runtimes.some((runtime) => runtime !== "claude" && runtime !== "codex")) {
    throw new Error("eval-runtime-selection-invalid");
  }
  const claudeVersionFull = runtimes.includes("claude")
    ? await version(commands, options.claudeExecutable, options.runRoot, "claude", deadline, options.signal) : null;
  const claudeVersion = claudeVersionFull?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (runtimes.includes("claude") && !claudeVersion) throw new Error("eval-claude-version-invalid");
  const isolatedClaude = runtimes.includes("claude")
    ? createClaudeEvalIsolation(options.runRoot, options.claudeExecutable, []) : null;
  const codexVersion = runtimes.includes("codex")
    ? await version(commands, options.codexExecutable, options.runRoot, "codex", deadline, options.signal) : null;
  const claudeOutput = join(options.runRoot, "claude");
  const claudeTemp = join(options.runRoot, "claude-temp");
  const codexOutput = join(options.runRoot, "codex");
  const sandboxOwnerUid = commands.sandboxOwnerUid ?? process.getuid?.();
  // Made before the launch, so no sandbox of this run can be older than it.
  let claudeSandboxFloorMs = Number.POSITIVE_INFINITY;
  let claudeKeptFolders: ClaudeKeptFolders = { reported: 0, removed: 0, remaining: [] };
  if (runtimes.includes("claude") && partition.ordinary.length) {
    mkdirSync(claudeOutput);
    mkdirSync(claudeTemp, { mode: 0o700 });
    claudeSandboxFloorMs = createdMs(lstatSync(claudeTemp));
  }
  const claudeJson = join(claudeOutput, "result.json");
  const claudeEvalDir = runtimes.includes("claude") && partition.ordinary.length
    ? stageFocusedClaudeEvalCases(snapshot.vibeDir, partition.ordinary) : null;
  // The exact plugin set the staged suite must load: vibe and its dependency closure.
  const claudePlugins = claudeEvalDir ? evalPluginClosure(dirname(snapshot.vibeDir), "vibe") : [];
  // The staged case manifests load vibe and its dependency closure, all
  // siblings in the snapshot's one plugins folder. That folder is the
  // containment root while selecting vibe's suite.
  const concurrency = options.concurrency ?? EVAL_POLICY.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("eval-concurrency-invalid");
  }
  const claudeArgs = ["plugin", "eval", dirname(snapshot.vibeDir), "--eval-dir", claudeEvalDir ?? "",
    "--json", claudeJson,
    "--output-dir", claudeOutput, "--ablation", "none", "--model", EVAL_POLICY.claudeModel,
    "--judge-model", EVAL_POLICY.claudeJudgeModel,
    "--runs", "1", "--threshold", "1", "--concurrency", String(concurrency), "--scaffold",
    // The operator grant only unlocks gated tools that each case also declares.
    "--allow-tools", "Bash", "Write", "Edit", "--trust-plugin", "--no-publish", "--keep-temp"];
  // The native runner documents these isolated Python dependencies. Provision
  // them through uv instead of relying on the developer's system Python.
  const codexArgs = ["run", "--with", "Pillow==12.3.0", "--with", "PyYAML", "python",
    codexEvalRunnerPath(), "--plugin", snapshot.vibeDir,
    "--source-sha", options.pluginSha, "--output", codexOutput, "--codex-bin",
    options.codexExecutable, "--concurrency", String(EVAL_POLICY.codexConcurrency), "--max-seconds",
    String(codexEvalBudgetSeconds(Math.max(1, partition.ordinary.length))), "--model", EVAL_POLICY.codexModel,
    "--grader-model", EVAL_POLICY.codexJudgeModel];
  if (options.deterministicOnly) codexArgs.push("--deterministic-only");
  for (const id of partition.ordinary) codexArgs.push("--case", codexCaseId(id));
  const vibeVersion = manifestVersion(snapshot.vibeDir);
  const coreVersion = manifestVersion(snapshot.coreDir);
  const wordingCases = wordingCaseIds(snapshot.vibeDir, partition.ordinary);
  const skillSha = createHash("sha256").update(
    readFileSync(join(snapshot.vibeDir, "skills/vibe/SKILL.md"))).digest("hex");
  const ordinaryRecords: EvalRuntimeRecord[] = [];
  let claudeProcess: { status: number; stdout: string; stderr: string } | null = null;
  let codexProcess: { status: number; stdout: string; stderr: string } | null = null;
  const siblings = new AbortController();
  const forwardAbort = () => siblings.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) siblings.abort();
  try {
    const launches = [
      runtimes.includes("claude") && partition.ordinary.length
        ? commands.run(isolatedClaude!.executable, claudeArgs, options.runRoot,
          { deadline, signal: siblings.signal,
            env: { TMPDIR: claudeTemp, TMP: claudeTemp, TEMP: claudeTemp } }) : Promise.resolve(null),
      runtimes.includes("codex") && partition.ordinary.length
        ? commands.run(options.uvExecutable, codexArgs, options.runRoot,
          { deadline, signal: siblings.signal }) : Promise.resolve(null),
    ].map((launch) => launch.catch((error: unknown) => {
      siblings.abort();
      throw error;
    }));
    const settled = await Promise.allSettled(launches);
    // A process that finished keeps its result when its sibling was rejected,
    // so the cleanup below still removes and counts the sandboxes it kept.
    [claudeProcess, codexProcess] = settled.map((item) =>
      item.status === "fulfilled" ? item.value : null);
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failure) throw failure.reason;
    if (claudeProcess) writeProcessLog(join(options.runRoot, "claude-process.log"), claudeProcess);
    if (codexProcess) writeProcessLog(join(options.runRoot, "codex-process.log"), codexProcess);
    if (claudeProcess && claudeVersion) {
      let claudeNative: unknown;
      const expected = {
        version: vibeVersion, coreVersion, cliVersion: claudeVersion,
        vibePath: snapshot.vibeDir, corePath: snapshot.coreDir,
        model: EVAL_POLICY.claudeModel, runs: 1, plugins: claudePlugins,
      };
      const nativeRecord = record("claude", claudeProcess.status, () => {
        claudeNative = json(claudeJson);
        return collectClaudeEval(claudeNative, partition.ordinary, expected);
      });
      if (nativeRecord.invalidReason || !nativeRecord.result) {
        ordinaryRecords.push(nativeRecord);
      } else {
        try {
          const mapped = hasMappedReplyCheckers(partition.ordinary);
          const replies = commands.providesClaudeTraceArtifacts || mapped
            ? preserveClaudeReplies(claudeNative, claudeOutput, partition.ordinary, claudeTemp,
              provenClaudeKeptRoots(claudeProcess.stderr, claudeSandboxFloorMs, sandboxOwnerUid))
            : new Map<string, string>();
          if (!mapped) {
            ordinaryRecords.push(nativeRecord);
          } else {
            const overridden = applyClaudeReplyCheckers(claudeNative, partition.ordinary, replies);
            const semantic = collectClaudeEval(overridden.raw, partition.ordinary, expected);
            ordinaryRecords.push(deterministicClaudeRecord(nativeRecord, semantic, overridden));
          }
        } catch (error) {
          ordinaryRecords.push({ runtime: "claude", exitCode: claudeProcess.status, result: null,
            invalidReason: stableReason(error, "claude") });
        }
      }
    }
    if (codexProcess && codexVersion) ordinaryRecords.push(record("codex", codexProcess.status,
      () => collectCodexEval(json(join(codexOutput, "results.json")), partition.ordinary, {
        sourceSha: options.pluginSha, skillSha, version: vibeVersion, cliVersion: codexVersion,
        vibePath: snapshot.vibeDir, deterministicOnly: options.deterministicOnly ?? false,
        model: EVAL_POLICY.codexModel, graderModel: EVAL_POLICY.codexJudgeModel, wordingCases,
      })));
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    // The Python runner also removes this copy in its finally block. The
    // parent independently removes it so an interrupt cannot retain a credential file.
    rmSync(join(codexOutput, "home/auth.json"), { force: true });
    rmSync(claudeTemp, { recursive: true, force: true });
    // Only folders this run's own process reported and this run can prove,
    // never a sweep of the shared temp parent.
    claudeKeptFolders = removeClaudeKeptRoots(claudeProcess?.stderr ?? "", claudeSandboxFloorMs,
      sandboxOwnerUid);
    options.onClaudeKeptFolders?.(claudeKeptFolders);
  }
  const statefulSuites = partition.stateful.length ? await (options.statefulRunner ??
    new SystemUpgradeResumeRunner()).run({ repo: options.repo, pluginSha: options.pluginSha,
      currentSnapshot: snapshot,
      runRoot: join(options.runRoot, "stateful"), claudeExecutable: options.claudeExecutable,
      codexExecutable: options.codexExecutable, cases: partition.stateful, runtimes,
      targetRef: options.statefulTargetRef, signal: options.signal }) : {};
  const records: EvalRuntimeRecord[] = runtimes.map((runtime): EvalRuntimeRecord => {
    const ordinary = ordinaryRecords.find((item) => item.runtime === runtime);
    if (ordinary?.invalidReason) return ordinary;
    const stateful = statefulSuites[runtime] ?? null;
    if (stateful) {
      const invalidReason = statefulInfrastructureInvalidReason(stateful);
      if (invalidReason) {
        const merged = mergeEvalSuiteResults(ordinary?.result ?? null, stateful, selected);
        if (!merged) return { runtime, exitCode: 1, result: null, invalidReason };
        return { runtime, exitCode: 1, result: merged, invalidReason };
      }
    }
    const merged = mergeEvalSuiteResults(ordinary?.result ?? null, stateful, selected);
    if (!merged) return { runtime, exitCode: 1, result: null,
      invalidReason: "eval-runtime-artifact-missing" };
    return { runtime, exitCode: merged.failed ? 1 : 0, result: merged, invalidReason: null };
  });
  const result = finalizeLocalEval({ pluginSha: options.pluginSha,
    createdAt: new Date().toISOString(), wallMs: Date.now() - started,
    deterministicOnly: options.deterministicOnly ?? false, selectedCases: selected, runtimes: records });
  mkdirSync(options.outputDir, { recursive: true });
  const stem = `eval-${result.createdAt.replaceAll(/[:.]/g, "")}-${options.pluginSha.slice(0, 12)}`;
  const jsonFile = join(options.outputDir, `${stem}.json`);
  const reportFile = join(options.outputDir, `${stem}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  writeFileSync(reportFile, buildLocalEvalReport(result), { flag: "wx" });
  return { result, jsonFile, reportFile, claudeKeptFolders };
}

/** Select retryable case failures while excluding invalid infrastructure runtimes. */
export function failedCases(result: LocalEvalResult, runtime: EvalRuntime): string[] {
  const record = result.runtimes.find((item) => item.runtime === runtime);
  if (record?.invalidReason) return [];
  return [...new Set(record?.result?.cases
    .filter((item) => !item.passed && item.unavailableReason === undefined)
    .map((item) => item.id) ??
    result.selectedCases)].sort();
}

/** Compare only unchanged cases that the last green nightly proved reliable. */
export function confirmedNightlyRegressions(lastGreen: EvalBaselineArtifact,
  current: EvalBaselineArtifact): NightlyRegressionCase[] {
  const currentCases = new Map(current.cases.map((item) => [item.id, item]));
  const quarantined = new Set(current.quarantine
    .filter((entry) => evalQuarantineEntryIsActive(entry, current.createdAt))
    .map((entry) => `${entry.runtime}:${entry.case}`));
  return lastGreen.cases.flatMap((previous) => {
    const next = currentCases.get(previous.id);
    if (!next || next.contentHash !== previous.contentHash) return [];
    return (["claude", "codex"] as const).flatMap((runtime): NightlyRegressionCase[] => {
      const before = previous.outcomes[runtime];
      const after = next.outcomes[runtime];
      if (after?.latestAvailability?.status === "unavailable") return [];
      const beforeLast = before?.recentNightlyOutcomes.at(-1);
      const afterLast = after?.recentNightlyOutcomes.at(-1);
      if (!before?.reliable || beforeLast?.passes !== beforeLast?.runs ||
          afterLast?.passes === afterLast?.runs || quarantined.has(`${runtime}:${previous.id}`)) return [];
      return [{ runtime, case: previous.id }];
    });
  }).sort((left, right) => `${left.runtime}:${left.case}`.localeCompare(`${right.runtime}:${right.case}`));
}

/** Alert deterministic cases from their first final failing night, after retries settle. */
export function deterministicNightlyFailures(current: EvalBaselineArtifact): NightlyRegressionCase[] {
  const quarantined = new Set(current.quarantine
    .filter((entry) => evalQuarantineEntryIsActive(entry, current.createdAt))
    .map((entry) => `${entry.runtime}:${entry.case}`));
  return current.cases.flatMap((item) => item.deterministic === true
    ? (["claude", "codex"] as const).flatMap((runtime): NightlyRegressionCase[] => {
      const last = item.outcomes[runtime]?.recentNightlyOutcomes.at(-1);
      if (item.outcomes[runtime]?.latestAvailability?.status === "unavailable") return [];
      return last && last.passes < last.runs && !quarantined.has(`${runtime}:${item.id}`)
        ? [{ runtime, case: item.id }] : [];
    }) : []).sort((left, right) => `${left.runtime}:${left.case}`
    .localeCompare(`${right.runtime}:${right.case}`));
}

/** Current nightly cases that could not run because their harness premise was unavailable. */
export function unavailableNightlyCases(current: EvalBaselineArtifact): Array<{
  runtime: EvalRuntime; case: string; reason: string;
}> {
  return current.cases.flatMap((item) => (["claude", "codex"] as const).flatMap((runtime) => {
    const availability = item.outcomes[runtime]?.latestAvailability;
    return availability?.status === "unavailable"
      ? [{ runtime, case: item.id, reason: availability.reason }] : [];
  })).sort((left, right) => `${left.runtime}:${left.case}`.localeCompare(`${right.runtime}:${right.case}`));
}

interface RegressionDeliveryRecord {
  schemaVersion: 1 | 2;
  delivery: "pending" | "attempting" | "sent";
  attemptedAt?: string | null;
  deliveredAt: string | null;
  notice: Parameters<NightlyRegressionReporter["report"]>[0];
}

interface NightlyPublicationRecord {
  schemaVersion: 1;
  artifact: EvalBaselineArtifact;
  resetLineage: boolean;
  lastGreenSha: string | null;
  regressions: NightlyRegressionCase[];
  expiredQuarantine?: EvalQuarantineEntry[];
}

function slackFailureReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim() : "eval-slack-unknown-failure";
}

function logSlackFailure(error: unknown): void {
  process.stderr.write(`VIBE_NIGHTLY_SLACK_FAILURE ${slackFailureReason(error)}\n`);
}

function publicationFiles(store: string): string[] {
  if (!existsSync(store)) return [];
  return readdirSync(store).filter((name) =>
    /^eval-t2-publication-[a-f0-9]{12}\.json$/.test(name)).sort();
}

/**
 * Complete a journaled pointer advance and regression delivery before any new
 * paid work. Attribution or Slack failures leave enough state to resume.
 */
export async function recoverPendingNightlyPublications(input: {
  store: string;
  repo: string;
  ghExecutable: string;
}, reporter: NightlyRegressionReporter): Promise<string[]> {
  const completed: string[] = [];
  for (const name of publicationFiles(input.store)) {
    const file = join(input.store, name);
    let record: NightlyPublicationRecord;
    try { record = JSON.parse(readFileSync(file, "utf8")) as NightlyPublicationRecord; }
    catch { throw new Error("eval-nightly-publication-malformed"); }
    if (record.schemaVersion !== 1 || typeof record.resetLineage !== "boolean" ||
        !Array.isArray(record.regressions) ||
        (record.expiredQuarantine !== undefined && !Array.isArray(record.expiredQuarantine)) ||
        (record.lastGreenSha !== null && !/^[a-f0-9]{40}$/.test(record.lastGreenSha))) {
      throw new Error("eval-nightly-publication-invalid");
    }
    const expectedResultFile = evalBaselineFileName(record.artifact);
    let regressionFile: string | null = null;
    const expiredQuarantine = record.expiredQuarantine ?? [];
    if (record.regressions.length || expiredQuarantine.length) {
      const changes = record.lastGreenSha && record.regressions.length
        ? nightlyChangesSince({ repo: input.repo, ghExecutable: input.ghExecutable,
          baselineSha: record.lastGreenSha, currentSha: record.artifact.pluginSha })
        : { mergedPullRequests: [], directCommits: [] };
      const notice = { baselineSha: record.lastGreenSha ?? record.artifact.pluginSha,
        currentSha: record.artifact.pluginSha,
        cases: record.regressions, ...changes, expiredQuarantine,
        quarantineOwner: record.artifact.quarantine[0]?.owner ?? "vibe-maintainers",
        resultsArtifact: `team nightly results store: ${expectedResultFile}` };
      regressionFile = join(input.store,
        `eval-t2-regression-${record.artifact.pluginSha.slice(0, 12)}.json`);
      if (!existsSync(regressionFile)) {
        const delivery: RegressionDeliveryRecord = { schemaVersion: 2, delivery: "pending",
          attemptedAt: null, deliveredAt: null, notice };
        writeFileSync(regressionFile, `${JSON.stringify(delivery, null, 2)}\n`,
          { flag: "wx", mode: 0o600 });
      } else {
        let retained: RegressionDeliveryRecord;
        try { retained = JSON.parse(readFileSync(regressionFile, "utf8")) as RegressionDeliveryRecord; }
        catch { throw new Error("eval-regression-delivery-malformed"); }
        if (![1, 2].includes(retained.schemaVersion) ||
            JSON.stringify(retained.notice) !== JSON.stringify(notice)) {
          throw new Error("eval-regression-delivery-conflict");
        }
      }
    }
    const latest = existsSync(join(input.store, "eval-t2-latest.json"))
      ? resolveLatestEvalBaseline(input.store) : null;
    if (latest?.artifact.resultHash !== record.artifact.resultHash) {
      publishEvalBaseline(input.store, record.artifact, { resetLineage: record.resetLineage });
    }
    if (regressionFile) {
      try { await deliverPendingRegressionReports(input.store, reporter); }
      catch (error) { logSlackFailure(error); }
    }
    unlinkSync(file);
    completed.push(file);
  }
  return completed;
}

function replaceRegressionDelivery(file: string, record: RegressionDeliveryRecord): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * Deliver pending notices once. A process or acknowledgement failure after the
 * attempt begins remains `attempting` and is never replayed without manual
 * reconciliation because the Slack MCP schema has no idempotency key.
 */
export async function deliverPendingRegressionReports(store: string,
  reporter: NightlyRegressionReporter): Promise<string[]> {
  if (!existsSync(store)) return [];
  const delivered: string[] = [];
  const files = readdirSync(store).filter((name) =>
    /^eval-t2-regression-[a-f0-9]{12}\.json$/.test(name)).sort();
  for (const name of files) {
    const file = join(store, name);
    let record: RegressionDeliveryRecord;
    try { record = JSON.parse(readFileSync(file, "utf8")) as RegressionDeliveryRecord; }
    catch { throw new Error("eval-regression-delivery-malformed"); }
    const deliveryValid = record.schemaVersion === 1
      ? ["pending", "sent"].includes(record.delivery)
      : record.schemaVersion === 2 && ["pending", "attempting", "sent"].includes(record.delivery);
    if (!deliveryValid ||
        !record.notice || !Array.isArray(record.notice.cases) ||
        !Array.isArray(record.notice.expiredQuarantine) ||
        (record.notice.cases.length === 0 && record.notice.expiredQuarantine.length === 0)) {
      throw new Error("eval-regression-delivery-invalid");
    }
    if (record.delivery !== "pending") continue;
    // The machine-wide heavy slot serializes nightly delivery. This atomic
    // journal transition is therefore the sole durable ownership boundary:
    // a crash before rename is safely pending; a crash after rename is an
    // ambiguous attempt that must not be replayed.
    const attempting: RegressionDeliveryRecord = { ...record, schemaVersion: 2,
      delivery: "attempting",
      attemptedAt: new Date().toISOString() };
    replaceRegressionDelivery(file, attempting);
    try {
      await reporter.report(record.notice);
    } catch (error) {
      if (isRetrySafeSlackFailure(error)) {
        replaceRegressionDelivery(file, { ...record, schemaVersion: 2,
          delivery: "pending", attemptedAt: null });
      }
      throw error;
    }
    process.stdout.write("VIBE_NIGHTLY_SLACK_POSTED\n");
    const sent: RegressionDeliveryRecord = { ...attempting, delivery: "sent",
      deliveredAt: new Date().toISOString() };
    replaceRegressionDelivery(file, sent);
    delivered.push(file);
  }
  return delivered;
}

/** Run one complete dual-runtime T2 pass and retry only failures twice. */
export async function runT2Evals(input: Omit<LocalEvalOptions, "selectedCases" | "deterministicOnly" |
  "snapshotMode" | "runtimes"> & { ghExecutable: string },
commands: EvalCommands = new SystemEvalCommands(),
reporter?: NightlyRegressionReporter,
writeOutput: (text: string) => unknown = (text) => process.stdout.write(text)): Promise<{
    result: EvalBaselineArtifact; jsonFile: string; skipped: boolean;
    claudeKeptFolders: ClaudeKeptFolders;
    regressionReportFile: string | null;
    lineageReset: boolean;
    lineageReason: string | null;
  }> {
  const deliveryReporter = reporter ?? new SlackNightlyRegressionReporter(input.claudeExecutable);
  requireCleanT2Snapshot(input.repo, input.pluginSha);
  mkdirSync(input.outputDir, { recursive: true });
  await recoverPendingNightlyPublications({ store: input.outputDir, repo: input.repo,
    ghExecutable: input.ghExecutable }, deliveryReporter);
  try { await deliverPendingRegressionReports(input.outputDir, deliveryReporter); }
  catch (error) { logSlackFailure(error); }
  const existing = existsSync(join(input.outputDir, "eval-t2-latest.json"))
    ? resolveLatestEvalBaseline(input.outputDir) : null;
  const metadataSnapshot = snapshotPluginsAtHead(input.repo, input.pluginSha,
    join(input.runRoot, "metadata"));
  const catalog = evalCaseCatalog(metadataSnapshot.vibeDir);
  const catalogChanged = existing ? catalog.length !== existing.artifact.cases.length ||
    catalog.some((item) => {
      const prior = existing.artifact.cases.find((candidate) => candidate.id === item.id);
      return !prior || prior.contentHash !== item.contentHash ||
        prior.deterministic !== item.deterministic || prior.kind !== item.kind;
    }) : true;
  const quarantineStatus = evalQuarantineStatus();
  const currentQuarantine = quarantineStatus.entries;
  const currentModels = !existing || evalBaselineModelsMatchPolicy(existing.artifact);
  if (existing) {
    const ancestry = spawnSync("git", ["-C", input.repo, "merge-base", "--is-ancestor",
      existing.artifact.pluginSha, input.pluginSha]);
    if (ancestry.status !== 0) throw new Error("eval-t2-baseline-not-ancestor");
    let scope;
    try {
      scope = classifyVibeChangeScopeBetween(input.repo, existing.artifact.pluginSha, input.pluginSha);
    } catch { throw new Error("eval-t2-change-detection-failed"); }
    if (scope.behaviorFiles.length === 0 && currentModels && !catalogChanged) {
      const reconciled = reconcileEvalBaselineQuarantine(existing.artifact, currentQuarantine);
      const jsonFile = reconciled === existing.artifact
        ? existing.file : publishEvalBaseline(input.outputDir, reconciled);
      if (quarantineStatus.expired.length) {
        const publicationFile = join(input.outputDir,
          `eval-t2-publication-${input.pluginSha.slice(0, 12)}.json`);
        const publication: NightlyPublicationRecord = { schemaVersion: 1, artifact: reconciled,
          resetLineage: false, lastGreenSha: existing.index.latestGreenFile
            ? resolveLastGreenEvalBaseline(input.outputDir)?.pluginSha ?? null : null,
          regressions: [], expiredQuarantine: quarantineStatus.expired };
        writeFileSync(publicationFile, `${JSON.stringify(publication, null, 2)}\n`,
          { flag: "wx", mode: 0o600 });
        await recoverPendingNightlyPublications({ store: input.outputDir, repo: input.repo,
          ghExecutable: input.ghExecutable }, deliveryReporter);
      }
      return { result: reconciled, jsonFile, skipped: true,
        claudeKeptFolders: { reported: 0, removed: 0, remaining: [] },
        regressionReportFile: null, lineageReset: false, lineageReason: null };
    }
  }
  const pluginVersion = manifestVersion(metadataSnapshot.vibeDir);
  const pluginTreeSha = spawnSync("git", ["-C", input.repo, "rev-parse", `${input.pluginSha}^{tree}`],
    { encoding: "utf8" }).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(pluginTreeSha)) throw new Error("eval-t2-tree-invalid");
  const previous = currentModels ? existing?.artifact : undefined;
  const results: LocalEvalResult[] = [];
  // Each run reports its kept sandboxes here, so a run that throws is still counted.
  const keptByRun: ClaudeKeptFolders[] = [];
  const runInput = { ...input,
    onClaudeKeptFolders: (kept: ClaudeKeptFolders) => { keptByRun.push(kept); } };
  let claudeKeptFolders: ClaudeKeptFolders = sumClaudeKeptFolders([]);
  try {
    const initial = (await runLocalEvals({ ...runInput, runRoot: join(input.runRoot, "run-1"),
      deterministicOnly: false, snapshotMode: "head", runtimes: ["claude", "codex"],
      concurrency: EVAL_POLICY.concurrency }, commands)).result;
    results.push(initial);
    const pending = new Map<EvalRuntime, string[]>((['claude', 'codex'] as EvalRuntime[]).map((runtime) =>
      [runtime, failedCases(initial, runtime)]));
    for (let wave = 0; wave < EVAL_POLICY.failureReruns &&
        [...pending.values()].some((ids) => ids.length > 0); wave += 1) {
      const launches = (["claude", "codex"] as const).flatMap((runtime) => {
        const selected = pending.get(runtime) ?? [];
        return selected.length ? [runLocalEvals({ ...runInput,
          runRoot: join(input.runRoot, `retry-${wave + 1}-${runtime}`), selectedCases: selected,
          deterministicOnly: false, snapshotMode: "head", runtimes: [runtime],
          concurrency: EVAL_POLICY.concurrency }, commands).then((output) => ({ runtime,
          result: output.result }))] : [];
      });
      // Wait for every retry before failing, so a Claude retry still running
      // when its sibling is rejected has its kept sandboxes counted.
      const reruns = await Promise.allSettled(launches);
      const rejected = reruns.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (rejected) throw rejected.reason;
      for (const rerun of reruns) {
        if (rerun.status !== "fulfilled") continue;
        results.push(rerun.value.result);
        pending.set(rerun.value.runtime, failedCases(rerun.value.result, rerun.value.runtime));
      }
    }
  } finally {
    // Printed once, before the baseline is built and also when a run threw.
    claudeKeptFolders = sumClaudeKeptFolders(keptByRun);
    for (const line of keptSandboxLogLines(claudeKeptFolders)) writeOutput(`${line}\n`);
  }
  requireCleanT2Snapshot(input.repo, input.pluginSha);
  const result = buildEvalBaseline({ results, catalog, pluginVersion, pluginTreeSha, previous });
  for (const unavailable of unavailableNightlyCases(result)) {
    process.stdout.write(`VIBE_NIGHTLY_CASE_UNAVAILABLE runtime=${unavailable.runtime} ` +
      `case=${unavailable.case} reason=${unavailable.reason}\n`);
  }
  const lastGreen = existing && currentModels ? resolveLastGreenEvalBaseline(input.outputDir) : null;
  const regressions = [...new Map([
    ...(lastGreen ? confirmedNightlyRegressions(lastGreen, result) : []),
    ...deterministicNightlyFailures(result),
  ].map((item) => [`${item.runtime}:${item.case}`, item])).values()]
    .sort((left, right) => `${left.runtime}:${left.case}`.localeCompare(`${right.runtime}:${right.case}`));
  const publicationFile = join(input.outputDir,
    `eval-t2-publication-${input.pluginSha.slice(0, 12)}.json`);
  const publication: NightlyPublicationRecord = { schemaVersion: 1, artifact: result,
    resetLineage: !currentModels, lastGreenSha: lastGreen?.pluginSha ?? null, regressions,
    expiredQuarantine: quarantineStatus.expired };
  writeFileSync(publicationFile, `${JSON.stringify(publication, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  await recoverPendingNightlyPublications({ store: input.outputDir, repo: input.repo,
    ghExecutable: input.ghExecutable }, deliveryReporter);
  const jsonFile = join(input.outputDir, evalBaselineFileName(result));
  const regressionReportFile = regressions.length || quarantineStatus.expired.length
    ? join(input.outputDir, `eval-t2-regression-${input.pluginSha.slice(0, 12)}.json`) : null;
  return { result, jsonFile, skipped: false, claudeKeptFolders, regressionReportFile,
    lineageReset: !currentModels,
    lineageReason: currentModels ? null :
      `model-policy-changed:` +
      `claude=${existing?.artifact.models.claude ?? "none"}/${EVAL_POLICY.claudeModel},` +
      `claudeJudge=${existing?.artifact.models.claudeJudge ?? "none"}/${EVAL_POLICY.claudeJudgeModel},` +
      `codex=${existing?.artifact.models.codex ?? "none"}/${result.models.codex},` +
      `codexJudge=${existing?.artifact.models.codexJudge ?? "none"}/${EVAL_POLICY.codexJudgeModel}` };
}
