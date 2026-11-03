import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { startCodexAppServer } from "../../shared/codex-app-server-client.mjs";
import type { CodexAppServerClient } from "../../shared/codex-app-server-client.mjs";
import { labelWorkerThread, WORKER_THREAD_SOURCE } from
  "../../shared/thread-sidebar.mjs";
import type { EvalCaseResult, EvalSuiteResult } from "./eval-collector.ts";
import type { EvalRuntime } from "./eval-policy.ts";
import type { EvalCaseDefinition, ReleaseReference, UpgradeTransition } from "./eval-selection.ts";
import { archivePluginRelease, archiveSnapshotTarget, snapshotPluginVersion } from "./plugin-snapshot.ts";
import type { PluginReleaseArchive } from "./plugin-snapshot.ts";
import type { PluginSnapshot } from "./plugin-snapshot.ts";
import { runOwnedProcess } from "./owned-process.ts";
import { writeBenchmarkSessionRecord } from "./session-preflight.ts";

export const STATEFUL_CLAUDE_ROOT_TIMEOUT_MS = 1_200_000;
export const CLAUDE_WRITER_TIMEOUT_MS = 900_000;
export const APP_SERVER_COMMAND_TIMEOUT_MS = 120_000;
export const CODEX_STATEFUL_ROOT_TIMEOUT_MS = 1_800_000;

const CODEX_MARKETPLACE = "closedloop-ai";
const CODEX_PLUGIN_SELECTOR = `vibe@${CODEX_MARKETPLACE}`;
const CODEX_CORE_SELECTOR = `closedloop-core@${CODEX_MARKETPLACE}`;
const PROOF_FILE = "upgrade-resume-proof.txt";

const REQUIRED_GRAPH_OPERATIONS = ["get_routing_protocol", "code_projects", "code_symbols",
  "code_callers", "code_importers", "blast_radius_tickets", "code_grep", "code_snippet",
  "code_tests_for"] as const;

export const UPGRADE_GRAPH_CAPABILITIES = REQUIRED_GRAPH_OPERATIONS.map((operation) => ({
  name: `mcp__closedloop-graph__${operation}`, service: "graph" as const,
  access: "read" as const, operation,
}));

/** Refuse an incomplete parent-discovered graph grant before constructing a worker payload. */
export function validateUpgradeCapabilities(capabilities: readonly { operation: string }[]): void {
  const operations = new Set(capabilities.map((item) => item.operation));
  if (REQUIRED_GRAPH_OPERATIONS.some((operation) => !operations.has(operation))) {
    throw new Error("eval-stateful-graph-capabilities-missing");
  }
}

export type UpgradeFailureCode = "STALE_PLUGIN_ROOT" | "MODEL_BLOCK" | "AUTH_UNAVAILABLE" |
  "MODEL_UNAVAILABLE" | "SANDBOX_REFUSAL" | "TIMEOUT" | "INSTALL_INVALID" |
  "WRONG_SESSION" | "ORACLE_MISMATCH";

const INFRASTRUCTURE_FAILURE_CODES = new Set<UpgradeFailureCode>([
  "AUTH_UNAVAILABLE", "INSTALL_INVALID", "MODEL_UNAVAILABLE", "TIMEOUT", "SANDBOX_REFUSAL",
]);

export interface UpgradeCaseEvidence {
  caseId: string;
  runtime: EvalRuntime;
  passed: boolean;
  failureCode: UpgradeFailureCode | null;
  wallMs: number;
  agentCostUsd: number | null;
  tokens: Record<string, number> | null;
  cliVersion: string;
  target: ReleaseReference;
  prior: ReleaseReference;
  oldArchiveRetained: boolean;
  proofLines: string[];
  rootSessionId: string;
  previousWriterId: string | null;
  finalWriterId: string | null;
  migrationCount: number;
  trace: string[];
  /** Aggregate result only: each selected historical cell and the current subject's disposition. */
  transitionResults?: UpgradeTransitionResult[];
}

/** Distinguish a fixed historical proof from the release currently under test. */
interface UpgradeTransitionResult {
  role: "historical" | "current";
  target: ReleaseReference;
  expected: "pass" | "fail";
  observed: "pass" | "fail";
  matched: boolean;
  failureCode: UpgradeFailureCode | null;
}

export interface UpgradeResumeRunInput {
  repo: string;
  pluginSha: string;
  currentSnapshot: PluginSnapshot;
  runRoot: string;
  claudeExecutable: string;
  codexExecutable: string;
  cases: EvalCaseDefinition[];
  runtimes: EvalRuntime[];
  targetRef?: string;
  signal?: AbortSignal;
}

