import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EvalCaseDefinition } from "./eval-selection.ts";
import type { EvalRuntime, EvalSkill } from "./eval-policy.ts";
import { EVAL_POLICY } from "./eval-policy.ts";
import type { LocalEvalResult } from "./eval-collector.ts";
import { verifyLocalEvalHash } from "./eval-collector.ts";

/** Human-owned waiver for one runtime-case pair that is failing on main. */
export interface EvalQuarantineEntry {
  runtime: EvalRuntime;
  case: string;
  reason: string;
  owner: string;
  deadline: string;
}

/** Rolling reliability evidence for one case on one runtime. */
export interface EvalBaselineOutcome {
  observations: number;
  passes: number;
  passRate: number;
  reliable: boolean;
  nightlies: number;
  recentNightlyOutcomes: Array<{ passes: number; runs: number }>;
}

/** Content-keyed case evidence retained by the stored T2 baseline. */
export interface EvalBaselineCase {
  id: string;
  skill: EvalSkill;
  contentHash: string;
  outcomes: Partial<Record<EvalRuntime, EvalBaselineOutcome>>;
}

/** Stored T2 result used by later nightlies and on-demand benchmarks. */
export interface EvalBaselineArtifact {
  schemaVersion: 2;
  createdAt: string;
  pluginSha: string;
  pluginTreeSha: string;
  pluginVersion: string;
  runs: number;
  models: {
    claude: string;
    claudeJudge: string;
    codex: string;
    codexJudge: string;
  };
  /** Paid costs for this nightly, split so judge share remains observable. */
  costs?: Partial<Record<EvalRuntime, {
    agentUsd: number | null;
    judgeUsd: number | null;
    totalUsd: number | null;
  }>>;
  sourceResultHashes: string[];
  historyResultHashes: string[];
  cases: EvalBaselineCase[];
  quarantine: EvalQuarantineEntry[];
  resultHash: string;
}

/** Atomic pointer to the newest accepted main baseline and retained history. */
export interface EvalBaselineIndex {
  schemaVersion: 1;
  updatedAt: string;
  latestFile: string;
  latestResultHash: string;
  latestGreenFile?: string;
  latestGreenResultHash?: string;
  history: Array<{ file: string; resultHash: string; pluginSha: string; createdAt: string }>;
  resultHash: string;
}

export const EVAL_BASELINE_INDEX_FILE = "eval-t2-latest.json";

/** Stable file name for one immutable baseline before its pointer is advanced. */
export function evalBaselineFileName(artifact: EvalBaselineArtifact): string {
  return `eval-t2-${artifact.pluginVersion}-${artifact.pluginSha.slice(0, 12)}-${artifact.resultHash.slice(0, 12)}.json`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Load the reviewed main-failure quarantine with its shared owner and deadline. */
export function loadEvalQuarantine(): EvalQuarantineEntry[] {
  const raw = JSON.parse(readFileSync(new URL("../eval-quarantine.json", import.meta.url), "utf8")) as {
    schemaVersion?: unknown; owner?: unknown; deadline?: unknown;
    entries?: Array<{ runtime?: unknown; case?: unknown; reason?: unknown }>;
  };
  if (raw.schemaVersion !== 1 || typeof raw.owner !== "string" || !raw.owner ||
      typeof raw.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.deadline) ||
      !Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error("eval-quarantine-invalid");
  }
  const entries = raw.entries.map((entry): EvalQuarantineEntry => {
    if ((entry.runtime !== "claude" && entry.runtime !== "codex") ||
        typeof entry.case !== "string" || !entry.case || typeof entry.reason !== "string" || !entry.reason) {
      throw new Error("eval-quarantine-entry-invalid");
    }
    return { runtime: entry.runtime, case: entry.case, reason: entry.reason,
      owner: raw.owner as string, deadline: raw.deadline as string };
  });
  if (new Set(entries.map((item) => `${item.runtime}:${item.case}`)).size !== entries.length) {
    throw new Error("eval-quarantine-duplicate");
  }
  return entries;
}

