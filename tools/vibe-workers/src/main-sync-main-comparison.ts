import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MAX_CHECK_MS, MainSyncError, type MainComparison, type MainSyncReceipt } from "./main-sync-contracts.js";
import { failureCause } from "./main-sync-failure.js";
import type { CheckCommand } from "./main-sync-lanes.js";
import { verifyReportExecution } from "./main-sync-report-inputs.js";
import { ReportExecutionOwner } from "./main-sync-report-execution.js";
import { digest } from "./main-sync-state.js";
import { MAIN_BOOTSTRAP_MS } from "./main-sync-validation-recipe.js";

type Selection = { tasks: { taskId: string; package?: string }[] };
type RunEvidence = MainComparison["sessionRuns"][number];
type Rerun = (log: string) => RunEvidence;

const BOOTSTRAP = ["bash", ".closedloop-ai/loops-setup.sh"];
const PINNED_FILTER = /^--filter=\.\.\.\[[a-f0-9]{40}\]$/;
const CLEANUP_MS = 15 * 60 * 1000;
// run-bounded stops the whole process group at its limit; this outer bound only catches a stuck wrapper.
const WRAPPER_GRACE_MS = 30 * 1000;

/**
 * Operator ruling, 2026-10-16: a handoff check that fails is run again on the main the session captured. It is
 * `main-preexisting` when it also fails there, which never blocks publication. When it passes on main the session
 * commit gets one rerun before the failure is `session-caused` (a pass is `flaky`). A check that cannot run on main
 * is `session-caused`, the conservative reading. One disposable checkout of the captured main is bootstrapped once,
 * shared by every failing check of this validation, and removed by `dispose`.
 */
export class CapturedMainComparison {
  private checkout?: string;
  private registered = false;
  private bootstrap?: { ok: true } | { ok: false; reason: string; log?: string; sha256?: string };

  constructor(private readonly root: string, private readonly dir: string, private readonly receipt: MainSyncReceipt) {}

  /** Classifies one failing session run; passing checks never reach this. */
  classify(command: CheckCommand, selection: Selection | undefined, failed: RunEvidence, prefix: string,
    env: NodeJS.ProcessEnv, rerun: Rerun): MainComparison {
    const mainSha = this.receipt.mainSha;
    const main = this.runOnMain(command, selection, prefix, env);
    if (main.outcome === "failed") return { classification: "main-preexisting", mainSha, sessionRuns: [failed], main };
    if (main.outcome === "unrunnable") return { classification: "session-caused", mainSha, sessionRuns: [failed], main };
    const again = rerun(`${prefix}-rerun.log`);
    return { classification: again.exitCode === 0 ? "flaky" : "session-caused", mainSha, sessionRuns: [failed, again], main };
  }

  /** Removes the disposable checkout; an unproven removal keeps the operation's evidence and refuses. */
  dispose() {
    if (!this.checkout) return;
    const target = this.checkout;
    this.checkout = undefined;
    if (!this.registered) { rmSync(target, { recursive: true, force: true }); return; }
    try { git(this.root, ["worktree", "remove", "--force", target], { timeout: CLEANUP_MS }); }
    catch { throw new MainSyncError("Captured-main comparison checkout cleanup is unproven; preserve its operation evidence"); }
  }

  private runOnMain(command: CheckCommand, selection: Selection | undefined, prefix: string, env: NodeJS.ProcessEnv): MainComparison["main"] {
    const scoped = capturedMainArgv(this.root, this.receipt.mainSha, command, selection);
    if ("reason" in scoped) return { outcome: "unrunnable", reason: scoped.reason };
    const ready = this.prepare();
    if (!ready.ok) {
      return { outcome: "unrunnable", argv: scoped.argv, reason: ready.reason,
        ...(ready.log && ready.sha256 ? { log: ready.log, sha256: ready.sha256 } : {}) };
    }
    const checkout = this.checkout!;
    const cwd = command.cwd ? join(checkout, command.cwd) : checkout;
    try { verifyReportExecution(this.root, checkout, ReportExecutionOwner.Check, scoped.argv, cwd, selection); }
    catch (error) { return { outcome: "unrunnable", argv: scoped.argv, reason: `report admission refused: ${failureCause(error)}`.slice(0, 512) }; }
    const run = runBounded(scoped.argv, cwd, env, command.timeoutMs ?? MAX_CHECK_MS, `${prefix}-main.log`);
    if (run.exitCode === 0) return { outcome: "passed", argv: scoped.argv, exitCode: 0, log: run.log, sha256: run.sha256 };
    if (run.timedOut || run.spawnFailed) {
      return { outcome: "unrunnable", argv: scoped.argv, exitCode: run.exitCode, log: run.log, sha256: run.sha256,
        reason: run.timedOut ? "it ran out of its time limit on captured main" : "it could not be started on captured main" };
    }
    return { outcome: "failed", argv: scoped.argv, exitCode: run.exitCode, log: run.log, sha256: run.sha256 };
  }