export interface UpgradeResumeRunner {
  run(input: UpgradeResumeRunInput): Promise<Partial<Record<EvalRuntime, EvalSuiteResult>>>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function caseResult(evidence: UpgradeCaseEvidence): EvalCaseResult {
  return { id: evidence.caseId, passed: evidence.passed,
    failedGraders: evidence.failureCode ? [evidence.failureCode] : [], skippedGraders: [] };
}

/** A known-bad product failure is expected; infrastructure failure never is. */
export function scoreUpgradeTransitions(items: Array<{ role: "historical" | "current";
  expected: "pass" | "fail"; evidence: Pick<UpgradeCaseEvidence,
    "target" | "passed" | "failureCode" | "proofLines" | "previousWriterId" |
    "migrationCount"> }>): {
  passed: boolean; failureCode: UpgradeFailureCode | null; transitions: UpgradeTransitionResult[];
} {
  const currentCount = items.filter((item) => item.role === "current").length;
  const stoppedForInfrastructure = items.some((item) => item.evidence.failureCode !== null &&
    INFRASTRUCTURE_FAILURE_CODES.has(item.evidence.failureCode));
  if (currentCount > 1 || (currentCount === 0 && (items.length !== 1 ||
      items[0]?.role !== "historical") && !stoppedForInfrastructure)) {
    throw new Error("eval-stateful-current-transition-invalid");
  }
  const transitions = items.map((item): UpgradeTransitionResult => {
    const observed = item.evidence.passed ? "pass" : "fail";
    const expectedSecondTurnFailure = item.expected === "fail" &&
      item.evidence.proofLines.join("\n") === "turn-one" &&
      item.evidence.previousWriterId !== null && item.evidence.migrationCount === 0 &&
      (item.evidence.failureCode === "MODEL_BLOCK" || item.evidence.failureCode === "STALE_PLUGIN_ROOT");
    return { role: item.role, target: item.evidence.target, expected: item.expected,
      observed, matched: item.expected === observed && (item.expected !== "fail" ||
        expectedSecondTurnFailure) && !(item.evidence.failureCode !== null &&
          INFRASTRUCTURE_FAILURE_CODES.has(item.evidence.failureCode)),
      failureCode: item.evidence.failureCode };
  });
  const failure = transitions.find((item) => item.failureCode !== null &&
    INFRASTRUCTURE_FAILURE_CODES.has(item.failureCode)) ??
    transitions.find((item) => !item.matched);
  return { passed: !failure, failureCode: failure?.failureCode ??
    (failure ? "ORACLE_MISMATCH" : null), transitions };
}

/** Convert stateful evidence into the existing native suite shape without new result fields. */
export function statefulSuite(runtime: EvalRuntime, evidence: UpgradeCaseEvidence[]): EvalSuiteResult {
  const cases = evidence.map(caseResult).sort((left, right) => left.id.localeCompare(right.id));
  const passed = cases.filter((item) => item.passed).length;
  const agentValues = evidence.map((item) => item.agentCostUsd);
  const agentCostUsd = runtime === "claude" && agentValues.every((value) => value !== null)
    ? agentValues.reduce((sum, value) => sum + (value ?? 0), 0) : null;
  const tokens = runtime === "codex" && evidence.every((item) => item.tokens !== null)
    ? evidence.reduce<Record<string, number>>((totals, item) => {
      for (const [key, value] of Object.entries(item.tokens ?? {})) totals[key] = (totals[key] ?? 0) + value;
      return totals;
    }, {}) : null;
  const payload = { runtime, cliVersion: evidence[0]?.cliVersion ?? "unknown", cases, passed,
    failed: cases.length - passed, wallMs: evidence.reduce((sum, item) => sum + item.wallMs, 0),
    agentCostUsd, judgeCostUsd: runtime === "claude" ? 0 : null,
    costUsd: runtime === "claude" && agentCostUsd !== null ? agentCostUsd : null, tokens };
  return { ...payload, nativeHash: hash({ payload, evidence }) };
}

/** Convert infrastructure evidence into the ordinary runner's invalid-runtime contract. */
export function statefulInfrastructureInvalidReason(suite: EvalSuiteResult): string | null {
  for (const item of suite.cases) {
    const code = !item.passed && item.failedGraders.find((grader): grader is UpgradeFailureCode =>
      INFRASTRUCTURE_FAILURE_CODES.has(grader as UpgradeFailureCode));
    if (code) return `eval-stateful-infrastructure:${code}:${item.id}`;
  }
  return null;
}

/** Merge disjoint ordinary and stateful cases while preserving existing per-runtime metrics. */
export function mergeEvalSuiteResults(ordinary: EvalSuiteResult | null,
  stateful: EvalSuiteResult | null, selectedCases: string[]): EvalSuiteResult | null {
  if (!ordinary) return stateful;
  if (!stateful) return ordinary;
  if (ordinary.runtime !== stateful.runtime || ordinary.cliVersion !== stateful.cliVersion) {
    throw new Error("eval-stateful-suite-identity-mismatch");
  }
  const cases = [...ordinary.cases, ...stateful.cases].sort((left, right) => left.id.localeCompare(right.id));
  if (cases.map((item) => item.id).join("\0") !== [...selectedCases].sort().join("\0") ||
      new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("eval-stateful-suite-coverage-mismatch");
  }
  const nullableSum = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left + right;
  const tokens = ordinary.tokens && stateful.tokens
    ? Object.fromEntries([...new Set([...Object.keys(ordinary.tokens), ...Object.keys(stateful.tokens)])]
      .map((key) => [key, (ordinary.tokens?.[key] ?? 0) + (stateful.tokens?.[key] ?? 0)])) : null;
  const passed = cases.filter((item) => item.passed).length;
  const payload = { runtime: ordinary.runtime, cliVersion: ordinary.cliVersion, cases, passed,
    failed: cases.length - passed, wallMs: ordinary.wallMs + stateful.wallMs,
    agentCostUsd: nullableSum(ordinary.agentCostUsd, stateful.agentCostUsd),
    judgeCostUsd: nullableSum(ordinary.judgeCostUsd, stateful.judgeCostUsd),
    costUsd: nullableSum(ordinary.costUsd, stateful.costUsd), tokens };
  return { ...payload, nativeHash: hash({ ordinary: ordinary.nativeHash,
    stateful: stateful.nativeHash, payload }) };
}

function transitionFor(item: EvalCaseDefinition, targetRef: string | undefined,
  subject: ReleaseReference): UpgradeTransition {
  if (item.kind !== "upgrade-resume" || !item.nightlyPrior || !item.transitions) {
    throw new Error("eval-stateful-case-invalid");
  }
  if (targetRef) {
    const fixed = item.transitions.find((candidate) => candidate.target.ref === targetRef);
    if (!fixed) throw new Error(`eval-stateful-target-unsupported:${targetRef}`);
    return fixed;
  }
  return { target: subject, prior: item.nightlyPrior };
}

/** Expand immutable release proofs while keeping the current subject as the only nightly pass gate. */
export function upgradeTransitionPlan(item: EvalCaseDefinition, runtime: EvalRuntime,
  subject: ReleaseReference, targetRef?: string, currentRef = subject.ref): Array<{
    role: "historical" | "current"; expected: "pass" | "fail"; transition: UpgradeTransition;
  }> {
  if (item.kind !== "upgrade-resume" || !item.transitions || !item.nightlyPrior) {
    throw new Error("eval-stateful-case-invalid");
  }
  if (targetRef && targetRef !== currentRef) {
    const fixed = transitionFor(item, targetRef, subject);
    return [{ role: "historical", expected: fixed.expected?.[runtime] ?? "pass",
      transition: fixed }];
  }
  return [...item.transitions.filter((fixed) => fixed.target.ref !== subject.ref)
    .map((fixed) => ({ role: "historical" as const,
      expected: fixed.expected?.[runtime] ?? "pass", transition: fixed })),
  { role: "current", expected: "pass", transition: {
    target: subject, prior: item.nightlyPrior } }];
}

function manifestVersion(repo: string, ref: string): string {
  const raw = execFileSync("git", ["-C", repo, "show",
    `${ref}:plugins/vibe/.claude-plugin/plugin.json`], { encoding: "utf8" });
  const value = JSON.parse(raw) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error("eval-stateful-target-version-invalid");
  return value.version;
}

/** The current subject uses candidate metadata while a fixed historical target uses its Git ref. */
export function upgradeSubject(input: { repo: string; targetRef: string; pluginSha: string;
  currentSnapshot: PluginSnapshot }): ReleaseReference {
  if (input.currentSnapshot.sha !== input.pluginSha) throw new Error("eval-current-snapshot-identity-invalid");
  return { ref: input.targetRef, version: input.targetRef === input.pluginSha
    ? snapshotPluginVersion(input.currentSnapshot) : manifestVersion(input.repo, input.targetRef) };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture(root: string, release: PluginReleaseArchive, caseId: string) {
  const worktree = join(root, "worktree");
  const remote = join(root, "closedloop-ai", "symphony-alpha.git");
  mkdirSync(dirname(remote), { recursive: true });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  mkdirSync(worktree);
  execFileSync("git", ["init", "-b", "main", worktree], { stdio: "ignore" });
  writeFileSync(join(worktree, "package.json"), `${JSON.stringify({
    name: "upgrade-resume-fixture", private: true, engines: { node: ">=24" },
  }, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(worktree, PROOF_FILE), "", { flag: "wx" });
  git(worktree, "add", PROOF_FILE, "package.json");
  git(worktree, "-c", "user.name=vibe-eval", "-c", "user.email=vibe-eval@invalid.local",
    "commit", "-m", "test: seed upgrade resume proof");
  git(worktree, "remote", "add", "origin", remote);
  const base = git(worktree, "rev-parse", "HEAD");
  const branch = `benchmark/${caseId}`;
  git(worktree, "switch", "-c", branch);
  await writeBenchmarkSessionRecord(release.claudeVibeRoot, worktree, branch, "seeded", base);
  const record = JSON.parse(readFileSync(join(worktree, ".git", "vibe-session.json"), "utf8")) as Record<string, unknown>;
  Object.assign(record, { summary: `Upgrade resume ${caseId}`, ticket: "ISS-13512",
    liveTicket: "ISS-13512" });
  writeFileSync(join(worktree, ".git", "vibe-session.json"), `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 });
  return { worktree: realpathSync(worktree), branch, sessionSlug: caseId,
    requestOne: `${caseId}-one`, requestTwo: `${caseId}-two` };
}

function writerLedger(worktree: string): Record<string, any> | null {
  const path = join(worktree, ".git", "vibe-writer.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, any> : null;
}

function ledgerCompletedRequest(ledger: Record<string, any> | null, requestId: string): boolean {
  return Array.isArray(ledger?.completed) && ledger.completed.includes(requestId) &&
    !ledger.active && Array.isArray(ledger.pending) &&
    !ledger.pending.some((item: { id?: unknown }) => item.id === requestId);
}

/** Admit one root-owned recovery only from the untouched exact stale boundary. */
export function claudeStaleRecoveryEligible(input: { exitCode: number | null; terminalText: string;
  requestId: string; oldWriterId: string; proofLines: string[]; oldArchiveRetained: boolean;
  staleToolResult?: boolean; ledger: Record<string, any> | null }): boolean {
  const ledger = input.ledger;
  const terminal = input.terminalText.trim();
  const staleRefusal = terminal === "STALE_PLUGIN_ROOT" ||
    (input.staleToolResult === true && /\bSTALE_PLUGIN_ROOT\b/.test(terminal) &&
      !/\bNEEDS_PERSON\b|(?:requires?|needs?|awaits?) (?:human|user) action|ask(?:ing)? the (?:person|user)/i
        .test(terminal));
  return input.exitCode === 0 && staleRefusal &&
    input.oldArchiveRetained && input.proofLines.join("\n") === "turn-one" &&
    ledger?.runtime === "claude" && ledger.workerId === input.oldWriterId && !ledger.active &&
    Array.isArray(ledger.migrations) && ledger.migrations.length === 0 &&
    Array.isArray(ledger.completed) && !ledger.completed.includes(input.requestId) &&
    Array.isArray(ledger.pending) && ledger.pending.length === 1 &&
    ledger.pending[0]?.id === input.requestId;
}

/** Ask the same root to own its production recovery decision without supplying migration inputs. */
export function claudeStaleRecoveryPrompt(input: { requestId: string;
  sessionSlug: string }): string {
  if (!input.requestId || !input.sessionSlug) throw new Error("eval-stateful-stale-recovery-input-invalid");
  return `/vibe:vibe\n\nContinue only vibe session ${input.sessionSlug}. Exact request ` +
    `${input.requestId} is already queued. Continue the vibe skill's internal stale-root recovery: ` +
    `re-read production writer status, decide and run the supported recovery, then launch and finish ` +
    `that exact request. The previous command-shape rejection changed no writer state. Use a ` +
    `single literal JSON-on-stdin pipeline for each Bash call; do not assign a shell variable, ` +
    `use command substitution, or combine commands in one call. Do not ask to change the eval hook. ` +
    `Do not read references, list scripts, diagnose, list or create sessions, or ask the person.`;
}

function proofLines(worktree: string): string[] {
  return readFileSync(join(worktree, PROOF_FILE), "utf8").split("\n").filter(Boolean);
}

/** Queue the second request through the released stdin-only production contract. */
export function enqueueUpgradeRequest(vibeRoot: string, input: { worktree: string; workerId: string;
  requestId: string; text: string }): Record<string, unknown> {
  const script = realpathSync(join(vibeRoot, "skills/vibe/scripts/dist/writer-state.mjs"));
  const output = execFileSync(process.execPath, [script, "enqueue"], { encoding: "utf8",
    input: JSON.stringify({ worktree: input.worktree, workerId: input.workerId,
      requestId: input.requestId, input: input.text }) });
  const result = JSON.parse(output) as Record<string, unknown>;
  if (result.workerId !== input.workerId) throw new Error("eval-stateful-enqueue-identity-mismatch");
  return result;
}

/** Classify terminal errors; narrative mentions of a plugin or version are not installer failures. */
export function classifyUpgradeFailure(error: unknown): UpgradeFailureCode {
  const text = error instanceof Error ? error.message : String(error);
  if (/STALE_PLUGIN_ROOT|stale installed plugin/i.test(text)) return "STALE_PLUGIN_ROOT";
  if (/\bserverOverloaded\b|selected model is at capacity/i.test(text)) return "MODEL_UNAVAILABLE";
  if (/\bAUTH_UNAVAILABLE\b|\bCLAUDE_SIGN_IN_NEEDED\b|failed to authenticate|not signed in|sign[- ]?in required|credentials? (?:missing|unavailable|refused)/i.test(text)) {
    return "AUTH_UNAVAILABLE";
  }
  if (/sandbox|approval|permission/i.test(text)) return "SANDBOX_REFUSAL";
  if (/timed out|deadline|TIMEOUT/i.test(text)) return "TIMEOUT";
  if (/\bENOENT\b|\bMCP_TOOLS_MISSING\b|eval-stateful-graph-capabilities-missing|command not found|executable (?:is )?missing/i.test(text)) {
    return "INSTALL_INVALID";
  }
  if (/\bINSTALL_INVALID\b|\beval-stateful-(?:codex-)?(?:install|manifest|cache|marketplace|version)[\w:-]*\b|\b(?:manifest|cache|marketplace) (?:is )?(?:missing|invalid|corrupt)\b|\bCommand failed:.*\bcodex plugin (?:add|marketplace add)\b/i.test(text)) {
    return "INSTALL_INVALID";
  }
  if (/\bWRONG_SESSION\b|\beval-stateful-claude-session-invalid\b|\b(?:session|thread|worktree) (?:id )?(?:mismatch|invalid)\b|\b(?:wrong|different|mismatched) (?:root )?(?:session|thread|worktree)\b/i.test(text)) {
    return "WRONG_SESSION";
  }
  if (/WORKER_TURN_FAILED|MODEL_BLOCK|BLOCKED|NEEDS_PERSON/i.test(text)) return "MODEL_BLOCK";
  return "ORACLE_MISMATCH";
}

/** Use only the last completed native turn, so an earlier recovered capacity error cannot mask a later oracle failure. */
export function codexServerFailure(trace: string[]): UpgradeFailureCode | null {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const line = trace[index];
    if (!line?.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { method?: string; params?: { turn?: {
        status?: string; error?: { codexErrorInfo?: string } } } };
      if (event.method !== "turn/completed") continue;
      return event.params?.turn?.status === "failed" &&
        event.params.turn.error?.codexErrorInfo === "serverOverloaded"
        ? "MODEL_UNAVAILABLE" : null;
    } catch { /* Bounded trace lines and non-JSON output are not native turn evidence. */ }
  }
  return null;
}

function boundedTrace(lines: string[], limit = 200, lineBytes = 4_000): string[] {
  return lines.slice(-limit).map((line) => Buffer.byteLength(line) <= lineBytes
    ? line : `${Buffer.from(line).subarray(0, lineBytes).toString("utf8")}…`);
}

/** Preserve the complete Claude process result before any bounded display trace is made. */
export function recordClaudeTurnOutput(root: string, label: string,
  result: { exitCode: number | null; stdout: string; stderr: string }): string {
  if (!/^(turn-one|turn-two|stale-recovery)$/.test(label)) {
    throw new Error("eval-stateful-claude-turn-label-invalid");
  }
  const path = join(root, `${label}.terminal.json`);
  writeFileSync(path, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** The released Claude launcher resolves `claude` on PATH inside its Bash child. */
export function claudeRootEnvironment(executable: string,
  base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(executable)) throw new Error("eval-stateful-claude-executable-not-absolute");
  const env: NodeJS.ProcessEnv = { ...base,
    PATH: [dirname(executable), base.PATH].filter(Boolean).join(":") };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/** Build the one literal production migration command from the recorded writer binding. */
export function claudeMigrationCommand(input: { worktree: string; agentRoot: string;
  previousWorkerId: string; previousDigest: string }): string {
  if (!isAbsolute(input.worktree) || !isAbsolute(input.agentRoot) ||
      !input.previousWorkerId || !/^[a-f0-9]{64}$/.test(input.previousDigest) ||
      Object.values(input).some((value) => /['\r\n]/.test(value))) {
    throw new Error("eval-stateful-claude-migration-input-invalid");
  }
  const payload = { worktree: input.worktree, runtime: "claude", agentRoot: input.agentRoot,
    agentName: "vibe-change-worker", previousWorkerId: input.previousWorkerId,
    previousDigest: input.previousDigest };
  return `printf '%s\\n' '${JSON.stringify(payload)}' | node ` +
    `'${join(input.agentRoot, "skills/vibe/scripts/dist/writer-state.mjs")}' migrate`;
}

/** Give the root exact production commands while leaving the released skill in control of the turn. */
export function rootPrompt(input: { fixture: Awaited<ReturnType<typeof fixture>>; requestId: string;
  marker: string; continuation: boolean; vibeRoot: string; runtime: EvalRuntime;
  migration?: { previousWorkerId: string; previousDigest: string } }): string {
  const action = `Append exactly ${JSON.stringify(input.marker)} plus one newline to ${PROOF_FILE}.`;
  const queue = input.continuation
    ? `Request ${input.requestId} is already queued; claim and finish that request, and never report an older request as this request.`
    : `Request ${input.requestId} is new; use the normal production root path to launch or resume the persistent writer for it.`;
  validateUpgradeCapabilities(UPGRADE_GRAPH_CAPABILITIES);
  const launchPayload = { worktree: input.fixture.worktree, agentName: "vibe-change-worker",
    mode: "request", requestId: input.requestId, capabilities: UPGRADE_GRAPH_CAPABILITIES,
    ...(input.continuation ? {} : { input: action }) };
  const migrationInstruction = input.runtime === "claude" && input.continuation && input.migration
    ? `The definition changed. After status and before the launcher, run exactly ` +
      `${claudeMigrationCommand({ worktree: input.fixture.worktree, agentRoot: input.vibeRoot,
        ...input.migration })}. This command already has every required field. Do not construct ` +
      `another migration payload or use shell variables. ` : "";
  const runtimeInstruction = input.runtime === "claude"
    ? `${input.continuation ? "" : "Status null means no writer exists, so launch fresh now. "}` +
      `${migrationInstruction}Do not read references, list scripts, or diagnose. ` +
      `Use exactly printf '%s\\n' '${JSON.stringify(launchPayload)}' | node ` +
      `'${join(input.vibeRoot, "skills/vibe/scripts/dist/claude-worker.mjs")}'.`
    : `Status null means no writer exists, so spawn the canonical native vibe-change-worker now with its ` +
      `documented read-only HOLD brief. HOLD is internal: after that exact child returns HOLD, continue in this ` +
      `same root turn when possible, register and claim the exact returned worker id, take the queued request, ` +
      `and follow up that same worker context until it finishes. Never report HOLD to the harness, spawn a second ` +
      `writer, or substitute another child id. Do not invoke claude-worker.mjs, read references, list scripts, or ` +
      `diagnose. Bind these exact read-only graph capabilities when registering the actual native writer: ` +
      `${JSON.stringify(UPGRADE_GRAPH_CAPABILITIES)}.`;
  return `${input.continuation ? "Resume" : "Start"} only the recorded vibe session ` +
    `${input.fixture.sessionSlug} in ${input.fixture.worktree} for live ticket ISS-13512 and request ` +
    `${input.requestId}. Do not list sessions, guess, create another session, create a ticket, deploy, ` +
    `commit, push, or ask a question. Skip version checking, requirements, setup, preflight, environment, ` +
    `plan publication, checks, review, and handoff. Use only the production writer status, migration, and ` +
    `launch or native-resume boundaries needed for this request. The harness already completed the required ` +
    `plugin version check for this exact root session and recorded the opening-message proceed decision when required. ` +
    `Do not run plugin-version.mjs check or choose. ` +
    `The writer-state CLI takes the action as its only positional argument and the JSON payload on stdin. ` +
    `For status, use exactly printf '%s\\n' '${JSON.stringify({ worktree: input.fixture.worktree })}' | ` +
    `node '${join(input.vibeRoot, "skills/vibe/scripts/dist/writer-state.mjs")}' status. ` +
    `Never pass --worktree or another flag to writer-state.mjs. ${queue} ` +
    `${runtimeInstruction} ` +
    `This is an authorized isolated upgrade-resume eval. ${action} ` +
    `Use the session's one persistent vibe-change-worker and report DONE after the edit.`;
}

function claudeEvents(stdout: string): Record<string, any>[] {
  return stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as Record<string, any>; }
    catch { throw new Error("eval-stateful-claude-stream-invalid"); }
  });
}

/** Accept only the released launcher's exact stale refusal for this queued request. */
export function claudeStaleToolResult(stdout: string, requestId: string): boolean {
  for (const event of claudeEvents(stdout)) {
    if (event.type !== "user" || !Array.isArray(event.message?.content)) continue;
    for (const item of event.message.content) {
      if (item?.type !== "tool_result") continue;
      const chunks = typeof item.content === "string" ? [item.content] :
        Array.isArray(item.content) ? item.content.flatMap((chunk: { text?: unknown }) =>
          typeof chunk.text === "string" ? [chunk.text] : []) : [];
      for (const chunk of chunks) for (const line of chunk.split("\n")) {
        try {
          const record = JSON.parse(line.replace(/^\s*\d+\s+/, "")) as Record<string, unknown>;
          if (record.status === "BLOCKED" && record.code === "STALE_PLUGIN_ROOT" &&
              record.requestId === requestId && record.leaseRetained === false) return true;
        } catch { /* Non-JSON tool output is not a production stale-root signal. */ }
      }
    }
  }
  return false;
}

/** Read the complete terminal result before classifying a first-turn failure. */
export function claudeTurnFailureText(result: { exitCode: number | null; stdout: string;
  stderr: string }): string {
  const terminal = claudeEvents(result.stdout).flatMap((event) => event.type === "result" &&
    typeof event.result === "string" ? [event.result] : []).at(-1) ?? "";
  return [terminal, result.stderr].filter(Boolean).join("\n");
}

function appServerTerminalText(trace: string[]): string {
  const messages = trace.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const event = JSON.parse(line) as { params?: { item?: { type?: string; text?: string };
        turn?: { items?: Array<{ type?: string; text?: string; phase?: string }> } } };
      const direct = event.params?.item;
      const nested = event.params?.turn?.items ?? [];
      return [...(direct?.type === "agentMessage" && typeof direct.text === "string"
        ? [direct.text] : []), ...nested.flatMap((item) => item.type === "agentMessage" &&
          typeof item.text === "string" && item.phase === "final_answer" ? [item.text] : [])];
    } catch { return []; }
  });
  return messages.at(-1) ?? "";
}

