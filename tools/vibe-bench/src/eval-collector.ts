import { createHash } from "node:crypto";

/** One shared corpus case and its runtime-specific grading evidence. */
export interface EvalCaseResult {
  id: string;
  passed: boolean;
  failedGraders: string[];
  skippedGraders: string[];
}

/** Native suite result normalized without manufacturing missing token data. */
export interface EvalSuiteResult {
  runtime: "claude" | "codex";
  cliVersion: string;
  cases: EvalCaseResult[];
  passed: number;
  failed: number;
  wallMs: number;
  costUsd: number | null;
  tokens: Record<string, number> | null;
  nativeHash: string;
}

/** One native process outcome, including invalid artifacts that must stay red. */
export interface EvalRuntimeRecord {
  runtime: "claude" | "codex";
  exitCode: number;
  result: EvalSuiteResult | null;
  invalidReason: string | null;
}

/** Immutable local dual-runtime result consumed by later benchmark disclosure. */
export interface LocalEvalResult {
  schemaVersion: 1;
  pluginSha: string;
  createdAt: string;
  wallMs: number;
  deterministicOnly: boolean;
  selectedCases: string[];
  runtimes: EvalRuntimeRecord[];
  success: boolean;
  resultHash: string;
}

function object(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(reason);
  return value as Record<string, unknown>;
}

function array(value: unknown, reason: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(reason);
  return value;
}

function finite(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(reason);
  return value;
}

/** Map only the three existing persona prefixes used by the Codex mirror. */
export function codexCaseId(id: string): string {
  if (id.startsWith("exec-")) return `executive-${id.slice(5)}`;
  if (id.startsWith("pm-")) return `product-manager-${id.slice(3)}`;
  if (id.startsWith("orch-")) return `orchestrator-${id.slice(5)}`;
  throw new Error(`eval-unknown-case-prefix:${id}`);
}

