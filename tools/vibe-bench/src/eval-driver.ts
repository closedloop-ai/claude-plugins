import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalEvalReport, codexCaseId, collectClaudeEval, collectCodexEval,
  finalizeLocalEval } from "./eval-collector.ts";
import type { EvalRuntimeRecord, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { EVAL_POLICY, requireDeveloperMachine } from "./eval-policy.ts";
import type { EvalRuntime } from "./eval-policy.ts";
import { snapshotPluginsAtHead, snapshotPluginsAtWorktree } from "./plugin-snapshot.ts";
import { buildEvalBaseline, evalBaselineFileName, evalBaselineModelsMatchPolicy, publishEvalBaseline,
  evalQuarantineEntryIsActive, evalQuarantineStatus, reconcileEvalBaselineQuarantine,
  resolveLastGreenEvalBaseline,
  resolveLatestEvalBaseline } from "./eval-baseline.ts";
import type { EvalBaselineArtifact, EvalQuarantineEntry } from "./eval-baseline.ts";
import { evalCaseCatalog } from "./eval-selection.ts";
import { classifyVibeChangeScopeBetween } from "./vibe-change-scope.ts";
import { nightlyChangesSince, SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { NightlyRegressionCase, NightlyRegressionReporter } from "./eval-slack.ts";
import { runOwnedProcess } from "./owned-process.ts";

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
}

/** Process boundary injected by tests so no model command is launched there. */
export interface EvalCommands {
  readonly localModelExecution: boolean;
  run(command: string, args: string[], cwd: string, options: {
    deadline: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; stdout: string; stderr: string }>;
}

/** Keep scheduler-only Slack credentials out of every model and grader process. */
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
  async run(command: string, args: string[], cwd: string, options: {
    deadline: number;
    signal?: AbortSignal;
  }) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const onSignal = () => abort.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const result = await runOwnedProcess(command, args, { cwd, deadline: options.deadline,
        signal: abort.signal, maxBuffer: 16 * 1024 * 1024, env: evalModelProcessEnv() });
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
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new Error("eval-native-artifact-malformed"); }
}

function stableReason(error: unknown, runtime: "claude" | "codex"): string {
  const message = error instanceof Error ? error.message : "";
  return /^eval-[a-z0-9:-]+$/.test(message) ? message : `eval-${runtime}-artifact-invalid`;
}

function manifestVersion(pluginDir: string): string {
  const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin/plugin.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error("eval-plugin-version-invalid");
  return manifest.version;
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

/** Discover the native Claude case manifests once from the immutable snapshot. */
export function evalCaseIds(vibeDir: string): string[] {
  const evals = join(vibeDir, "evals");
  const ids = readdirSync(evals, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evals, entry.name, "prompt.md")))
    .map((entry) => entry.name).sort();
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("eval-case-manifest-invalid");
  return ids;
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
 * Copy a focused Claude corpus into the run-owned plugin snapshot.
 *
 * Claude Code accepts only one case glob and does not expand brace unions, so
 * a copied suite is the only exact multi-case selection that also preserves
 * each case's relative sibling-plugin paths.
 */