/** Build one exact Claude root invocation so turn two can only resume turn one's root identity. */
export function claudeUpgradeRootArgs(input: { release: PluginReleaseArchive; settings: string;
  rootSessionId: string; prompt: string; resume: boolean; caseId: string }): string[] {
  if (!/^[0-9a-f-]{36}$/.test(input.rootSessionId)) throw new Error("eval-stateful-claude-session-invalid");
  return ["--print", "--output-format", "stream-json", "--verbose", "--setting-sources", "",
    "--settings", input.settings, "--plugin-dir", input.release.claudeCoreRoot,
    "--plugin-dir", input.release.claudeVibeRoot, "--model", "claude-sonnet-5-5",
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--name",
    `vibe upgrade resume · ${input.caseId}`, "--allowedTools", "Bash",
    input.resume ? "--resume" : "--session-id",
    input.rootSessionId, input.prompt];
}

function writeClaudeRootSettings(root: string, worktree: string,
  releases: PluginReleaseArchive[]): string {
  const gateConfig = join(root, "claude-root-command-gate.json");
  const scripts = releases.flatMap((release) => ["writer-state.mjs", "claude-worker.mjs"]
    .map((name) => realpathSync(join(release.claudeVibeRoot, "skills/vibe/scripts/dist", name))));
  writeFileSync(gateConfig, `${JSON.stringify({ worktree, scripts }, null, 2)}\n`, { mode: 0o600 });
  const gate = fileURLToPath(new URL("./claude-root-command-gate.ts", import.meta.url));
  const settings = join(root, "claude-settings.json");
  writeFileSync(settings, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{
    type: "command", command: process.execPath,
    args: ["--experimental-strip-types", gate, gateConfig], timeout: 10,
  }] }] } }, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