function runtimeCases(result: LocalEvalResult, runtime: EvalRuntime) {
  const record = result.runtimes.find((item) => item.runtime === runtime);
  if (!record?.result || record.invalidReason) throw new Error("eval-baseline-runtime-incomplete");
  return new Map(record.result.cases.map((item) => [item.id, item]));
}

function runtimeCosts(results: LocalEvalResult[], runtime: EvalRuntime) {
  const suites = results.flatMap((result) => {
    const suite = result.runtimes.find((item) => item.runtime === runtime)?.result;
    return suite ? [suite] : [];
  });
  const sum = (key: "agentCostUsd" | "judgeCostUsd" | "costUsd") =>
    suites.every((suite) => suite[key] !== null)
      ? suites.reduce((total, suite) => total + (suite[key] ?? 0), 0) : null;
  return { agentUsd: sum("agentCostUsd"), judgeUsd: sum("judgeCostUsd"),
    totalUsd: sum("costUsd") };
}

/** Combine one full nightly plus failure-only retries into the immutable baseline. */
export function buildEvalBaseline(input: {
  results: LocalEvalResult[];
  catalog: EvalCaseDefinition[];
  pluginVersion: string;
  pluginTreeSha?: string;
  previous?: EvalBaselineArtifact;
  createdAt?: string;
}): EvalBaselineArtifact {
  if (input.results.length < 1 || input.results.length > 1 + EVAL_POLICY.failureReruns * 2 ||
      !/^\d+\.\d+\.\d+$/.test(input.pluginVersion) || input.catalog.length === 0 ||
      (input.pluginTreeSha !== undefined && !/^[a-f0-9]{40}$/.test(input.pluginTreeSha))) {
    throw new Error("eval-baseline-input-invalid");
  }
  if (input.previous) verifyEvalBaseline(input.previous);
  input.results.forEach(verifyLocalEvalHash);
  const pluginSha = input.results[0].pluginSha;
  const previousCases = new Map(input.previous?.cases.map((item) => [item.id, item]) ?? []);
  const expected = input.catalog.map((item) => item.id).sort();
  for (const [index, result] of input.results.entries()) {
    if (result.pluginSha !== pluginSha || result.deterministicOnly ||
        result.selectedCases.some((id) => !expected.includes(id)) ||
        (index === 0 && (result.selectedCases.join("\0") !== expected.join("\0") ||
          result.runtimes.length !== 2)) ||
        (index > 0 && result.runtimes.length !== 1)) throw new Error("eval-baseline-run-mismatch");
  }
  for (const runtime of ["claude", "codex"] as const) {
    const prior = new Map<string, boolean[]>();
    for (const result of input.results) {
      const record = result.runtimes.find((item) => item.runtime === runtime);
      if (!record) continue;
      if (!record.result || record.invalidReason) throw new Error("eval-baseline-runtime-incomplete");
      for (const item of record.result.cases) {
        const outcomes = prior.get(item.id) ?? [];
        if (outcomes.some(Boolean)) throw new Error("eval-baseline-passing-case-rerun");
        outcomes.push(item.passed);
        prior.set(item.id, outcomes);
      }
    }
  }
  const cases = input.catalog.map((definition): EvalBaselineCase => {
    const outcomes: EvalBaselineCase["outcomes"] = {};
    for (const runtime of ["claude", "codex"] as const) {
      const observations = input.results.flatMap((result) => {
        const record = result.runtimes.find((item) => item.runtime === runtime);
        return record ? [runtimeCases(result, runtime).get(definition.id)] : [];
      }).filter((item): item is NonNullable<typeof item> => item !== undefined);
      if (!observations.length || observations.length > 1 + EVAL_POLICY.failureReruns) {
        throw new Error("eval-baseline-case-missing");
      }
      const currentPasses = observations.some((item) => item.passed) ? 1 : 0;
      const previous = previousCases.get(definition.id);
      const prior = previous?.contentHash === definition.contentHash ? previous.outcomes[runtime] : undefined;
      const totalObservations = 1 + (prior?.observations ?? 0);
      const passes = currentPasses + (prior?.passes ?? 0);
      const passRate = passes / totalObservations;
      const recentNightlyOutcomes = [...(prior?.recentNightlyOutcomes ?? []),
        { passes: currentPasses, runs: 1 }].slice(-5);
      const recentObservations = recentNightlyOutcomes.reduce((sum, item) => sum + item.runs, 0);
      const recentPasses = recentNightlyOutcomes.reduce((sum, item) => sum + item.passes, 0);
      outcomes[runtime] = { observations: totalObservations, passes, passRate,
        reliable: recentObservations >= EVAL_POLICY.reliabilityMinimumObservations &&
          recentPasses / recentObservations >= EVAL_POLICY.reliabilityThreshold,
        nightlies: (prior?.nightlies ?? 0) + 1, recentNightlyOutcomes };
    }
    return { ...definition, outcomes };
  });
  const quarantine = loadEvalQuarantine();
  const payload: Omit<EvalBaselineArtifact, "resultHash"> = {
    schemaVersion: 2, createdAt: input.createdAt ?? new Date().toISOString(), pluginSha,
    pluginTreeSha: input.pluginTreeSha ?? pluginSha, pluginVersion: input.pluginVersion, runs: 1,
    models: { claude: EVAL_POLICY.claudeModel, claudeJudge: EVAL_POLICY.claudeJudgeModel,
      codex: EVAL_POLICY.codexModel, codexJudge: EVAL_POLICY.codexJudgeModel },
    costs: { claude: runtimeCosts(input.results, "claude"),
      codex: runtimeCosts(input.results, "codex") },
    sourceResultHashes: input.results.map((result) => result.resultHash),
    historyResultHashes: input.previous
      ? [...input.previous.historyResultHashes, input.previous.resultHash].slice(-5) : [], cases, quarantine,
  };
  return { ...payload, resultHash: hash(payload) };
}