export function stageFocusedClaudeEvalCases(vibeDir: string, selectedCases: string[]): string {
  if (selectedCases.length === 0) return "vibe/evals";
  const focused = join(vibeDir, "evals-focused");
  if (existsSync(focused)) throw new Error("eval-focused-suite-exists");
  mkdirSync(focused);
  for (const id of [...selectedCases].sort()) {
    const source = join(vibeDir, "evals", id);
    if (!existsSync(join(source, "prompt.md"))) throw new Error("eval-focused-case-missing");
    cpSync(source, join(focused, id), { recursive: true, errorOnExist: true, force: false });
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
  const available = evalCaseIds(snapshot.vibeDir);
  const selected = options.selectedCases?.length ? [...options.selectedCases].sort() : available;
  if (new Set(selected).size !== selected.length || selected.some((id) => !available.includes(id))) {
    throw new Error("eval-case-selection-invalid");
  }
  const runtimes = options.runtimes ?? ["claude", "codex"];
  if (!runtimes.length || new Set(runtimes).size !== runtimes.length ||
      runtimes.some((runtime) => runtime !== "claude" && runtime !== "codex")) {
    throw new Error("eval-runtime-selection-invalid");
  }
  const claudeVersionFull = runtimes.includes("claude")
    ? await version(commands, options.claudeExecutable, options.runRoot, "claude", deadline, options.signal) : null;
  const claudeVersion = claudeVersionFull?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (runtimes.includes("claude") && !claudeVersion) throw new Error("eval-claude-version-invalid");
  const codexVersion = runtimes.includes("codex")
    ? await version(commands, options.codexExecutable, options.runRoot, "codex", deadline, options.signal) : null;
  const claudeOutput = join(options.runRoot, "claude");
  const codexOutput = join(options.runRoot, "codex");
  if (runtimes.includes("claude")) mkdirSync(claudeOutput);
  const claudeJson = join(claudeOutput, "result.json");
  const claudeEvalDir = runtimes.includes("claude") ? stageFocusedClaudeEvalCases(snapshot.vibeDir,
    options.selectedCases?.length ? selected : []) : null;
  // The case manifests load vibe and its sibling closedloop-core snapshot. Use
  // their shared parent as the containment root while selecting vibe's suite.
  const concurrency = options.concurrency ?? EVAL_POLICY.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("eval-concurrency-invalid");
  }
  const claudeArgs = ["plugin", "eval", dirname(snapshot.vibeDir), "--eval-dir", claudeEvalDir ?? "",
    "--json", claudeJson,
    "--output-dir", claudeOutput, "--ablation", "none", "--model", EVAL_POLICY.claudeModel,
    "--judge-model", EVAL_POLICY.claudeJudgeModel,
    "--runs", "1", "--threshold", "1", "--concurrency", String(concurrency), "--scaffold",
    "--trust-plugin", "--no-publish"];
  // The native runner documents these isolated Python dependencies. Provision
  // them through uv instead of relying on the developer's system Python.
  const codexArgs = ["run", "--with", "Pillow==12.3.0", "--with", "PyYAML", "python",
    codexEvalRunnerPath(), "--plugin", snapshot.vibeDir,
    "--source-sha", options.pluginSha, "--output", codexOutput, "--codex-bin",
    options.codexExecutable, "--concurrency", String(EVAL_POLICY.codexConcurrency), "--max-seconds",
    String(codexEvalBudgetSeconds(selected.length)), "--model", EVAL_POLICY.codexModel,
    "--grader-model", EVAL_POLICY.codexJudgeModel];
  if (options.deterministicOnly) codexArgs.push("--deterministic-only");
  for (const id of selected) codexArgs.push("--case", codexCaseId(id));
  let claudeProcess: { status: number; stdout: string; stderr: string } | null = null;
  let codexProcess: { status: number; stdout: string; stderr: string } | null = null;
  const siblings = new AbortController();
  const forwardAbort = () => siblings.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) siblings.abort();
  try {
    const launches = [
      runtimes.includes("claude")
        ? commands.run(options.claudeExecutable, claudeArgs, options.runRoot,
          { deadline, signal: siblings.signal }) : Promise.resolve(null),
      runtimes.includes("codex")
        ? commands.run(options.uvExecutable, codexArgs, options.runRoot,
          { deadline, signal: siblings.signal }) : Promise.resolve(null),
    ].map((launch) => launch.catch((error: unknown) => {
      siblings.abort();
      throw error;
    }));
    const settled = await Promise.allSettled(launches);
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failure) throw failure.reason;
    [claudeProcess, codexProcess] = settled.map((item) =>
      (item as PromiseFulfilledResult<{ status: number; stdout: string; stderr: string } | null>).value);
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    // The Python runner also removes this copy in its finally block. The
    // parent independently removes it so an interrupt cannot retain a credential file.
    rmSync(join(codexOutput, "home/auth.json"), { force: true });
  }
  if (claudeProcess) writeProcessLog(join(options.runRoot, "claude-process.log"), claudeProcess);
  if (codexProcess) writeProcessLog(join(options.runRoot, "codex-process.log"), codexProcess);

  const vibeVersion = manifestVersion(snapshot.vibeDir);
  const coreVersion = manifestVersion(snapshot.coreDir);
  const wordingCases = wordingCaseIds(snapshot.vibeDir, selected);
  const skillSha = createHash("sha256").update(
    readFileSync(join(snapshot.vibeDir, "skills/vibe/SKILL.md"))).digest("hex");
  const records: EvalRuntimeRecord[] = [];
  if (claudeProcess && claudeVersion) records.push(
    record("claude", claudeProcess.status, () => collectClaudeEval(json(claudeJson), selected, {
      version: vibeVersion, coreVersion, cliVersion: claudeVersion,
      vibePath: snapshot.vibeDir, corePath: snapshot.coreDir,
      model: EVAL_POLICY.claudeModel, runs: 1,
    })));
  if (codexProcess && codexVersion) records.push(record("codex", codexProcess.status, () => collectCodexEval(
      json(join(codexOutput, "results.json")), selected, {
        sourceSha: options.pluginSha, skillSha, version: vibeVersion, cliVersion: codexVersion,
        vibePath: snapshot.vibeDir, deterministicOnly: options.deterministicOnly ?? false,
        model: EVAL_POLICY.codexModel, graderModel: EVAL_POLICY.codexJudgeModel, wordingCases,
      })));
  const result = finalizeLocalEval({ pluginSha: options.pluginSha,
    createdAt: new Date().toISOString(), wallMs: Date.now() - started,
    deterministicOnly: options.deterministicOnly ?? false, selectedCases: selected, runtimes: records });
  mkdirSync(options.outputDir, { recursive: true });
  const stem = `eval-${result.createdAt.replaceAll(/[:.]/g, "")}-${options.pluginSha.slice(0, 12)}`;
  const jsonFile = join(options.outputDir, `${stem}.json`);
  const reportFile = join(options.outputDir, `${stem}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  writeFileSync(reportFile, buildLocalEvalReport(result), { flag: "wx" });
  return { result, jsonFile, reportFile };
}

function failedCases(result: LocalEvalResult, runtime: EvalRuntime): string[] {
  const record = result.runtimes.find((item) => item.runtime === runtime);
  return [...new Set(record?.result?.cases.filter((item) => !item.passed).map((item) => item.id) ??
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
      const beforeLast = before?.recentNightlyOutcomes.at(-1);
      const afterLast = after?.recentNightlyOutcomes.at(-1);
      if (!before?.reliable || beforeLast?.passes !== beforeLast?.runs ||
          afterLast?.passes === afterLast?.runs || quarantined.has(`${runtime}:${previous.id}`)) return [];
      return [{ runtime, case: previous.id }];
    });
  }).sort((left, right) => `${left.runtime}:${left.case}`.localeCompare(`${right.runtime}:${right.case}`));
}

interface RegressionDeliveryRecord {
  schemaVersion: 1;
  delivery: "pending" | "sent";
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
    if ((record.lastGreenSha && record.regressions.length) || expiredQuarantine.length) {
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
        const delivery: RegressionDeliveryRecord = { schemaVersion: 1, delivery: "pending",
          deliveredAt: null, notice };
        writeFileSync(regressionFile, `${JSON.stringify(delivery, null, 2)}\n`,
          { flag: "wx", mode: 0o600 });
      } else {
        let retained: RegressionDeliveryRecord;
        try { retained = JSON.parse(readFileSync(regressionFile, "utf8")) as RegressionDeliveryRecord; }
        catch { throw new Error("eval-regression-delivery-malformed"); }
        if (retained.schemaVersion !== 1 || JSON.stringify(retained.notice) !== JSON.stringify(notice)) {
          throw new Error("eval-regression-delivery-conflict");
        }
      }
    }
    const latest = existsSync(join(input.store, "eval-t2-latest.json"))
      ? resolveLatestEvalBaseline(input.store) : null;
    if (latest?.artifact.resultHash !== record.artifact.resultHash) {
      publishEvalBaseline(input.store, record.artifact, { resetLineage: record.resetLineage });
    }
    if (regressionFile) await deliverPendingRegressionReports(input.store, reporter);
    unlinkSync(file);
    completed.push(file);
  }
  return completed;
}

/** Retry an interrupted Slack delivery without repeating any paid model work. */
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
    if (record.schemaVersion !== 1 || !["pending", "sent"].includes(record.delivery) ||
        !record.notice || !Array.isArray(record.notice.cases) ||
        !Array.isArray(record.notice.expiredQuarantine) ||
        (record.notice.cases.length === 0 && record.notice.expiredQuarantine.length === 0)) {
      throw new Error("eval-regression-delivery-invalid");
    }
    if (record.delivery === "sent") continue;
    await reporter.report(record.notice);
    const sent: RegressionDeliveryRecord = { ...record, delivery: "sent",
      deliveredAt: new Date().toISOString() };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(sent, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    delivered.push(file);
  }
  return delivered;
}

/** Run one complete dual-runtime T2 pass and retry only failures twice. */
export async function runT2Evals(input: Omit<LocalEvalOptions, "selectedCases" | "deterministicOnly" |
  "snapshotMode" | "runtimes"> & { ghExecutable: string },
commands: EvalCommands = new SystemEvalCommands(),
reporter: NightlyRegressionReporter = new SlackNightlyRegressionReporter()): Promise<{
    result: EvalBaselineArtifact; jsonFile: string; skipped: boolean;
    regressionReportFile: string | null;
    lineageReset: boolean;
    lineageReason: string | null;
  }> {
  requireCleanT2Snapshot(input.repo, input.pluginSha);
  mkdirSync(input.outputDir, { recursive: true });
  await recoverPendingNightlyPublications({ store: input.outputDir, repo: input.repo,
    ghExecutable: input.ghExecutable }, reporter);
  await deliverPendingRegressionReports(input.outputDir, reporter);
  const existing = existsSync(join(input.outputDir, "eval-t2-latest.json"))
    ? resolveLatestEvalBaseline(input.outputDir) : null;
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
    if (scope.behaviorFiles.length === 0 && currentModels) {
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
          ghExecutable: input.ghExecutable }, reporter);
      }
      return { result: reconciled, jsonFile, skipped: true,
        regressionReportFile: null, lineageReset: false, lineageReason: null };
    }
  }
  const metadataSnapshot = snapshotPluginsAtHead(input.repo, input.pluginSha,
    join(input.runRoot, "metadata"));
  const catalog = evalCaseCatalog(metadataSnapshot.vibeDir);
  const pluginVersion = manifestVersion(metadataSnapshot.vibeDir);
  const pluginTreeSha = spawnSync("git", ["-C", input.repo, "rev-parse", `${input.pluginSha}^{tree}`],
    { encoding: "utf8" }).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(pluginTreeSha)) throw new Error("eval-t2-tree-invalid");
  const previous = currentModels ? existing?.artifact : undefined;
  const initial = (await runLocalEvals({ ...input, runRoot: join(input.runRoot, "run-1"),
    deterministicOnly: false, snapshotMode: "head", runtimes: ["claude", "codex"],
    concurrency: EVAL_POLICY.concurrency }, commands)).result;
  const results: LocalEvalResult[] = [initial];
  const pending = new Map<EvalRuntime, string[]>((['claude', 'codex'] as EvalRuntime[]).map((runtime) =>
    [runtime, failedCases(initial, runtime)]));
  for (let wave = 0; wave < EVAL_POLICY.failureReruns &&
      [...pending.values()].some((ids) => ids.length > 0); wave += 1) {
    const launches = (["claude", "codex"] as const).flatMap((runtime) => {
      const selected = pending.get(runtime) ?? [];
      return selected.length ? [runLocalEvals({ ...input,
        runRoot: join(input.runRoot, `retry-${wave + 1}-${runtime}`), selectedCases: selected,
        deterministicOnly: false, snapshotMode: "head", runtimes: [runtime],
        concurrency: EVAL_POLICY.concurrency }, commands).then((output) => ({ runtime,
        result: output.result }))] : [];
    });
    const reruns = await Promise.all(launches);
    for (const rerun of reruns) {
      results.push(rerun.result);
      pending.set(rerun.runtime, failedCases(rerun.result, rerun.runtime));
    }
  }
  requireCleanT2Snapshot(input.repo, input.pluginSha);
  const result = buildEvalBaseline({ results, catalog, pluginVersion, pluginTreeSha, previous });
  const lastGreen = existing && currentModels ? resolveLastGreenEvalBaseline(input.outputDir) : null;
  const regressions = lastGreen ? confirmedNightlyRegressions(lastGreen, result) : [];
  const publicationFile = join(input.outputDir,
    `eval-t2-publication-${input.pluginSha.slice(0, 12)}.json`);
  const publication: NightlyPublicationRecord = { schemaVersion: 1, artifact: result,
    resetLineage: !currentModels, lastGreenSha: lastGreen?.pluginSha ?? null, regressions,
    expiredQuarantine: quarantineStatus.expired };
  writeFileSync(publicationFile, `${JSON.stringify(publication, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  await recoverPendingNightlyPublications({ store: input.outputDir, repo: input.repo,
    ghExecutable: input.ghExecutable }, reporter);
  const jsonFile = join(input.outputDir, evalBaselineFileName(result));
  const regressionReportFile = regressions.length || quarantineStatus.expired.length
    ? join(input.outputDir, `eval-t2-regression-${input.pluginSha.slice(0, 12)}.json`) : null;
  return { result, jsonFile, skipped: false, regressionReportFile,
    lineageReset: !currentModels,
    lineageReason: currentModels ? null :
      `model-policy-changed:` +
      `claude=${existing?.artifact.models.claude ?? "none"}/${EVAL_POLICY.claudeModel},` +
      `claudeJudge=${existing?.artifact.models.claudeJudge ?? "none"}/${EVAL_POLICY.claudeJudgeModel},` +
      `codex=${existing?.artifact.models.codex ?? "none"}/${EVAL_POLICY.codexModel},` +
      `codexJudge=${existing?.artifact.models.codexJudge ?? "none"}/${EVAL_POLICY.codexJudgeModel}` };
}