/** Final deterministic identity and proof oracle shared by both runtime adapters. */
export function upgradeCasePasses(input: { runtime: EvalRuntime; definition: "unchanged" | "changed";
  previousWriterId: string | null; finalWriterId: string | null; migrationCount: number;
  proofLines: string[]; terminalText: string; requestCompleted: boolean;
  oldArchiveRetained: boolean }): boolean {
  const identity = input.runtime === "claude" && input.definition === "unchanged"
    ? input.previousWriterId !== null && input.finalWriterId === input.previousWriterId &&
      input.migrationCount === 0
    : input.previousWriterId !== null && input.finalWriterId !== null &&
      input.finalWriterId !== input.previousWriterId && input.migrationCount === 1;
  const terminal = input.terminalText.trim();
  const refusal = /^(?:BLOCKED|NEEDS_PERSON|FAILED)(?:\b|[.:])/i.test(terminal) ||
    /\bNEEDS_PERSON\b/i.test(terminal) ||
    /(?:requires?|needs?|awaits?) (?:human|user) action|ask(?:ing)? the (?:person|user)/i
      .test(terminal);
  const recoveredStale = /STALE_PLUGIN_ROOT|stale installed plugin/i.test(terminal);
  const terminalAccepted = !refusal && (!recoveredStale || /^DONE(?:\b|[.:])/i.test(terminal));
  return identity && input.requestCompleted && input.oldArchiveRetained &&
    input.proofLines.join("\n") === "turn-one\nturn-two" && terminalAccepted;
}

async function fixtureVersionServer(latest: PluginReleaseArchive): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const files = new Map([
    ["/.claude-plugin/marketplace.json", join(latest.archiveRoot, ".claude-plugin/marketplace.json")],
    ["/plugins/vibe/.claude-plugin/plugin.json",
      join(latest.vibeDir, ".claude-plugin/plugin.json")],
    ["/plugins/closedloop-core/.claude-plugin/plugin.json",
      join(latest.coreDir, ".claude-plugin/plugin.json")],
  ]);
  const server = createServer((request, response) => {
    const file = files.get(request.url ?? "");
    if (!file) { response.writeHead(404).end("not found"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => error ? reject(error) : resolvePromise())) };
}

interface ClaudeVersionCleanupTarget {
  root: string;
  rootSessionId: string;
  home: string;
}

const claudeVersionCleanupTargets = new Map<string, ClaudeVersionCleanupTarget>();
let claudeVersionCleanupHandlersInstalled = false;

function claudeVersionCleanupKey(target: ClaudeVersionCleanupTarget): string {
  return `${target.home}\0${target.root}\0${target.rootSessionId}`;
}

function installClaudeVersionCleanupHandlers(): void {
  if (claudeVersionCleanupHandlersInstalled) return;
  claudeVersionCleanupHandlersInstalled = true;
  process.on("exit", () => cleanupClaudeVersionRecordsForSignal("exit"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      cleanupClaudeVersionRecordsForSignal(signal);
      process.removeListener(signal, handler);
      if (Number.isInteger(process.pid) && process.pid > 1) process.kill(process.pid, signal);
      else process.exitCode = signal === "SIGINT" ? 130 : 143;
    };
    process.on(signal, handler);
  }
}

function registerClaudeVersionCleanup(target: ClaudeVersionCleanupTarget): void {
  installClaudeVersionCleanupHandlers();
  claudeVersionCleanupTargets.set(claudeVersionCleanupKey(target), target);
}

/** Remove every registered exact record on ordinary exit or a catchable termination signal. */
export function cleanupClaudeVersionRecordsForSignal(_signal: "SIGINT" | "SIGTERM" | "exit"): void {
  for (const target of [...claudeVersionCleanupTargets.values()]) {
    try { cleanupClaudeVersionRecords(target.root, target.rootSessionId, target.home); }
    catch { /* The next ordinary cleanup retains the same exact target for another attempt. */ }
  }
}

/** Create one released startup contract and register its exact owned cleanup paths. */
export async function prepareClaudeVersionRecord(input: { release: PluginReleaseArchive;
  latestBase: string; root: string; rootSessionId: string; refresh?: boolean;
  home?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const home = input.home ?? homedir();
  const startup = join(home, ".codex/vibe/plugin-version", `${input.rootSessionId}.json`);
  const hook = join(home, ".vibe-hook-scope", `${input.rootSessionId}.json`);
  if (!input.refresh && (existsSync(startup) || existsSync(hook))) {
    throw new Error("eval-stateful-version-record-collision");
  }
  registerClaudeVersionCleanup({ root: input.root, rootSessionId: input.rootSessionId, home });
  try { return await writeClaudeVersionRecord(input); }
  catch (error) {
    cleanupClaudeVersionRecords(input.root, input.rootSessionId, home);
    throw error;
  }
}

async function writeClaudeVersionRecord(input: { release: PluginReleaseArchive;
  latestBase: string; root: string; rootSessionId: string; refresh?: boolean;
  home?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const scripts = join(input.release.claudeVibeRoot, "skills/vibe/scripts");
  const pluginVersion = realpathSync(join(scripts, "plugin-version.mjs"));
  const loadedSkill = join(scripts, "loaded-skill.mjs");
  const hasLoadedSkill = existsSync(loadedSkill);
  const home = input.home ?? homedir();
  const startup = join(home, ".codex/vibe/plugin-version", `${input.rootSessionId}.json`);
  const hook = join(home, ".vibe-hook-scope", `${input.rootSessionId}.json`);
  if (existsSync(startup) || existsSync(hook)) {
    if (!input.refresh) throw new Error("eval-stateful-version-record-collision");
    rmSync(startup, { force: true });
    rmSync(hook, { force: true });
  }
  if (hasLoadedSkill) {
    const loadedModule = await import(pathToFileURL(loadedSkill).href) as {
      LoadBasis: { HookObserved: string };
      loadedSkillEvidence(actorId: string, runtime: string, pluginRoot: string,
        skill: string, basis: string): unknown;
    };
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `${JSON.stringify({ sessionId: input.rootSessionId,
      skill: "vibe", loadedSkill: loadedModule.loadedSkillEvidence(input.rootSessionId, "claude",
        input.release.claudeVibeRoot, "vibe", loadedModule.LoadBasis.HookObserved) }, null, 2)}\n`,
    { mode: 0o600 });
  }
  const coreVersion = JSON.parse(readFileSync(join(input.release.coreDir,
    ".claude-plugin/plugin.json"), "utf8")) as { version: string };
  const stub = join(input.root, `claude-list-${input.release.version}.mjs`);
  writeFileSync(stub, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='plugin'&&args[1]==='list'&&args[2]==='--json')process.stdout.write(JSON.stringify([
{id:'closedloop-core@closedloop-ai',version:${JSON.stringify(coreVersion.version)},scope:'user',enabled:true},
{id:'vibe@closedloop-ai',version:${JSON.stringify(input.release.version)},scope:'user',enabled:true}]));
else if(args[0]==='--version')process.stdout.write('fixture Claude Code\\n');
else process.exit(2);\n`, { mode: 0o700 });
  chmodSync(stub, 0o700);
  const codexStub = join(input.root, `codex-list-${input.release.version}.mjs`);
  writeFileSync(codexStub, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='plugin'&&args[1]==='list'&&args[2]==='--json')process.stdout.write(JSON.stringify({installed:[]}));
else if(args[0]==='--version')process.stdout.write('fixture Codex CLI\\n');
else process.exit(2);\n`, { mode: 0o700 });
  chmodSync(codexStub, 0o700);
  const state = join(input.root, "plugin-version-state.json");
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env),
    CLAUDE_CODE_SESSION_ID: input.rootSessionId };
  if (input.home) env.HOME = input.home;
  delete env.CODEX_THREAD_ID;
  const run = async (args: string[]) => await runOwnedProcess(process.execPath,
    [pluginVersion, ...args], { cwd: input.root, env, deadline: Date.now() + 120_000,
      maxBuffer: 4 * 1024 * 1024 });
  const checked = await run(["check", "--runtime", "claude", "--conversation", input.rootSessionId,
    "--state", state, "--claude", stub, "--latest-base", input.latestBase,
    "--codex", codexStub,
    "--closedloop", "not-connected", "--graph", "not-connected"]);
  if (checked.exitCode !== 0) throw new Error(checked.stderr || "eval-stateful-version-check-failed");
  let record = JSON.parse(readFileSync(state, "utf8")) as Record<string, any>;
  validateClaudeVersionRecord(record, input.release.version, input.rootSessionId);
  if (!existsSync(startup)) throw new Error("eval-stateful-version-record-invalid");
  validateClaudeLoadContract(record, { conversation: input.rootSessionId,
    version: input.release.version, pluginRoot: input.release.claudeVibeRoot,
    helperExists: hasLoadedSkill, hookExists: existsSync(hook) });
  if (record.status === "outdated") {
    const chosen = await run(["choose", "--choice", "proceed", "--by", "opening-message",
      "--conversation", input.rootSessionId, "--state", state]);
    if (chosen.exitCode !== 0) throw new Error(chosen.stderr || "eval-stateful-version-choice-failed");
    record = JSON.parse(readFileSync(state, "utf8")) as Record<string, any>;
    if (record.choice?.choice !== "proceed" || record.choice?.by !== "opening-message") {
      throw new Error("eval-stateful-version-choice-invalid");
    }
  } else if (record.status !== "current") {
    throw new Error(`eval-stateful-version-status-invalid:${checked.stdout.slice(-2_000)}`);
  }
  return `version ${input.release.version} status=${record.status} ` +
    `choice=${record.choice?.choice ?? "none"} claude=${observedVersion(record, "claude") ?? "none"} ` +
    `codex=${observedVersion(record, "codex") ?? "none"} ` +
    `load=${hasLoadedSkill ? "hook" : "legacy-startup"}`;
}