  private prepare() {
    if (this.bootstrap) return this.bootstrap;
    const mainSha = this.receipt.mainSha;
    try {
      this.checkout = realpathSync(mkdtempSync(join(tmpdir(), "vibe-captured-main-")));
      git(this.root, ["worktree", "add", "--detach", this.checkout, mainSha], { timeout: CLEANUP_MS });
      this.registered = true;
    } catch (error) {
      if (error instanceof MainSyncError) throw error;
      this.bootstrap = { ok: false, reason: `a checkout of captured main could not be created: ${failureCause(error)}`.slice(0, 512) };
      return this.bootstrap;
    }
    if (!existsSync(join(this.checkout, BOOTSTRAP[1]!))) {
      this.bootstrap = { ok: false, reason: "captured main has no canonical bootstrap (.closedloop-ai/loops-setup.sh)" };
      return this.bootstrap;
    }
    try { verifyReportExecution(this.root, this.checkout, ReportExecutionOwner.Bootstrap, BOOTSTRAP, this.checkout); }
    catch (error) {
      this.bootstrap = { ok: false, reason: `bootstrap admission refused: ${failureCause(error)}`.slice(0, 512) };
      return this.bootstrap;
    }
    const log = join(this.dir, `vibe-main-sync-${this.receipt.transactionId}-main-bootstrap.log`);
    const run = runBounded(BOOTSTRAP, this.checkout, process.env, MAIN_BOOTSTRAP_MS, log);
    this.bootstrap = run.exitCode === 0 ? { ok: true }
      : { ok: false, reason: run.timedOut ? "the captured main bootstrap ran out of its time limit" : `the captured main bootstrap exited ${run.exitCode}`,
        log: run.log, sha256: run.sha256 };
    return this.bootstrap;
  }
}

/** The bounded session rerun shares the main run's process-group bound; neither uses GNU `timeout`. */
export function runBounded(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, log: string) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = spawnSync(process.execPath, [runBoundedScript(), String(seconds), ...argv], { cwd, env, encoding: "utf8",
    timeout: seconds * 1000 + WRAPPER_GRACE_MS, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(log, output, { mode: 0o600 });
  const exitCode = result.status ?? 1;
  const stderr = result.stderr ?? "";
  return { exitCode, log, sha256: digest(output),
    timedOut: Boolean(result.error) || (exitCode === TIMED_OUT_EXIT && stderr.includes(TIMED_OUT_MARKER)),
    spawnFailed: exitCode === WRAPPER_FAILED_EXIT && SPAWN_FAILURE.test(stderr) };
}

/** Every evidence log a comparison names, for the same digest check the command logs get at consumption. */
export function comparisonLogs(comparison: MainComparison) {
  return [...comparison.sessionRuns.map((run) => ({ log: run.log, sha256: run.sha256 })),
    ...(comparison.main.log && comparison.main.sha256 ? [{ log: comparison.main.log, sha256: comparison.main.sha256 }] : [])];
}

/**
 * The same check on main. A selector relative to the session's own diff (the affected typecheck wrapper and the
 * pinned Turbo filter) would select different packages there, so main runs that task over the packages the session selected.
 */
export function capturedMainArgv(root: string, mainSha: string, command: CheckCommand, selection: Selection | undefined):
  { argv: string[] } | { reason: string } {
  const words = command.argv;
  let task: string | undefined;
  let rest: string[] = [];
  if (words.join(" ") === "pnpm typecheck:affected") { task = "typecheck"; rest = ["--concurrency=1"]; }
  else if (words[0] === "pnpm" && words[1] === "turbo" && words.slice(3).some((word) => PINNED_FILTER.test(word))) {
    task = words[2];
    rest = words.slice(3).filter((word) => !PINNED_FILTER.test(word));
  }
  if (task) {
    const packages = [...new Set((selection?.tasks ?? []).filter((item) => item.taskId.endsWith(`#${task}`))
      .map((item) => item.package ?? item.taskId.slice(0, item.taskId.lastIndexOf("#"))))].sort();
    if (!packages.length) return { reason: "the session's selected tasks are not available to pin the same check on captured main" };
    return { argv: ["pnpm", "turbo", task, ...packages.map((name) => `--filter=${name}`), ...rest] };
  }
  if (words[0] === "pnpm" && words[1] === "exec" && words[2] === "biome" && words[3] === "check") {
    for (const path of words.slice(4)) {
      try { git(root, ["cat-file", "-e", `${mainSha}:${path}`]); }
      catch { return { reason: `the checked file ${path} does not exist on captured main` }; }
    }
  }
  return { argv: [...words] };
}

// run-bounded.mjs's own signals: exit 124 with its stop line, or exit 2 with the spawn error it caught.
const TIMED_OUT_EXIT = 124;
const TIMED_OUT_MARKER = "run-bounded: stopped after";
const WRAPPER_FAILED_EXIT = 2;
const SPAWN_FAILURE = /^spawn \S+ E[A-Z]+\s*$/m;

function runBoundedScript() {
  // Bundled into skills/vibe/scripts/dist/, beside the plugin's own run-bounded.mjs one directory up.
  const script = fileURLToPath(new URL("../run-bounded.mjs", import.meta.url));
  if (!existsSync(script)) throw new MainSyncError("The plugin's run-bounded.mjs is missing; no comparison was run");
  return script;
}