/** Reject a modified or structurally invalid immutable T2 baseline. */
export function verifyEvalBaseline(result: EvalBaselineArtifact): void {
  const { resultHash, ...payload } = result;
  if (!/^[a-f0-9]{64}$/.test(resultHash) || hash(payload) !== resultHash || result.schemaVersion !== 2 ||
      !/^[a-f0-9]{40}$/.test(result.pluginSha) || !/^[a-f0-9]{40}$/.test(result.pluginTreeSha) ||
      ![1, 3].includes(result.runs) || !result.models.claude || !result.models.claudeJudge ||
      !result.models.codex || !result.models.codexJudge || !result.cases.length ||
      (result.costs !== undefined && Object.values(result.costs).some((cost) => !cost ||
        [cost.agentUsd, cost.judgeUsd, cost.totalUsd].some((value) =>
          value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) ||
        (cost.agentUsd !== null && cost.judgeUsd !== null && cost.totalUsd !== null &&
          Math.abs(cost.agentUsd + cost.judgeUsd - cost.totalUsd) > 0.000001))) ||
      result.cases.some((item) => [item.outcomes.claude, item.outcomes.codex].some((outcome) =>
        !outcome || outcome.observations < 1 || outcome.passes < 0 ||
        outcome.passes > outcome.observations || outcome.nightlies < 1 ||
        outcome.recentNightlyOutcomes.length < 1 || outcome.recentNightlyOutcomes.length > 5 ||
        outcome.recentNightlyOutcomes.some((item) => !Number.isInteger(item.passes) ||
          !Number.isInteger(item.runs) || ![1, 3].includes(item.runs) ||
          item.passes < 0 || item.passes > item.runs)))) {
    throw new Error("eval-baseline-hash-mismatch");
  }
}

/** True only when a stored lineage used the models selected by current source policy. */
export function evalBaselineModelsMatchPolicy(result: EvalBaselineArtifact): boolean {
  return result.models.claude === EVAL_POLICY.claudeModel &&
    result.models.claudeJudge === EVAL_POLICY.claudeJudgeModel &&
    result.models.codex === EVAL_POLICY.codexModel &&
    result.models.codexJudge === EVAL_POLICY.codexJudgeModel;
}

