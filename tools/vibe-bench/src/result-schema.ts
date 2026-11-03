import { createHash } from "node:crypto";

/** Only Claude Code is a benchmark runtime; model-driven evals have a separate contract. */
export type BenchmarkShape = "vibe" | "fleet-one-writer";
/** The exclusive top-level owner of a model call. */
export type TopComponent = "vibe" | "fleet-orchestrator" | "unattributed";
/** A phase named only when a tool or worker record supports it. */
export type BenchmarkPhase = "startup" | "requirements" | "build" | "deploy" | "review" | "handoff" | "pr";

/** Claude's input excludes cache reads and writes; uncached input equals input. */
export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
}

/** Request detail can omit output when no reconciled OTEL request exists. */
export interface CallTokens {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number | null;
  thinkingTokens: number | null;
}

/** One deduplicated model request with evidence-backed attribution. */
export interface ModelCall {
  id: string;
  messageId: string | null;
  requestId: string | null;
  model: string;
  effort: string | null;
  tokens: CallTokens | null;
  durationMs: number | null;
  component: TopComponent;
  unattributedReason: string | null;
  skill: string | null;
  worker: string | null;
  phase: BenchmarkPhase | null;
  declaredAgentModel: string | null;
  source: "transcript" | "otel" | "both";
}

/** Fixed metadata supplied by the owned local run, never inferred from text. */
export interface ClaudeRunIdentity {
  id: string;
  shape: BenchmarkShape;
  pluginSha: string;
  taskId: string;
  taskVersion: string;
  fixtureVersion: string;
  cliVersion: string;
  configuredModel: string;
  configuredEffort: string;
  startedAt: string;
  stackSetupMs: number;
  stackTeardownMs: number;
  wallMs: number;
  oraclePassed: boolean;
  noOutOfScopeEdits: boolean;
  taskComplete: boolean;
  prDraftRecordedAndClosed: boolean;
}

/** Versioned, hash-stamped local measurement artifact. */
export interface ClaudeBenchmarkResult {
  schemaVersion: 1;
  runtime: "claude";
  identity: ClaudeRunIdentity;
  observedModel: string | null;
  observedEffort: string | null;
  agentModels: Record<string, string>;
  valid: boolean;
  invalidReasons: string[];
  success: boolean;
  costUsd: number;
  modelCalls: number;
  totals: TokenTotals;
  calls: ModelCall[];
  resultHash: string;
}

/** Hash only the immutable measurement payload, excluding its own digest. */
export function resultHash(result: Omit<ClaudeBenchmarkResult, "resultHash">): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

/** Reject altered or partial JSON before it enters a baseline or comparison. */
export function verifyResultHash(result: ClaudeBenchmarkResult): void {
  const { resultHash: expected, ...payload } = result;
  if (!/^[a-f0-9]{64}$/.test(expected) || resultHash(payload) !== expected) {
    throw new Error("benchmark-result-hash-mismatch");
  }
}
