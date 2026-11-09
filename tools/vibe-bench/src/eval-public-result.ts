import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalBaselineArtifact } from "./eval-baseline.ts";
import { evalBaselineModelsMatchPolicy } from "./eval-baseline.ts";
import type { LocalEvalResult } from "./eval-collector.ts";
import { verifyLocalEvalHash } from "./eval-collector.ts";

export type PublicCaseStatus = "pass" | "fail" | "unavailable";

/** The complete public schema. No private eval artifact is serialized directly. */
export interface PublicEvalResult {
  schemaVersion: 1;
  pluginVersion: string;
  pluginSha: string;
  runAt: string;
  models: { claude: string; claudeJudge: string; codex: string; codexJudge: string };
  runtimes: Array<{
    runtime: "claude" | "codex";
    totalCostUsd?: number;
    cases: Array<{ id: string; status: PublicCaseStatus; retryCount: number }>;
  }>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("eval-public-shape-invalid");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const actual = Object.keys(value);
  if (required.some((key) => !(key in value)) ||
      actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("eval-public-field-not-allowlisted");
  }
}

/** Shared field validation; only local comparison can relax runtime cardinality. */
function validateEvalResult(value: unknown, allowSingleRuntime: boolean): PublicEvalResult {
  const root = record(value);
  keys(root, ["schemaVersion", "pluginVersion", "pluginSha", "runAt", "models", "runtimes"]);
  if (root.schemaVersion !== 1 || typeof root.pluginVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(root.pluginVersion) || typeof root.pluginSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(root.pluginSha) || typeof root.runAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(root.runAt) ||
      Number.isNaN(Date.parse(root.runAt))) throw new Error("eval-public-identity-invalid");
  const models = record(root.models);
  keys(models, ["claude", "claudeJudge", "codex", "codexJudge"]);
  if (Object.values(models).some((model) => typeof model !== "string" ||
      !/^(?:claude-|gpt-|o[1-9])[a-zA-Z0-9._-]{1,99}$/.test(model) ||
      /\.(?:com|net|org|local|lan|internal)$/i.test(model))) {
    throw new Error("eval-public-model-invalid");
  }
  if (!Array.isArray(root.runtimes) ||
      (root.runtimes.length !== 2 && !(allowSingleRuntime && root.runtimes.length === 1))) {
    throw new Error("eval-public-runtime-invalid");
  }
  const seen = new Set<string>();
  let expectedIds: string | null = null;
  for (const rawRuntime of root.runtimes) {
    const runtime = record(rawRuntime);
    keys(runtime, ["runtime", "cases"], ["totalCostUsd"]);
    if ((runtime.runtime !== "claude" && runtime.runtime !== "codex") ||
        seen.has(runtime.runtime)) throw new Error("eval-public-runtime-invalid");
    seen.add(runtime.runtime);
    if (runtime.totalCostUsd !== undefined &&
        (typeof runtime.totalCostUsd !== "number" || !Number.isFinite(runtime.totalCostUsd) ||
          runtime.totalCostUsd < 0)) throw new Error("eval-public-cost-invalid");
    if (!Array.isArray(runtime.cases) || runtime.cases.length === 0) {
      throw new Error("eval-public-cases-invalid");
    }
    const ids = new Set<string>();
    for (const rawCase of runtime.cases) {
      const item = record(rawCase);
      keys(item, ["id", "status", "retryCount"]);
      if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,159}$/.test(item.id) ||
          ids.has(item.id) || typeof item.status !== "string" ||
          !["pass", "fail", "unavailable"].includes(item.status) ||
          !Number.isInteger(item.retryCount) || (item.retryCount as number) < 0 ||
          (item.retryCount as number) > 2 ||
          (item.status === "unavailable" && item.retryCount !== 0)) {
        throw new Error("eval-public-case-invalid");
      }
      ids.add(item.id);
    }
    const identity = [...ids].sort().join("\0");
    if (expectedIds !== null && expectedIds !== identity) throw new Error("eval-public-coverage-invalid");
    expectedIds = identity;
  }
  return value as PublicEvalResult;
}

/** Fail closed on unexpected fields and require both runtimes for published JSON. */
export function validatePublicEvalResult(value: unknown): PublicEvalResult {
  return validateEvalResult(value, false);
}