function observedVersion(record: Record<string, any>, runtime: string): string | null {
  return record.harnesses?.find((item: any) => item.harness === runtime)?.plugins
    ?.find((item: any) => item.name === "vibe")?.version ?? null;
}

/** Validate the conversation, runtime, and selected fixture version before root launch. */
export function validateClaudeVersionRecord(record: Record<string, any>, expectedVersion: string,
  conversation: string): void {
  const observed = record.harnesses?.find((item: any) => item.harness === "claude")?.plugins
    ?.find((item: any) => item.name === "vibe")?.version;
  if (record.conversation !== conversation || record.runtime !== "claude" ||
      observed !== expectedVersion) throw new Error("eval-stateful-version-record-invalid");
}

/** Honor the selected release's own hook-evidence contract without backporting modern fields. */
export function validateClaudeLoadContract(record: Record<string, any>, expected: {
  conversation: string; version: string; pluginRoot: string; helperExists: boolean;
  hookExists: boolean;
}): void {
  if (!expected.helperExists) {
    if (expected.hookExists || record.loadedSkillRequired === true || record.loadedSkill) {
      throw new Error("eval-stateful-legacy-load-contract-invalid");
    }
    return;
  }
  const loaded = record.loadedSkill;
  if (!expected.hookExists || record.loadedSkillRequired !== true ||
      loaded?.actorId !== expected.conversation || loaded?.runtime !== "claude" ||
      loaded?.version !== expected.version || loaded?.pluginRoot !== expected.pluginRoot) {
    throw new Error("eval-stateful-load-contract-invalid");
  }
}

export function cleanupClaudeVersionRecords(root: string, rootSessionId: string,
  home = homedir()): void {
  rmSync(join(home, ".codex/vibe/plugin-version", `${rootSessionId}.json`), { force: true });
  rmSync(join(home, ".vibe-hook-scope", `${rootSessionId}.json`), { force: true });
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (/^(?:claude|codex)-list-\d+\.\d+\.\d+\.mjs$/.test(name) ||
        name === "plugin-version-state.json") {
      rmSync(join(root, name), { force: true });
    }
  }
  claudeVersionCleanupTargets.delete(claudeVersionCleanupKey({ root, rootSessionId, home }));
}

