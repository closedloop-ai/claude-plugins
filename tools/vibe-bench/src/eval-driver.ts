import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLocalEvalReport, codexCaseId, collectClaudeEval, collectCodexEval,
  finalizeLocalEval } from "./eval-collector.ts";
import type { EvalRuntimeRecord, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { snapshotPluginsAtHead } from "./plugin-snapshot.ts";

/** Explicit inputs for a local-only dual-runtime model eval. */
export interface LocalEvalOptions {
  repo: string;
  pluginSha: string;
  runRoot: string;
  outputDir: string;
  claudeExecutable: string;
  codexExecutable: string;
  pythonExecutable: string;
  selectedCases?: string[];
  deterministicOnly?: boolean;
}

/** Process boundary injected by tests so no model command is launched there. */
export interface EvalCommands {
  run(command: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string };
}

class SystemEvalCommands implements EvalCommands {
  run(command: string, args: string[], cwd: string) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return { status: result.status ?? 70, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

function version(commands: EvalCommands, executable: string, cwd: string, runtime: string): string {
  const result = commands.run(executable, ["--version"], cwd);
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
export function runLocalEvals(options: LocalEvalOptions,
  commands: EvalCommands = new SystemEvalCommands()): {
    result: LocalEvalResult; jsonFile: string; reportFile: string;
  } {
  if (existsSync(options.runRoot)) throw new Error("eval-run-root-exists");
  mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const snapshot = snapshotPluginsAtHead(options.repo, options.pluginSha, options.runRoot);
  const available = evalCaseIds(snapshot.vibeDir);
  const selected = options.selectedCases?.length ? [...options.selectedCases].sort() : available;
  if (new Set(selected).size !== selected.length || selected.some((id) => !available.includes(id))) {
    throw new Error("eval-case-selection-invalid");
  }
  const claudeVersionFull = version(commands, options.claudeExecutable, options.runRoot, "claude");
  const claudeVersion = claudeVersionFull.match(/\d+\.\d+\.\d+/)?.[0];
  if (!claudeVersion) throw new Error("eval-claude-version-invalid");
  const codexVersion = version(commands, options.codexExecutable, options.runRoot, "codex");
  const claudeOutput = join(options.runRoot, "claude");
  const codexOutput = join(options.runRoot, "codex");
  mkdirSync(claudeOutput);
  const claudeJson = join(claudeOutput, "result.json");
  const claudeArgs = ["plugin", "eval", snapshot.vibeDir, "--json", claudeJson,
    "--output-dir", claudeOutput, "--ablation", "none", "--model", "sonnet",
    "--runs", "1", "--threshold", "1", "--concurrency", "2", "--scaffold",
    "--trust-plugin", "--no-publish"];
  for (const id of selected) claudeArgs.push("--case", id);
  const claudeProcess = commands.run(options.claudeExecutable, claudeArgs, options.runRoot);
  writeProcessLog(join(options.runRoot, "claude-process.log"), claudeProcess);

  const codexArgs = [join(snapshot.vibeDir, "evals/codex/run.py"), "--plugin", snapshot.vibeDir,
    "--source-sha", options.pluginSha, "--output", codexOutput, "--codex-bin",
    options.codexExecutable, "--concurrency", "2", "--max-seconds", "1800"];
  if (options.deterministicOnly) codexArgs.push("--deterministic-only");
  for (const id of selected) codexArgs.push("--case", codexCaseId(id));
  const codexProcess = commands.run(options.pythonExecutable, codexArgs, options.runRoot);
  writeProcessLog(join(options.runRoot, "codex-process.log"), codexProcess);

  const vibeVersion = manifestVersion(snapshot.vibeDir);
  const coreVersion = manifestVersion(snapshot.coreDir);
  const wordingCases = wordingCaseIds(snapshot.vibeDir, selected);
  const skillSha = createHash("sha256").update(
    readFileSync(join(snapshot.vibeDir, "skills/vibe/SKILL.md"))).digest("hex");
  const runtimes = [
    record("claude", claudeProcess.status, () => collectClaudeEval(json(claudeJson), selected, {
      version: vibeVersion, coreVersion, cliVersion: claudeVersion,
      vibePath: snapshot.vibeDir, corePath: snapshot.coreDir,
    })),
    record("codex", codexProcess.status, () => collectCodexEval(
      json(join(codexOutput, "results.json")), selected, {
        sourceSha: options.pluginSha, skillSha, version: vibeVersion, cliVersion: codexVersion,
        vibePath: snapshot.vibeDir, deterministicOnly: options.deterministicOnly ?? false,
        model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases,
      })),
  ];
  const result = finalizeLocalEval({ pluginSha: options.pluginSha,
    createdAt: new Date().toISOString(), wallMs: Date.now() - started,
    deterministicOnly: options.deterministicOnly ?? false, selectedCases: selected, runtimes });
  mkdirSync(options.outputDir, { recursive: true });
  const stem = `eval-${result.createdAt.replaceAll(/[:.]/g, "")}-${options.pluginSha.slice(0, 12)}`;
  const jsonFile = join(options.outputDir, `${stem}.json`);
  const reportFile = join(options.outputDir, `${stem}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  writeFileSync(reportFile, buildLocalEvalReport(result), { flag: "wx" });
  return { result, jsonFile, reportFile };
}