/** Load source-owned quarantine and identify entries whose waiver has expired. */
export function evalQuarantineStatus(now = new Date()): {
  entries: EvalQuarantineEntry[];
  expired: EvalQuarantineEntry[];
} {
  const entries = loadEvalQuarantine();
  const today = now.toISOString().slice(0, 10);
  return { entries, expired: entries.filter((entry) => entry.deadline < today) };
}

/** Whether one waiver still applies at the named nightly's creation time. */
export function evalQuarantineEntryIsActive(entry: EvalQuarantineEntry, createdAt: string): boolean {
  return entry.deadline >= createdAt.slice(0, 10);
}

/** Refresh quarantine metadata without altering stored model observations. */
export function reconcileEvalBaselineQuarantine(result: EvalBaselineArtifact,
  quarantine: EvalQuarantineEntry[], createdAt = new Date().toISOString()): EvalBaselineArtifact {
  verifyEvalBaseline(result);
  if (JSON.stringify(result.quarantine) === JSON.stringify(quarantine)) return result;
  const { resultHash: _priorHash, ...prior } = result;
  const payload: Omit<EvalBaselineArtifact, "resultHash"> = { ...prior, createdAt, quarantine,
    historyResultHashes: [...result.historyResultHashes, result.resultHash].slice(-5) };
  return { ...payload, resultHash: hash(payload) };
}

function verifyIndex(index: EvalBaselineIndex): void {
  const { resultHash, ...payload } = index;
  if (index.schemaVersion !== 1 || hash(payload) !== resultHash ||
      basename(index.latestFile) !== index.latestFile ||
      !/^[a-f0-9]{64}$/.test(index.latestResultHash) || !index.history.length ||
      index.history[0].file !== index.latestFile ||
      index.history[0].resultHash !== index.latestResultHash ||
      ((index.latestGreenFile === undefined) !== (index.latestGreenResultHash === undefined)) ||
      (index.latestGreenFile !== undefined && (basename(index.latestGreenFile) !== index.latestGreenFile ||
        !/^[a-f0-9]{64}$/.test(index.latestGreenResultHash ?? ""))) ||
      index.history.some((item) => basename(item.file) !== item.file ||
        !/^[a-f0-9]{64}$/.test(item.resultHash) || !/^[a-f0-9]{40}$/.test(item.pluginSha))) {
    throw new Error("eval-baseline-index-invalid");
  }
}

/** Resolve only the atomic newest baseline from the named local results store. */
export function resolveLatestEvalBaseline(storeDir: string): {
  artifact: EvalBaselineArtifact; file: string; index: EvalBaselineIndex;
} {
  const indexFile = join(storeDir, EVAL_BASELINE_INDEX_FILE);
  if (!existsSync(indexFile)) throw new Error("eval-baseline-index-missing");
  const index = JSON.parse(readFileSync(indexFile, "utf8")) as EvalBaselineIndex;
  verifyIndex(index);
  const file = join(storeDir, index.latestFile);
  const artifact = JSON.parse(readFileSync(file, "utf8")) as EvalBaselineArtifact;
  verifyEvalBaseline(artifact);
  if (artifact.resultHash !== index.latestResultHash) {
    throw new Error("eval-baseline-index-mismatch");
  }
  return { artifact, file, index };
}