/** Derive one publishable summary from the private baseline and its hashed local runs. */
export function projectPublicEvalResult(baseline: EvalBaselineArtifact,
  results: LocalEvalResult[], runAt: string): PublicEvalResult {
  if (!evalBaselineModelsMatchPolicy(baseline)) throw new Error("eval-public-model-policy-mismatch");
  const expectedHashes = new Set(baseline.sourceResultHashes);
  if (results.length !== expectedHashes.size || results.some((result) => {
    verifyLocalEvalHash(result);
    return !expectedHashes.has(result.resultHash) || result.pluginSha !== baseline.pluginSha;
  }) || new Set(results.map((result) => result.resultHash)).size !== results.length) {
    throw new Error("eval-public-source-results-mismatch");
  }
  const first = results[0];
  if (!first || first.runtimes.length !== 2 ||
      first.selectedCases.slice().sort().join("\0") !==
        baseline.cases.map((item) => item.id).sort().join("\0")) {
    throw new Error("eval-public-source-results-mismatch");
  }
  const runtimes = (["claude", "codex"] as const).map((runtime) => {
    const cases = baseline.cases.map((item) => {
      const outcome = item.outcomes[runtime];
      if (!outcome) throw new Error("eval-public-outcome-missing");
      const latest = outcome.recentNightlyOutcomes.at(-1);
      if (outcome.latestAvailability?.status !== "unavailable" &&
          (!latest || latest.runs !== 1 || ![0, 1].includes(latest.passes))) {
        throw new Error("eval-public-outcome-missing");
      }
      const status: PublicCaseStatus = outcome.latestAvailability?.status === "unavailable"
        ? "unavailable" : latest!.passes === 1 ? "pass" : "fail";
      const retryCount = results.slice(1).filter((result) => result.runtimes.some((entry) =>
        entry.runtime === runtime && entry.result?.cases.some((candidate) => candidate.id === item.id))).length;
      return { id: item.id, status, retryCount };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const totalCostUsd = baseline.costs?.[runtime]?.totalUsd;
    return { runtime, ...(totalCostUsd === null || totalCostUsd === undefined
      ? {} : { totalCostUsd }), cases };
  });
  return validatePublicEvalResult({ schemaVersion: 1, pluginVersion: baseline.pluginVersion,
    pluginSha: baseline.pluginSha, runAt, models: { claude: baseline.models.claude,
      claudeJudge: baseline.models.claudeJudge, codex: baseline.models.codex,
      codexJudge: baseline.models.codexJudge }, runtimes });
}

/** Read only verified result hashes from the private nightly store. */
export function readPublicSourceResults(store: string, baseline: EvalBaselineArtifact): LocalEvalResult[] {
  const hashes = new Set(baseline.sourceResultHashes);
  if (hashes.size !== baseline.sourceResultHashes.length ||
      [...hashes].some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("eval-public-source-hash-invalid");
  }
  const found = new Map<string, LocalEvalResult>();
  for (const name of readdirSync(store)) {
    if (!/^eval-\d{4}-\d{2}-\d{2}T.*\.json$/.test(name)) continue;
    let result: LocalEvalResult;
    try { result = JSON.parse(readFileSync(join(store, name), "utf8")) as LocalEvalResult; }
    catch { continue; }
    if (!hashes.has(result.resultHash)) continue;
    verifyLocalEvalHash(result);
    if (found.has(result.resultHash)) throw new Error("eval-public-source-duplicate");
    found.set(result.resultHash, result);
  }
  return baseline.sourceResultHashes.map((hash) => {
    const result = found.get(hash);
    if (!result) throw new Error("eval-public-source-missing");
    return result;
  });
}

/** Print only observed pass/fail transitions; unavailable is a third status. */
export function comparePublicEvalResults(baseline: PublicEvalResult, current: PublicEvalResult): string {
  validatePublicEvalResult(baseline);
  validateEvalResult(current, true);
  const before = new Map(baseline.runtimes.flatMap((runtime) => runtime.cases.map((item) =>
    [`${runtime.runtime}:${item.id}`, item.status] as const)));
  const lines: string[] = [];
  for (const runtime of current.runtimes) for (const item of runtime.cases) {
    const prior = before.get(`${runtime.runtime}:${item.id}`);
    // A case absent from the baseline has no pass/fail transition to report.
    if (prior === undefined || prior === item.status) continue;
    const transition = prior === "unavailable" || item.status === "unavailable"
      ? "unavailable" : item.status === "fail" ? "new failure" : "new pass";
    lines.push(`${transition} ${runtime.runtime} ${item.id} (${prior} -> ${item.status})`);
  }
  return lines.length ? lines.join("\n") : "No changed cases";
}

/** Normalize an on-demand local run for comparison without publishing its private fields. */
export function localRunForCompare(value: unknown, baseline: PublicEvalResult): PublicEvalResult {
  const candidate = record(value);
  if (candidate.schemaVersion === 1 && "models" in candidate) {
    return validatePublicEvalResult(candidate);
  }
  const local = value as LocalEvalResult;
  verifyLocalEvalHash(local);
  if (local.runtimes.length < 1 || local.runtimes.length > 2 || local.runtimes.some((item) =>
    item.invalidReason || !item.result)) throw new Error("eval-compare-local-incomplete");
  const runtimes = local.runtimes.map((entry) => ({ runtime: entry.runtime,
    cases: entry.result!.cases.map((item) => ({ id: item.id,
      status: item.unavailableReason !== undefined ? "unavailable" as const :
        item.passed ? "pass" as const : "fail" as const, retryCount: 0 })) }));
  return validateEvalResult({ schemaVersion: 1,
    pluginVersion: baseline.pluginVersion, pluginSha: local.pluginSha,
    runAt: local.createdAt, models: baseline.models, runtimes }, true);
}