async function runClaudeCase(input: { repo: string; root: string; item: EvalCaseDefinition;
  transition: UpgradeTransition; claudeExecutable: string; pluginSha: string;
  currentSnapshot?: PluginSnapshot;
  signal?: AbortSignal }): Promise<UpgradeCaseEvidence> {
  const started = Date.now();
  const prior = archivePluginRelease(input.repo, input.transition.prior.ref,
    join(input.root, "prior"), input.transition.prior.version);
  const target = input.currentSnapshot
    ? archiveSnapshotTarget(input.repo, input.transition.target.ref, join(input.root, "target"),
      input.currentSnapshot, input.transition.target.version)
    : archivePluginRelease(input.repo, input.transition.target.ref,
      join(input.root, "target"), input.transition.target.version);
  const versionServer = await fixtureVersionServer(target);
  const prepared = await fixture(join(input.root, "fixture"), prior, input.item.id);
  const settings = writeClaudeRootSettings(input.root, prepared.worktree, [prior, target]);
  const rootSessionId = randomUUID();
  const processTrace: string[] = [];
  const env = claudeRootEnvironment(input.claudeExecutable);
  const invoke = async (release: PluginReleaseArchive, prompt: string, resume: boolean) => {
    const args = claudeUpgradeRootArgs({ release, settings, rootSessionId, prompt, resume,
      caseId: input.item.id });
    return await runOwnedProcess(input.claudeExecutable, args, { cwd: prepared.worktree,
      deadline: Date.now() + STATEFUL_CLAUDE_ROOT_TIMEOUT_MS, signal: input.signal,
      maxBuffer: 16 * 1024 * 1024, env });
  };
  try {
    processTrace.push(await prepareClaudeVersionRecord({ release: prior,
      latestBase: versionServer.url, root: input.root, rootSessionId }));
    const first = await invoke(prior, `/vibe:vibe\n\n${rootPrompt({ fixture: prepared,
      requestId: prepared.requestOne, marker: "turn-one", continuation: false,
      vibeRoot: prior.claudeVibeRoot, runtime: "claude" })}`, false);
    recordClaudeTurnOutput(input.root, "turn-one", first);
    processTrace.push(`turn-one exit=${first.exitCode}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    if (first.exitCode !== 0 || proofLines(prepared.worktree).join("\n") !== "turn-one") {
      throw new Error(claudeTurnFailureText(first) || "MODEL_BLOCKED first turn did not complete");
    }
    const before = writerLedger(prepared.worktree);
    if (!before?.workerId) throw new Error("ORACLE_MISMATCH first turn created no writer ledger");
    enqueueUpgradeRequest(prior.claudeVibeRoot, { worktree: prepared.worktree,
      workerId: before.workerId, requestId: prepared.requestTwo,
      text: `Append exactly "turn-two" plus one newline to ${PROOF_FILE}.` });
    processTrace.push(await prepareClaudeVersionRecord({ release: target,
      latestBase: versionServer.url, root: input.root, rootSessionId, refresh: true }));
    let targetTurn = await invoke(target, `/vibe:vibe\n\n${rootPrompt({ fixture: prepared,
      requestId: prepared.requestTwo, marker: "turn-two", continuation: true,
      vibeRoot: target.claudeVibeRoot, runtime: "claude",
      ...(input.item.definition === "changed" ? { migration: {
        previousWorkerId: before.workerId, previousDigest: before.binding.digest } } : {}) })}`, true);
    recordClaudeTurnOutput(input.root, "turn-two", targetTurn);
    processTrace.push(`turn-two exit=${targetTurn.exitCode}\nstdout:\n${targetTurn.stdout}\nstderr:\n${targetTurn.stderr}`);
    let after = writerLedger(prepared.worktree);
    let lines = proofLines(prepared.worktree);
    const targetEvents = [...claudeEvents(targetTurn.stdout)];
    let terminalText = targetEvents.flatMap((event) => event.type === "result" &&
      typeof event.result === "string" ? [event.result] : []).at(-1) ?? "";
    if (claudeStaleRecoveryEligible({ exitCode: targetTurn.exitCode, terminalText,
      requestId: prepared.requestTwo, oldWriterId: before.workerId, proofLines: lines,
      oldArchiveRetained: existsSync(prior.archiveRoot),
      staleToolResult: claudeStaleToolResult(targetTurn.stdout, prepared.requestTwo),
      ledger: after })) {
      processTrace.push("stale-recovery-continuation eligible exact-root-session");
      targetTurn = await invoke(target, claudeStaleRecoveryPrompt({ requestId: prepared.requestTwo,
        sessionSlug: prepared.sessionSlug }), true);
      recordClaudeTurnOutput(input.root, "stale-recovery", targetTurn);
      processTrace.push(`stale-recovery exit=${targetTurn.exitCode}\nstdout:\n${targetTurn.stdout}` +
        `\nstderr:\n${targetTurn.stderr}`);
      targetEvents.push(...claudeEvents(targetTurn.stdout));
      after = writerLedger(prepared.worktree);
      lines = proofLines(prepared.worktree);
      terminalText = targetEvents.flatMap((event) => event.type === "result" &&
        typeof event.result === "string" ? [event.result] : []).at(-1) ?? "";
    }
    const events = [...claudeEvents(first.stdout), ...targetEvents];
    const costs = events.flatMap((event) => event.type === "result" &&
      typeof event.total_cost_usd === "number" ? [event.total_cost_usd] : []);
    const migrationCount = Array.isArray(after?.migrations) ? after.migrations.length : 0;
    const sameDefinition = input.item.definition === "unchanged";
    const valid = targetTurn.exitCode === 0 && after && before &&
      upgradeCasePasses({ runtime: "claude", definition: sameDefinition ? "unchanged" : "changed",
        previousWriterId: before.workerId, finalWriterId: after.workerId, migrationCount,
        proofLines: lines, terminalText,
        requestCompleted: ledgerCompletedRequest(after, prepared.requestTwo),
        oldArchiveRetained: existsSync(prior.archiveRoot) });
    const evidence = { caseId: input.item.id, runtime: "claude" as const, passed: Boolean(valid),
      failureCode: valid ? null : classifyUpgradeFailure(`${terminalText}\n${targetTurn.stderr}`),
      wallMs: Date.now() - started,
      agentCostUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, tokens: null,
      cliVersion: execFileSync(input.claudeExecutable, ["--version"], { encoding: "utf8" })
        .match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown",
      target: input.transition.target, prior: input.transition.prior,
      oldArchiveRetained: existsSync(prior.archiveRoot), proofLines: lines, rootSessionId,
      previousWriterId: before?.workerId ?? null, finalWriterId: after?.workerId ?? null,
      migrationCount, trace: boundedTrace([...processTrace, ...events.flatMap((event) =>
        event.type === "assistant" ? [JSON.stringify(event.message?.content ?? [])] : [])]) };
    await versionServer.close(); cleanupClaudeVersionRecords(input.root, rootSessionId);
    return evidence;
  } catch (error) {
    const ledger = writerLedger(prepared.worktree);
    const evidence: UpgradeCaseEvidence = { caseId: input.item.id, runtime: "claude", passed: false,
      failureCode: classifyUpgradeFailure(error),
      wallMs: Date.now() - started, agentCostUsd: null, tokens: null,
      cliVersion: execFileSync(input.claudeExecutable, ["--version"], { encoding: "utf8" })
        .match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown",
      target: input.transition.target, prior: input.transition.prior,
      oldArchiveRetained: existsSync(prior.archiveRoot), proofLines: proofLines(prepared.worktree),
      rootSessionId, previousWriterId: ledger?.workerId ?? null, finalWriterId: ledger?.workerId ?? null,
      migrationCount: Array.isArray(ledger?.migrations) ? ledger.migrations.length : 0,
      trace: boundedTrace([...processTrace, error instanceof Error ? error.message : String(error)]) };
    await versionServer.close().catch(() => {}); cleanupClaudeVersionRecords(input.root, rootSessionId);
    return evidence;
  }
}

function replaceMarketplace(target: string, release: PluginReleaseArchive): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(release.archiveRoot, ".claude-plugin"), join(target, ".claude-plugin"), { recursive: true });
  cpSync(join(release.archiveRoot, "plugins"), join(target, "plugins"), { recursive: true });
}

function trackedDirectoryHash(sourceRoot: string, targetRoot: string): string {
  const hashValue = createHash("sha256");
  const walk = (dir: string) => readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name)).forEach((entry) => {
      const path = join(dir, entry.name);
      const relative = path.slice(sourceRoot.length + 1);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const target = join(targetRoot, relative);
        if (!existsSync(target) || !lstatSync(target).isFile()) {
          throw new Error(`eval-stateful-codex-cache-file-missing:${relative}`);
        }
        const source = readFileSync(path);
        const installed = readFileSync(target);
        if (!source.equals(installed)) throw new Error(`eval-stateful-codex-cache-file-drift:${relative}`);
        hashValue.update(relative); hashValue.update("\0"); hashValue.update(source); hashValue.update("\0");
      }
    });
  walk(sourceRoot);
  return hashValue.digest("hex");
}

/** Validate the exact cache copy returned by Codex before any App Server turn starts. */
export function validateCodexInstalledPlugin(input: { home: string; release: PluginReleaseArchive;
  result: { installedPath?: unknown; version?: unknown } }): string {
  const expected = join(input.home, "plugins", "cache", CODEX_MARKETPLACE,
    "vibe", input.release.version);
  if (input.result.version !== input.release.version || input.result.installedPath !== expected ||
      !existsSync(expected) || !trackedDirectoryHash(input.release.vibeDir, expected)) {
    throw new Error("eval-stateful-codex-install-invalid");
  }
  const versions = readdirSync(dirname(expected)).sort();
  if (versions.join("\0") !== input.release.version) throw new Error("eval-stateful-codex-cache-invalid");
  return realpathSync(expected);
}

function codexInstall(input: { codex: string; env: NodeJS.ProcessEnv; marketplace: string;
  release: PluginReleaseArchive; addMarketplace: boolean }): { installedPath: string } {
  replaceMarketplace(input.marketplace, input.release);
  const run = (...args: string[]) => execFileSync(input.codex, args,
    { env: input.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (input.addMarketplace) run("plugin", "marketplace", "add", input.marketplace, "--json");
  run("plugin", "add", CODEX_CORE_SELECTOR, "--json");
  const result = JSON.parse(run("plugin", "add", CODEX_PLUGIN_SELECTOR, "--json")) as {
    installedPath?: unknown; version?: unknown;
  };
  return { installedPath: validateCodexInstalledPlugin({ home: input.env.CODEX_HOME!,
    release: input.release, result }) };
}

/** Link the existing Codex credential into one run-owned home without copying it. */
export function linkCodexAuth(home: string,
  sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const source = join(sourceHome, "auth.json");
  if (!existsSync(source)) throw new Error("AUTH_UNAVAILABLE Codex auth.json is missing");
  symlinkSync(realpathSync(source), join(home, "auth.json"));
}

/** Sum the final cumulative token total for each distinct App Server thread. */
export function appServerTokenUsage(trace: string[]): Record<string, number> {
  const byThread = new Map<string, Record<string, number>>();
  const names: Record<string, string> = {
    totalTokens: "total_tokens", inputTokens: "input_tokens",
    cachedInputTokens: "cached_input_tokens", cacheWriteInputTokens: "cache_write_input_tokens",
    outputTokens: "output_tokens", reasoningOutputTokens: "reasoning_output_tokens",
  };
  for (const line of trace) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { method?: string; params?: { threadId?: string;
        tokenUsage?: { total?: Record<string, unknown> } } };
      const threadId = event.params?.threadId;
      const total = event.params?.tokenUsage?.total;
      if (event.method !== "thread/tokenUsage/updated" || !threadId || !total) continue;
      const normalized: Record<string, number> = {};
      for (const [source, target] of Object.entries(names)) {
        const value = total[source];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) normalized[target] = value;
      }
      byThread.set(threadId, normalized);
    } catch { /* Non-JSON evidence lines carry no token usage. */ }
  }
  const result: Record<string, number> = {};
  for (const totals of byThread.values()) {
    for (const [key, value] of Object.entries(totals)) result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

/** Exact internal HOLD bootstrap eligible for one same-root continuation. */
export function heldCodexWriter(trace: string[], ledgerExists: boolean,
  proof: string[]): string | null {
  if (ledgerExists || proof.length) return null;
  return canonicalHoldChild(trace);
}

function canonicalHoldChild(trace: string[]): string | null {
  const children = new Set<string>();
  const held = new Set<string>();
  for (const line of trace) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { params?: { threadId?: string; item?: Record<string, unknown>;
        turn?: { items?: Array<Record<string, unknown>> } } };
      const item = event.params?.item;
      if (item?.type === "subAgentActivity" && item.agentPath === "/root/vibe_change_worker" &&
          typeof item.agentThreadId === "string") children.add(`${item.agentPath}\0${item.agentThreadId}`);
      else if (item?.type === "subAgentActivity" && typeof item.agentPath === "string" &&
          typeof item.agentThreadId === "string" && item.agentPath.startsWith("/root/vibe_")) {
        children.add(`${item.agentPath}\0${item.agentThreadId}`);
      }
      const messages = [item, ...(event.params?.turn?.items ?? [])].filter(Boolean);
      for (const message of messages) {
        if (message?.type === "agentMessage" && holdStatusText(message.text) &&
            typeof event.params?.threadId === "string") held.add(event.params.threadId);
      }
    } catch { /* Ignore bounded non-JSON evidence. */ }
  }
  if (children.size !== 1) return null;
  const [path, threadId] = [...children][0].split("\0");
  return held.has(threadId) ? path : null;
}

/** Accept one bounded HOLD status line without accepting another terminal state. */
export function holdStatusText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > 512 || text.includes("\n") || !/^HOLD(?:\b|[.:])/.test(text)) return false;
  const explanation = text.slice(4);
  return !/\b(?:NEEDS_PERSON|BLOCKED|DONE|FAILED)\b/.test(explanation);
}

/** Exact completed native turn that the root must finalize through production writer-state. */
export function codexStoppedTurn(trace: string[], ledger: Record<string, any> | null): {
  runtime: "codex"; workerId: string; requestId: string; lease: string; state: "completed";
} | null {
  if (ledger?.runtime !== "codex" || typeof ledger.workerId !== "string" ||
      typeof ledger.active?.id !== "string" || typeof ledger.active?.lease !== "string") return null;
  const childIds = new Set<string>();
  const completed = new Set<string>();
  for (const line of trace) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { method?: string; params?: { threadId?: string;
        item?: Record<string, unknown>; turn?: { status?: string } } };
      const item = event.params?.item;
      if (item?.type === "subAgentActivity" && item.agentPath === ledger.workerId &&
          typeof item.agentThreadId === "string") childIds.add(item.agentThreadId);
      if (event.method === "turn/completed" && event.params?.turn?.status === "completed" &&
          typeof event.params.threadId === "string") completed.add(event.params.threadId);
    } catch { /* Ignore bounded non-JSON evidence. */ }
  }
  if (childIds.size !== 1 || !completed.has([...childIds][0])) return null;
  return { runtime: "codex", workerId: ledger.workerId, requestId: ledger.active.id,
    lease: ledger.active.lease, state: "completed" };
}

/** Accept either a held new child or one that completed the migrated request in the same turn. */
export function targetMigrationChild(trace: string[], previousWorkerId: string,
  migratedWorkerId?: string): string | null {
  const child = canonicalHoldChild(trace);
  if (child && child !== previousWorkerId) return child;
  if (!migratedWorkerId || migratedWorkerId === previousWorkerId) return null;
  const children = new Map<string, Set<string>>();
  const completedTurns = new Set<string>();
  const completedActivity = new Set<string>();
  for (const line of trace) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { method?: string; params?: { threadId?: string;
        item?: Record<string, unknown>; turn?: { status?: string } } };
      const item = event.params?.item;
      if (item?.type === "subAgentActivity" && typeof item.agentPath === "string" &&
          item.agentPath.startsWith("/root/vibe_") && item.agentPath !== previousWorkerId &&
          typeof item.agentThreadId === "string") {
        const ids = children.get(item.agentPath) ?? new Set<string>();
        ids.add(item.agentThreadId);
        children.set(item.agentPath, ids);
        if (event.method === "item/completed" && item.kind === "completed") {
          completedActivity.add(item.agentThreadId);
        }
      }
      if (event.method === "turn/completed" && event.params?.turn?.status === "completed" &&
          typeof event.params.threadId === "string") completedTurns.add(event.params.threadId);
    } catch { /* Ignore non-JSON and bounded trace entries. */ }
  }
  const ids = children.get(migratedWorkerId);
  return children.size === 1 && ids?.size === 1 &&
    completedTurns.has([...ids][0]) && completedActivity.has([...ids][0])
    ? migratedWorkerId : null;
}

/** Target installation cannot start while the old native turn still owns its lease. */
export function requireIdleCodexLedger(ledger: Record<string, any> | null): void {
  if (!ledger || ledger.runtime !== "codex" || ledger.active?.lease) {
    throw new Error("ORACLE_MISMATCH Codex writer ledger is not idle");
  }
}

/** Finalize only the request whose exact native child turn completed, then re-read durable state. */
export async function finalizeCodexObservedRequest(input: { trace: string[];
  ledger: Record<string, any> | null; requestId: string; worktree: string;
  resultSummary: string;
  finish: (payload: Record<string, unknown>) => Promise<Record<string, any> | null>;
}): Promise<Record<string, any>> {
  const ledger = input.ledger;
  if (!ledger || ledger.runtime !== "codex") throw new Error("ORACLE_MISMATCH Codex ledger missing");
  if (!ledger.active?.lease) {
    if (!ledgerCompletedRequest(ledger, input.requestId)) {
      throw new Error("ORACLE_MISMATCH Codex request was not completed");
    }
    return ledger;
  }
  if (ledger.active.id !== input.requestId) {
    throw new Error("ORACLE_MISMATCH Codex active request mismatch");
  }
  const stoppedTurn = codexStoppedTurn(input.trace, ledger);
  if (!stoppedTurn || stoppedTurn.requestId !== input.requestId) {
    throw new Error("ORACLE_MISMATCH completed Codex turn evidence is ambiguous");
  }
  const after = await input.finish({ worktree: input.worktree, workerId: ledger.workerId,
    requestId: input.requestId, lease: stoppedTurn.lease, status: "DONE",
    resultSummary: input.resultSummary, stoppedTurn });
  requireIdleCodexLedger(after);
  if (!ledgerCompletedRequest(after, input.requestId)) {
    throw new Error("ORACLE_MISMATCH Codex request finalization incomplete");
  }
  return after!;
}

async function appServerTurn(client: CodexAppServerClient, input: { threadId?: string;
  cwd: string; skill: string; prompt: string }): Promise<{ threadId: string; trace: string[];
    tokens: Record<string, number> }> {
  const trace: string[] = [];
  trace.push(`skill:${realpathSync(input.skill)}`);
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolvePromise) => { resolveDone = resolvePromise; });
  const remove = client.onNotification((message) => {
    trace.push(JSON.stringify(message));
    if (message.method === "turn/completed") resolveDone?.();
  });
  try {
    const created = input.threadId ? null : await client.request("thread/start", { cwd: input.cwd,
      approvalPolicy: "never", sandbox: "danger-full-access", threadSource: WORKER_THREAD_SOURCE });
    const threadId = input.threadId ?? created.thread.id;
    if (created) await labelWorkerThread(client, threadId, "vibe upgrade resume");
    await client.request("turn/start", { threadId, cwd: input.cwd,
      input: [{ type: "text", text: input.prompt, text_elements: [] },
        { type: "skill", name: "vibe:vibe", path: input.skill }] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("App Server turn timed out")),
          CODEX_STATEFUL_ROOT_TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    return { threadId, trace, tokens: appServerTokenUsage(trace) };
  } finally { remove(); }
}

/** Ask the real root to apply an exact writer-state finalization, preserving its native trace. */
async function finishCodexThroughRoot(client: CodexAppServerClient, input: {
  threadId: string; worktree: string; installedPath: string; trace: string[];
  payload: Record<string, unknown>;
}): Promise<Record<string, any> | null> {
  const finalized = await appServerTurn(client, { threadId: input.threadId,
    cwd: input.worktree, skill: join(input.installedPath, "skills/vibe/SKILL.md"),
    prompt: `$vibe The exact native writer turn completed but its production ledger lease is ` +
      `still active. Do not spawn or message a worker. Finish only that turn now with exactly ` +
      `printf '%s\\n' '${JSON.stringify(input.payload)}' | node ` +
      `'${join(input.installedPath, "skills/vibe/scripts/dist/writer-state.mjs")}' finish. ` +
      `Return after the ledger is idle.` });
  input.trace.push(`finish-continuation:${input.payload.workerId}`, ...finalized.trace);
  return writerLedger(input.worktree);
}

async function runCodexCase(input: { repo: string; root: string; item: EvalCaseDefinition;
  transition: UpgradeTransition; codexExecutable: string;
  currentSnapshot?: PluginSnapshot }): Promise<UpgradeCaseEvidence> {
  const started = Date.now();
  const prior = archivePluginRelease(input.repo, input.transition.prior.ref,
    join(input.root, "prior"), input.transition.prior.version);
  const target = input.currentSnapshot
    ? archiveSnapshotTarget(input.repo, input.transition.target.ref, join(input.root, "target"),
      input.currentSnapshot, input.transition.target.version)
    : archivePluginRelease(input.repo, input.transition.target.ref,
      join(input.root, "target"), input.transition.target.version);
  const prepared = await fixture(join(input.root, "fixture"), prior, input.item.id);
  const home = join(input.root, "codex-home");
  const marketplace = join(input.root, "marketplace");
  const env = { ...process.env, CODEX_HOME: home };
  let client: CodexAppServerClient | null = null;
  let rootSessionId = "";
  let before: Record<string, any> | null = null;
  const trace: string[] = [];
  try {
    linkCodexAuth(home);
    env.CODEX_HOME = realpathSync(home);
    const oldInstall = codexInstall({ codex: input.codexExecutable, env, marketplace, release: prior,
      addMarketplace: true });
    client = await startCodexAppServer({ codex: input.codexExecutable, env,
      clientName: "vibe_upgrade_resume" });
    const first = await appServerTurn(client, { cwd: prepared.worktree,
      skill: join(oldInstall.installedPath, "skills/vibe/SKILL.md"),
      prompt: `$vibe ${rootPrompt({ fixture: prepared, requestId: prepared.requestOne,
        marker: "turn-one", continuation: false, vibeRoot: oldInstall.installedPath,
        runtime: "codex" })}` });
    rootSessionId = first.threadId;
    trace.push(...first.trace);
    before = writerLedger(prepared.worktree);
    const held = heldCodexWriter(first.trace, before !== null, proofLines(prepared.worktree));
    if (!before && held) {
      trace.push(`hold-continuation:${held}`);
      const continuation = await appServerTurn(client, { threadId: rootSessionId,
        cwd: prepared.worktree, skill: join(oldInstall.installedPath, "skills/vibe/SKILL.md"),
        prompt: `$vibe Internal HOLD bootstrap returned exact child ${held}. Continue in this same root ` +
          `thread: register and claim that exact worker id with the required graph capabilities, take request ` +
          `${prepared.requestOne}, follow up the same worker context, and finish the proof edit. Do not spawn ` +
          `another writer, message the child from the harness, report HOLD, read references, or diagnose.` });
      if (heldCodexWriter(continuation.trace, false, [])) {
        throw new Error("ORACLE_MISMATCH second internal HOLD");
      }
      trace.push(...continuation.trace);
      before = writerLedger(prepared.worktree);
    }
    if (!before?.workerId) throw new Error("ORACLE_MISMATCH first turn created no writer ledger");
    if (before.active?.lease) {
      before = await finalizeCodexObservedRequest({ trace, ledger: before,
        requestId: prepared.requestOne, worktree: prepared.worktree,
        resultSummary: "Upgrade eval turn one completed",
        finish: async (payload) => await finishCodexThroughRoot(client!, {
          threadId: rootSessionId, worktree: prepared.worktree,
          installedPath: oldInstall.installedPath, trace, payload }) });
    }
    requireIdleCodexLedger(before);
    if (!before) throw new Error("ORACLE_MISMATCH Codex writer ledger disappeared");
    const priorLedger = before;
    enqueueUpgradeRequest(oldInstall.installedPath, { worktree: prepared.worktree,
      workerId: priorLedger.workerId, requestId: prepared.requestTwo,
      text: `Append exactly "turn-two" plus one newline to ${PROOF_FILE}.` });
    await client.close(); client = null;
    const targetInstall = codexInstall({ codex: input.codexExecutable, env, marketplace, release: target,
      addMarketplace: false });
    client = await startCodexAppServer({ codex: input.codexExecutable, env,
      clientName: "vibe_upgrade_resume" });
    const resumed = await client.resumeThread(rootSessionId, prepared.worktree);
    if (resumed.id !== rootSessionId) throw new Error("WRONG_SESSION Codex resumed another root");
    const migrationPayload = { worktree: prepared.worktree, runtime: "codex",
      agentRoot: targetInstall.installedPath, agentName: "vibe-change-worker",
      previousWorkerId: priorLedger.workerId, previousDigest: priorLedger.binding.digest,
      workerId: "<NEW_HOLD_CHILD_ID>", capabilities: UPGRADE_GRAPH_CAPABILITIES };
    const second = await appServerTurn(client, { threadId: rootSessionId, cwd: prepared.worktree,
      skill: join(targetInstall.installedPath, "skills/vibe/SKILL.md"),
      prompt: `$vibe ${rootPrompt({ fixture: prepared, requestId: prepared.requestTwo,
        marker: "turn-two", continuation: true, vibeRoot: targetInstall.installedPath,
        runtime: "codex" })} The recorded root was removed by target install. Migration requires a NEW ` +
        `canonical HOLD writer identity different from ${priorLedger.workerId}. Spawn exactly one, then replace ` +
        `the placeholder in this exact production migrate payload with that returned child id: ` +
        `${JSON.stringify(migrationPayload)}. Migrate before claiming request two.` });
    trace.push(...second.trace);
    let after = writerLedger(prepared.worktree);
    const migrationChild = targetMigrationChild(second.trace, priorLedger.workerId, after?.workerId);
    if ((!after || after.migrations?.length !== 1 || proofLines(prepared.worktree).length < 2) &&
        migrationChild) {
      const exactMigration = { ...migrationPayload, workerId: migrationChild };
      trace.push(`migration-hold-continuation:${migrationChild}`);
      const continuation = await appServerTurn(client, { threadId: rootSessionId,
        cwd: prepared.worktree, skill: join(targetInstall.installedPath, "skills/vibe/SKILL.md"),
        prompt: `$vibe Continue the target migration with exact new HOLD child ${migrationChild}. ` +
          `Do not spawn or message another worker. If status still shows the exact old active turn, finish ` +
          `only that turn with its observed stoppedTurn evidence. Then run exactly printf '%s\\n' ` +
          `'${JSON.stringify(exactMigration)}' | node ` +
          `'${join(targetInstall.installedPath, "skills/vibe/scripts/dist/writer-state.mjs")}' migrate. ` +
          `After migration, claim and take queued request ${prepared.requestTwo}, follow up the SAME child ` +
          `${migrationChild}, and finish the turn-two proof edit.` });
      if (targetMigrationChild(continuation.trace, priorLedger.workerId)) {
        throw new Error("ORACLE_MISMATCH second target migration HOLD");
      }
      trace.push(...continuation.trace);
      after = writerLedger(prepared.worktree);
    }
    if (after?.active?.lease) {
      after = await finalizeCodexObservedRequest({ trace, ledger: after,
        requestId: prepared.requestTwo, worktree: prepared.worktree,
        resultSummary: "Upgrade eval turn two completed",
        finish: async (payload) => await finishCodexThroughRoot(client!, {
          threadId: rootSessionId, worktree: prepared.worktree,
          installedPath: targetInstall.installedPath, trace, payload }) });
    }
    const lines = proofLines(prepared.worktree);
    const migrationCount = Array.isArray(after?.migrations) ? after.migrations.length : 0;
    const valid = after && migrationChild && after.workerId === migrationChild &&
      trace.includes(`skill:${realpathSync(join(targetInstall.installedPath, "skills/vibe/SKILL.md"))}`) &&
      !existsSync(join(home, "plugins/cache", CODEX_MARKETPLACE, "vibe", prior.version)) &&
      upgradeCasePasses({ runtime: "codex", definition: input.item.definition!,
        previousWriterId: priorLedger.workerId, finalWriterId: after.workerId, migrationCount,
        proofLines: lines, terminalText: appServerTerminalText(trace),
        requestCompleted: ledgerCompletedRequest(after, prepared.requestTwo),
        oldArchiveRetained: existsSync(prior.archiveRoot) });
    return { caseId: input.item.id, runtime: "codex", passed: Boolean(valid),
      failureCode: valid ? null : "ORACLE_MISMATCH", wallMs: Date.now() - started,
      agentCostUsd: null, tokens: appServerTokenUsage(trace),
      cliVersion: execFileSync(input.codexExecutable, ["--version"],
        { encoding: "utf8" }).trim(), target: input.transition.target, prior: input.transition.prior,
      oldArchiveRetained: existsSync(prior.archiveRoot), proofLines: lines, rootSessionId,
      previousWriterId: priorLedger.workerId, finalWriterId: after?.workerId ?? null,
      migrationCount, trace: boundedTrace(trace) };
  } catch (error) {
    const ledger = writerLedger(prepared.worktree);
    return { caseId: input.item.id, runtime: "codex", passed: false,
      failureCode: codexServerFailure(trace) ?? classifyUpgradeFailure(error),
      wallMs: Date.now() - started, agentCostUsd: null, tokens: appServerTokenUsage(trace),
      cliVersion: execFileSync(input.codexExecutable, ["--version"], { encoding: "utf8" }).trim(),
      target: input.transition.target, prior: input.transition.prior,
      oldArchiveRetained: existsSync(prior.archiveRoot), proofLines: proofLines(prepared.worktree),
      rootSessionId, previousWriterId: before?.workerId ?? null, finalWriterId: ledger?.workerId ?? null,
      migrationCount: Array.isArray(ledger?.migrations) ? ledger.migrations.length : 0,
      trace: boundedTrace([...trace, error instanceof Error ? error.message : String(error)]) };
  } finally {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** Run fixed proofs and the current subject in isolated fixtures, serially per runtime. */
export async function runUpgradeResumeCases(input: UpgradeResumeRunInput): Promise<
  Partial<Record<EvalRuntime, EvalSuiteResult>>> {
  if (existsSync(input.runRoot)) throw new Error("eval-stateful-run-root-exists");
  if (input.currentSnapshot.sha !== input.pluginSha) throw new Error("eval-current-snapshot-identity-invalid");
  mkdirSync(input.runRoot, { recursive: true, mode: 0o700 });
  const targetRef = input.targetRef ?? input.pluginSha;
  if (!/^[a-f0-9]{40}$/.test(targetRef)) throw new Error("eval-stateful-target-ref-invalid");
  const subject = upgradeSubject({ repo: input.repo, targetRef, pluginSha: input.pluginSha,
    currentSnapshot: input.currentSnapshot });
  const lanes = input.runtimes.map(async (runtime) => {
    const evidence: UpgradeCaseEvidence[] = [];
    for (const item of input.cases) {
      const caseRoot = join(input.runRoot, runtime, item.id);
      mkdirSync(dirname(caseRoot), { recursive: true });
      const observations: Array<{ role: "historical" | "current"; expected: "pass" | "fail";
        evidence: UpgradeCaseEvidence }> = [];
      for (const planned of upgradeTransitionPlan(item, runtime, subject,
        input.targetRef, input.pluginSha)) {
        const transitionRoot = join(caseRoot, planned.role === "current" ? "current" :
          join("historical", planned.transition.target.version));
        mkdirSync(transitionRoot, { recursive: true });
        const result = runtime === "claude"
          ? await runClaudeCase({ repo: input.repo, root: transitionRoot, item,
            transition: planned.transition, claudeExecutable: input.claudeExecutable,
            pluginSha: input.pluginSha, signal: input.signal,
            ...(planned.role === "current" ? { currentSnapshot: input.currentSnapshot } : {}) })
          : await runCodexCase({ repo: input.repo, root: transitionRoot, item,
            transition: planned.transition, codexExecutable: input.codexExecutable,
            ...(planned.role === "current" ? { currentSnapshot: input.currentSnapshot } : {}) });
        observations.push({ role: planned.role, expected: planned.expected, evidence: result });
        writeFileSync(join(transitionRoot, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`,
          { mode: 0o600 });
        if (result.failureCode !== null && INFRASTRUCTURE_FAILURE_CODES.has(result.failureCode)) break;
      }
      const scored = scoreUpgradeTransitions(observations);
      const representative = observations.find((item) => item.role === "current")?.evidence ??
        observations.at(-1)!.evidence;
      const agentCosts = observations.map((item) => item.evidence.agentCostUsd);
      const allTokens = observations.map((item) => item.evidence.tokens);
      const combined: UpgradeCaseEvidence = { ...representative, passed: scored.passed,
        failureCode: scored.failureCode, transitionResults: scored.transitions,
        wallMs: observations.reduce((sum, item) => sum + item.evidence.wallMs, 0),
        agentCostUsd: agentCosts.every((value) => value !== null)
          ? agentCosts.reduce((sum, value) => sum + (value ?? 0), 0) : null,
        tokens: allTokens.every((value) => value !== null)
          ? allTokens.reduce<Record<string, number>>((totals, value) => {
            for (const [key, count] of Object.entries(value ?? {})) {
              totals[key] = (totals[key] ?? 0) + count;
            }
            return totals;
          }, {}) : null };
      evidence.push(combined);
      writeFileSync(join(caseRoot, "evidence.json"), `${JSON.stringify(combined, null, 2)}\n`,
        { mode: 0o600 });
    }
    return [runtime, statefulSuite(runtime, evidence)] as const;
  });
  return Object.fromEntries(await Promise.all(lanes));
}

export class SystemUpgradeResumeRunner implements UpgradeResumeRunner {
  async run(input: UpgradeResumeRunInput): Promise<Partial<Record<EvalRuntime, EvalSuiteResult>>> {
    return await runUpgradeResumeCases(input);
  }
}