/** Atomically publish one accepted main baseline as the store's newest entry. */
export function publishEvalBaseline(storeDir: string, artifact: EvalBaselineArtifact,
  options: { resetLineage?: boolean } = {}): string {
  verifyEvalBaseline(artifact);
  const existing = existsSync(join(storeDir, EVAL_BASELINE_INDEX_FILE))
    ? resolveLatestEvalBaseline(storeDir) : null;
  if (existing && !options.resetLineage &&
      artifact.historyResultHashes.at(-1) !== existing.index.latestResultHash) {
    throw new Error("eval-baseline-lineage-mismatch");
  }
  const fileName = evalBaselineFileName(artifact);
  const file = join(storeDir, fileName);
  if (existsSync(file)) {
    let retained: EvalBaselineArtifact;
    try { retained = JSON.parse(readFileSync(file, "utf8")) as EvalBaselineArtifact; }
    catch { throw new Error("eval-baseline-existing-artifact-malformed"); }
    verifyEvalBaseline(retained);
    if (retained.resultHash !== artifact.resultHash || JSON.stringify(retained) !== JSON.stringify(artifact)) {
      throw new Error("eval-baseline-existing-artifact-conflict");
    }
  } else {
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const history = [
    { file: fileName, resultHash: artifact.resultHash, pluginSha: artifact.pluginSha,
      createdAt: artifact.createdAt },
    ...(options.resetLineage ? [] : existing?.index.history ?? []),
  ].slice(0, 5);
  const currentGreen = isGreenEvalBaseline(artifact);
  const priorGreenFile = options.resetLineage ? undefined : existing?.index.latestGreenFile ??
    (existing && isGreenEvalBaseline(existing.artifact) ? existing.index.latestFile : undefined);
  const priorGreenHash = options.resetLineage ? undefined : existing?.index.latestGreenResultHash ??
    (existing && isGreenEvalBaseline(existing.artifact) ? existing.index.latestResultHash : undefined);
  const payload: Omit<EvalBaselineIndex, "resultHash"> = {
    schemaVersion: 1, updatedAt: new Date().toISOString(), latestFile: fileName,
    latestResultHash: artifact.resultHash,
    ...(currentGreen
      ? { latestGreenFile: fileName, latestGreenResultHash: artifact.resultHash }
      : priorGreenFile && priorGreenHash
        ? { latestGreenFile: priorGreenFile, latestGreenResultHash: priorGreenHash } : {}),
    history,
  };
  const index: EvalBaselineIndex = { ...payload, resultHash: hash(payload) };
  const temporary = join(storeDir, `.${EVAL_BASELINE_INDEX_FILE}.${process.pid}`);
  writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(storeDir, EVAL_BASELINE_INDEX_FILE));
  return file;
}

/** Load retained baselines newest first for regression and ownership reports. */
export function resolveEvalBaselineHistory(storeDir: string): EvalBaselineArtifact[] {
  const { index } = resolveLatestEvalBaseline(storeDir);
  return index.history.map((entry) => {
    const artifact = JSON.parse(readFileSync(join(storeDir, entry.file), "utf8")) as EvalBaselineArtifact;
    verifyEvalBaseline(artifact);
    if (artifact.resultHash !== entry.resultHash || artifact.pluginSha !== entry.pluginSha) {
      throw new Error("eval-baseline-history-mismatch");
    }
    return artifact;
  });
}

/** Resolve the durable last-green pointer, including a legacy latest-green store. */
export function resolveLastGreenEvalBaseline(storeDir: string): EvalBaselineArtifact | null {
  const latest = resolveLatestEvalBaseline(storeDir);
  const fileName = latest.index.latestGreenFile ??
    (isGreenEvalBaseline(latest.artifact) ? latest.index.latestFile : null);
  const expectedHash = latest.index.latestGreenResultHash ??
    (fileName ? latest.artifact.resultHash : null);
  if (!fileName || !expectedHash) return null;
  const artifact = JSON.parse(readFileSync(join(storeDir, fileName), "utf8")) as EvalBaselineArtifact;
  verifyEvalBaseline(artifact);
  if (artifact.resultHash !== expectedHash || !isGreenEvalBaseline(artifact)) {
    throw new Error("eval-baseline-green-pointer-mismatch");
  }
  return artifact;
}

/** A green nightly has no confirmed, non-quarantined failure. */
export function isGreenEvalBaseline(artifact: EvalBaselineArtifact): boolean {
  const quarantined = new Set(artifact.quarantine
    .filter((entry) => evalQuarantineEntryIsActive(entry, artifact.createdAt))
    .map((entry) => `${entry.runtime}:${entry.case}`));
  return artifact.cases.every((item) => (["claude", "codex"] as const).every((runtime) => {
    const outcome = item.outcomes[runtime];
    const last = outcome?.recentNightlyOutcomes.at(-1);
    return last?.passes === last?.runs ||
      quarantined.has(`${runtime}:${item.id}`);
  }));
}