function exactCoverage(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      [...actual].sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error("eval-case-coverage-mismatch");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Reject a modified combined eval artifact before publication. */
export function verifyLocalEvalHash(result: LocalEvalResult): void {
  const { resultHash, ...payload } = result;
  if (!/^[a-f0-9]{64}$/.test(resultHash) || hash(payload) !== resultHash) {
    throw new Error("eval-result-hash-mismatch");
  }
}

/** Parse one complete native Claude eval JSON against the snapshot's manifest IDs. */
export function collectClaudeEval(raw: unknown, expectedCases: string[], expected: {
  version: string; coreVersion: string; cliVersion: string; vibePath: string; corePath: string;
}): EvalSuiteResult {
  const root = object(raw, "eval-claude-json-invalid");
  if (root.schemaVersion !== 1 || root.partial !== false) throw new Error("eval-claude-partial-or-schema");
  if (root.claudeVersion !== expected.cliVersion) throw new Error("eval-claude-cli-mismatch");
  const suite = object(root.suite, "eval-claude-suite-missing");
  if (suite.ablation !== "none" || suite.modelOverride !== "sonnet") throw new Error("eval-claude-mode-mismatch");
  const plugins = array(suite.plugins, "eval-claude-plugins-missing").map((item) =>
    object(item, "eval-claude-plugin-invalid"));
  if (plugins.length !== 2 || !plugins.some((item) => item.name === "vibe" &&
      item.version === expected.version && item.path === expected.vibePath) ||
      !plugins.some((item) => item.name === "closedloop-core" &&
        item.version === expected.coreVersion && item.path === expected.corePath)) {
    throw new Error("eval-claude-plugin-identity-mismatch");
  }
  const native = array(root.cases, "eval-claude-cases-missing").map((value) =>
    object(value, "eval-claude-case-invalid"));
  exactCoverage(native.map((item) => String(item.name ?? "")), expectedCases);
  const cases = native.map((item): EvalCaseResult => {
    if (item.runsPerCase !== 1) throw new Error("eval-claude-runs-mismatch");
    const arm = array(object(item.arms, "eval-claude-arms-missing").with,
      "eval-claude-with-arm-missing");
    if (arm.length !== 1) throw new Error("eval-claude-with-arm-count");
    const run = object(arm[0], "eval-claude-run-invalid");
    if (typeof run.passed !== "boolean" || run.error != null || run.skippedPaidGraders !== false) {
      throw new Error("eval-claude-run-incomplete");
    }
    const graders = array(run.graders, "eval-claude-graders-missing").map((value) =>
      object(value, "eval-claude-grader-invalid"));
    if (graders.length === 0 || graders.some((grader) => typeof grader.name !== "string" ||
        typeof grader.passed !== "boolean")) throw new Error("eval-claude-graders-invalid");
    const failedGraders = graders.filter((grader) => grader.scored !== false &&
      !grader.passed).map((grader) => String(grader.name));
    if (run.passed !== (failedGraders.length === 0)) throw new Error("eval-claude-grader-conflict");
    return { id: String(item.name), passed: run.passed, failedGraders, skippedGraders: [] };
  });
  const aggregate = object(root.aggregates, "eval-claude-aggregate-missing");
  const passed = cases.filter((item) => item.passed).length;
  if (aggregate.casesTotal !== cases.length || aggregate.casesPassed !== passed) {
    throw new Error("eval-claude-aggregate-mismatch");
  }
  return { runtime: "claude", cliVersion: expected.cliVersion, cases, passed,
    failed: cases.length - passed, wallMs: finite(root.durationSeconds, "eval-claude-duration-invalid") * 1000,
    costUsd: finite(root.costUsd, "eval-claude-cost-invalid"), tokens: null,
    nativeHash: hash(raw) };
}

/** Parse the existing Codex runner's result without counting skipped wording as failure. */
export function collectCodexEval(raw: unknown, expectedCases: string[], expected: {
  sourceSha: string; skillSha: string; version: string; cliVersion: string;
  vibePath: string; deterministicOnly: boolean; model: string; graderModel: string;
  wordingCases: string[];
}): EvalSuiteResult {
  const root = object(raw, "eval-codex-json-invalid");
  const run = object(root.run, "eval-codex-run-missing");
  if (run.source_sha !== expected.sourceSha || run.skill_sha256 !== expected.skillSha ||
      run.version !== expected.version || run.cli_version !== expected.cliVersion ||
      run.plugin !== expected.vibePath || run.deterministic_only !== expected.deterministicOnly ||
      run.model !== expected.model || run.grader_model !== expected.graderModel) {
    throw new Error("eval-codex-identity-mismatch");
  }
  const native = array(root.cases, "eval-codex-cases-missing").map((value) =>
    object(value, "eval-codex-case-invalid"));
  exactCoverage(native.map((item) => String(item.case ?? "")), expectedCases.map(codexCaseId));
  const cases = native.map((item): EvalCaseResult => {
    if (typeof item.passed !== "boolean") throw new Error("eval-codex-pass-missing");
    const checks = array(item.checks, "eval-codex-checks-missing").map((value) =>
      object(value, "eval-codex-check-invalid"));
    if (checks.length === 0 || checks.some((check) => typeof check.grader !== "string" ||
        typeof check.passed !== "boolean")) throw new Error("eval-codex-checks-invalid");
    const failedGraders = checks.filter((check) => !check.passed).map((check) => String(check.grader));
    const skipped = array(item.skipped_graders, "eval-codex-skips-missing").map((value) =>
      object(value, "eval-codex-skip-invalid"));
    if (skipped.some((skip) => skip.grader !== "plain-language" ||
        skip.reason !== "deterministic-only") ||
        (!expected.deterministicOnly && skipped.length > 0)) throw new Error("eval-codex-skip-invalid");
    if (item.passed !== (failedGraders.length === 0)) throw new Error("eval-codex-check-conflict");
    const source = expectedCases.find((id) => codexCaseId(id) === item.case);
    if (!source) throw new Error("eval-codex-case-unmapped");
    const skipExpected = expected.deterministicOnly && expected.wordingCases.includes(source);
    if (skipped.length !== (skipExpected ? 1 : 0)) throw new Error("eval-codex-skip-mismatch");
    return { id: source, passed: item.passed, failedGraders,
      skippedGraders: skipped.map((skip) => String(skip.grader)) };
  });
  const tokens = object(run.usage, "eval-codex-usage-missing");
  const normalizedTokens: Record<string, number> = {};
  for (const [key, value] of Object.entries(tokens)) normalizedTokens[key] = finite(value,
    `eval-codex-token-invalid:${key}`);
  const passed = cases.filter((item) => item.passed).length;
  return { runtime: "codex", cliVersion: expected.cliVersion, cases, passed,
    failed: cases.length - passed, wallMs: finite(run.elapsed_seconds,
      "eval-codex-duration-invalid") * 1000, costUsd: null, tokens: normalizedTokens,
    nativeHash: hash(raw) };
}


/** Finalize exactly one complete result from each runtime, preserving red cases. */
export function finalizeLocalEval(input: Omit<LocalEvalResult, "schemaVersion" | "success" |
  "resultHash" | "runtimes"> & { runtimes: EvalRuntimeRecord[] }): LocalEvalResult {
  if (!/^[a-f0-9]{40}$/.test(input.pluginSha)) throw new Error("eval-plugin-sha-invalid");
  exactCoverage(input.selectedCases, [...input.selectedCases].sort());
  if (input.runtimes.length !== 2 || new Set(input.runtimes.map((item) => item.runtime)).size !== 2 ||
      !input.runtimes.some((item) => item.runtime === "claude") ||
      !input.runtimes.some((item) => item.runtime === "codex")) {
    throw new Error("eval-runtime-coverage-mismatch");
  }
  const runtimes = [...input.runtimes].sort((left, right) => left.runtime.localeCompare(right.runtime));
  for (const record of runtimes) {
    if (record.result) {
      if (record.invalidReason || record.result.runtime !== record.runtime) {
        throw new Error("eval-runtime-record-conflict");
      }
      exactCoverage(record.result.cases.map((item) => item.id), input.selectedCases);
      const expectedExit = record.result.failed === 0 ? 0 : 1;
      if (record.exitCode !== expectedExit) throw new Error("eval-runtime-exit-mismatch");
    } else if (!record.invalidReason) {
      throw new Error("eval-runtime-invalid-reason-missing");
    }
  }
  const payload = {
    schemaVersion: 1 as const,
    pluginSha: input.pluginSha,
    createdAt: input.createdAt,
    wallMs: finite(input.wallMs, "eval-wall-invalid"),
    deterministicOnly: input.deterministicOnly,
    selectedCases: [...input.selectedCases],
    runtimes,
    success: runtimes.every((item) => item.result?.failed === 0),
  };
  return { ...payload, resultHash: hash(payload) };
}

/** Human report with identities and counts, but no developer-machine paths. */
export function buildLocalEvalReport(result: LocalEvalResult): string {
  const lines = [
    "# Vibe local dual-runtime eval",
    "",
    `Plugin ${result.pluginSha}; result hash \`${result.resultHash}\`.`,
    `Cases ${result.selectedCases.length}; wall ${result.wallMs} ms; ` +
      `Codex deterministic-only ${result.deterministicOnly ? "yes" : "no"}.`,
    `Verdict: ${result.success ? "PASS" : "FAIL"}.`,
    "",
    "| runtime | status | passed | failed | CLI | native hash |",
    "| --- | --- | ---: | ---: | --- | --- |",
  ];
  for (const record of result.runtimes) {
    const suite = record.result;
    lines.push(`| ${record.runtime} | ${suite ? "complete" : record.invalidReason} | ` +
      `${suite?.passed ?? 0} | ${suite?.failed ?? result.selectedCases.length} | ` +
      `${suite?.cliVersion ?? "unknown"} | ${suite?.nativeHash ?? "unavailable"} |`);
  }
  lines.push("", "## Failed or skipped graders", "");
  const findings = result.runtimes.flatMap((record) => record.result?.cases.flatMap((item) => [
    ...item.failedGraders.map((grader) => `${record.runtime} ${item.id}: failed ${grader}`),
    ...item.skippedGraders.map((grader) => `${record.runtime} ${item.id}: skipped ${grader}`),
  ]) ?? []);
  lines.push(...(findings.length ? findings.map((item) => `- ${item}`) : ["None."]));
  return `${lines.join("\n")}\n`;
}
