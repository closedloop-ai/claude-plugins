import { BENCHMARK_EFFORT, BENCHMARK_MODEL, requirePinnedClaude } from "./contract.ts";
import { attributeCall, phaseFromTool } from "./attribution.ts";
import type { BenchmarkPhase, CallTokens, ClaudeBenchmarkResult, ClaudeRunIdentity, ModelCall, TokenTotals } from "./result-schema.ts";
import { resultHash } from "./result-schema.ts";

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  requestId?: string;
  parent_tool_use_id?: string | null;
  parentToolUseID?: string | null;
  effort?: string;
  perTurnEffort?: string;
  model?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }>;
  };
  modelUsage?: Record<string, Record<string, unknown>>;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  is_error?: boolean;
  result_index?: number;
}

/** Normalized Claude Code `api_request` event; raw console records are accepted too. */
export interface OtelRequest {
  eventName?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Run-owned stream and optional transcript/OTEL evidence plus fixed identity. */
export interface ClaudeCollectorInput {
  stream: string;
  otel?: OtelRequest[] | null;
  /** Root and subagent transcript JSONL, supplied from this run's home. */
  transcripts?: Array<{ jsonl: string; agentName?: string; parentToolUseId?: string }>;
  identity: ClaudeRunIdentity;
  agentModels: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`benchmark-collector-invalid-${field}`);
  }
  return value;
}

function tokens(value: Record<string, unknown>, model: string): TokenTotals {
  const inputTokens = nonnegative(value.inputTokens, `${model}-input`);
  return {
    inputTokens,
    uncachedInputTokens: inputTokens,
    cachedInputTokens: nonnegative(value.cacheReadInputTokens, `${model}-cache-read`),
    cacheWriteTokens: nonnegative(value.cacheCreationInputTokens, `${model}-cache-write`),
    outputTokens: nonnegative(value.outputTokens, `${model}-output`),
    thinkingTokens: value.thinkingTokens == null ? null : nonnegative(value.thinkingTokens, `${model}-thinking`),
  };
}

function parseStream(stream: string): StreamEvent[] {
  const lines = stream.trim().split("\n");
  if (!stream.trim()) throw new Error("benchmark-collector-empty-stream");
  return lines.map((line, index) => {
    let item: unknown;
    try { item = JSON.parse(line); }
    catch { throw new Error(`benchmark-collector-truncated-line:${index + 1}`); }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`benchmark-collector-invalid-line:${index + 1}`);
    }
    return item as StreamEvent;
  });
}

function parseTranscript(jsonl: string): StreamEvent[] {
  if (!jsonl.trim()) throw new Error("benchmark-collector-transcript-empty");
  return jsonl.trim().split("\n").map((line, index) => {
    try { return JSON.parse(line) as StreamEvent; }
    catch { throw new Error(`benchmark-collector-transcript-truncated-line:${index + 1}`); }
  });
}

function messageUsage(value: Record<string, unknown> | undefined): CallTokens {
  if (!value) throw new Error("benchmark-collector-message-usage-missing");
  const inputTokens = nonnegative(value.input_tokens, "message-input");
  return {
    inputTokens,
    uncachedInputTokens: inputTokens,
    cachedInputTokens: nonnegative(value.cache_read_input_tokens, "message-cache-read"),
    cacheWriteTokens: nonnegative(value.cache_creation_input_tokens, "message-cache-write"),
    outputTokens: null, // Claude stream assistant output is a placeholder.
    thinkingTokens: null,
  };
}

function otelAttributes(record: OtelRequest): Record<string, unknown> | null {
  const attrs = record.attributes && typeof record.attributes === "object" ? record.attributes : record;
  const eventName = record.eventName ?? record.name ?? record.body ?? attrs["event.name"];
  if (eventName !== "claude_code.api_request" && eventName !== "api_request") return null;
  return attrs;
}

function otelNumber(attrs: Record<string, unknown>, key: string): number {
  const value = attrs[key];
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return nonnegative(value, `otel-${key}`);
}

function sameInput(a: CallTokens, b: CallTokens): boolean {
  return a.inputTokens === b.inputTokens && a.cachedInputTokens === b.cachedInputTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens;
}

/** Collect authoritative final totals and reconcile optional per-request OTEL. */
export function collectClaude(input: ClaudeCollectorInput): ClaudeBenchmarkResult {
  const { identity, agentModels } = input;
  const events = parseStream(input.stream);
  const finals = events.filter((event) => event.type === "result");
  if (!finals.length || events.at(-1) !== finals.at(-1)) {
    throw new Error("benchmark-collector-final-missing-or-truncated");
  }
  const final = finals.at(-1)!;
  if (finals.length > 1) {
    for (const [index, event] of finals.entries()) {
      if (event.result_index !== index || event.session_id !== final.session_id ||
          !event.modelUsage || !final.modelUsage ||
          nonnegative(event.total_cost_usd, "interim-cost") >
            nonnegative(final.total_cost_usd, "final-cost")) {
        throw new Error("benchmark-collector-final-sequence-invalid");
      }
      for (const [model, usage] of Object.entries(event.modelUsage)) {
        const terminal = final.modelUsage[model];
        if (!terminal || ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
          "outputTokens", "costUSD"].some((key) =>
          nonnegative(usage[key], `interim-${model}-${key}`) >
            nonnegative(terminal[key], `final-${model}-${key}`))) {
          throw new Error("benchmark-collector-final-sequence-invalid");
        }
      }
    }
  }
  if (!final.modelUsage || !Object.keys(final.modelUsage).length || !final.usage) {
    throw new Error("benchmark-collector-final-usage-missing");
  }
  const costUsd = nonnegative(final.total_cost_usd, "final-cost");
  const modelTotals = new Map<string, TokenTotals>();
  let modelCost = 0;
  for (const [model, usage] of Object.entries(final.modelUsage)) {
    modelTotals.set(model, tokens(usage, model));
    modelCost += nonnegative(usage.costUSD, `${model}-cost`);
  }
  if (Math.abs(modelCost - costUsd) > 0.000001) throw new Error("benchmark-collector-cost-mismatch");
  const totals: TokenTotals = {
    inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0,
  };
  for (const usage of modelTotals.values()) {
    totals.inputTokens += usage.inputTokens;
    totals.uncachedInputTokens += usage.uncachedInputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.outputTokens += usage.outputTokens;
    totals.thinkingTokens = usage.thinkingTokens === null || totals.thinkingTokens === null
      ? null : totals.thinkingTokens + usage.thinkingTokens;
  }
  const finalUsage = final.usage;
  // Claude's result.usage may describe only its last turn. modelUsage is the
  // cumulative final total across root and subagent requests; the last turn
  // can be a strict subset, but it cannot exceed that total.
  if (nonnegative(finalUsage.input_tokens, "final-input") > totals.inputTokens ||
      nonnegative(finalUsage.cache_read_input_tokens, "final-cache-read") > totals.cachedInputTokens ||
      nonnegative(finalUsage.cache_creation_input_tokens, "final-cache-write") > totals.cacheWriteTokens ||
      nonnegative(finalUsage.output_tokens, "final-output") > totals.outputTokens) {
    throw new Error("benchmark-collector-final-total-mismatch");
  }

  const requests = new Map<string, ModelCall>();
  const messageIds = new Map<string, string>();
  const parentAgents = new Map<string, string>();
  let currentPhase: BenchmarkPhase | null = "startup";
  const rootModels = new Set<string>();
  const assistantSources = [
    ...events.map((event) => ({ event, agentName: null as string | null, parentToolUseId: null as string | null, transcript: false })),
    ...(input.transcripts ?? []).flatMap((bundle) => parseTranscript(bundle.jsonl).map((event) => ({
      event, agentName: bundle.agentName ?? null, parentToolUseId: bundle.parentToolUseId ?? null, transcript: true,
    }))),
  ];
  for (const source of assistantSources) {
    const { event } = source;
    if (event.type !== "assistant" || !event.message) continue;
    const message = event.message;
    const requestId = event.request_id ?? event.requestId;
    const parentToolUseId = event.parent_tool_use_id ?? event.parentToolUseID ?? source.parentToolUseId;
    if (!message.id || !requestId || !message.model) throw new Error("benchmark-collector-message-id-missing");
    const priorRequest = messageIds.get(message.id);
    if (priorRequest && priorRequest !== requestId) throw new Error("benchmark-collector-message-request-conflict");
    messageIds.set(message.id, requestId);
    const usage = messageUsage(message.usage);
    const previous = requests.get(requestId);
    const agentName = source.agentName ?? (parentToolUseId ? parentAgents.get(parentToolUseId) ?? null : null);
    const reportedEffort = event.effort ?? event.perTurnEffort ?? null;
    const attribution = attributeCall({
      parentToolUseId,
      agentName,
      phase: source.transcript && parentToolUseId ? null : currentPhase,
    }, identity.shape, agentModels);
    if (previous) {
      if (previous.messageId !== message.id || previous.model !== message.model ||
          !previous.tokens || !sameInput(previous.tokens, usage)) {
        throw new Error("benchmark-collector-duplicate-message-conflict");
      }
      if (reportedEffort && previous.effort && previous.effort !== reportedEffort) {
        throw new Error("benchmark-collector-transcript-effort-conflict");
      }
      if (reportedEffort) previous.effort = reportedEffort;
      if (source.transcript && agentName && previous.worker === null) Object.assign(previous, attribution);
    } else {
      requests.set(requestId, {
        id: requestId, requestId, messageId: message.id,
        model: message.model, effort: reportedEffort, tokens: usage, durationMs: null,
        ...attribution, source: "transcript",
      });
      if (!parentToolUseId && !agentName) rootModels.add(message.model);
    }
    for (const block of message.content ?? []) {
      if (block.type !== "tool_use" || !block.name) continue;
      if (block.name === "Agent" && block.id && typeof block.input === "object" && block.input !== null) {
        const value = block.input as Record<string, unknown>;
        const raw = value.subagent_type ?? value.agent_name;
        if (typeof raw === "string") {
          const firstWord = typeof value.description === "string" ? value.description.match(/^vibe-[a-z-]+/)?.[0] : null;
          parentAgents.set(block.id, raw === "general-purpose" && firstWord && agentModels[firstWord] ? firstWord : raw);
        }
      }
      if (!source.transcript) currentPhase = phaseFromTool(block.name, block.input) ?? currentPhase;
    }
  }
  if (!requests.size) throw new Error("benchmark-collector-no-model-calls");

  const otelSeen = new Set<string>();
  const otelSums = new Map<string, TokenTotals>();
  let observedEffort: string | null = null;
  for (const record of input.otel ?? []) {
    const attrs = otelAttributes(record);
    if (!attrs) continue;
    const requestId = attrs.request_id;
    const model = attrs.model;
    const effort = attrs.effort;
    if (typeof requestId !== "string" || !requestId || typeof model !== "string" || !model ||
        typeof effort !== "string" || !effort) throw new Error("benchmark-collector-otel-required-field-missing");
    if (otelSeen.has(requestId)) throw new Error("benchmark-collector-otel-duplicate-request");
    otelSeen.add(requestId);
    if (observedEffort && observedEffort !== effort) throw new Error("benchmark-collector-otel-effort-conflict");
    observedEffort = effort;
    const usage: CallTokens = {
      inputTokens: otelNumber(attrs, "input_tokens"),
      uncachedInputTokens: otelNumber(attrs, "input_tokens"),
      cachedInputTokens: otelNumber(attrs, "cache_read_tokens"),
      cacheWriteTokens: otelNumber(attrs, "cache_creation_tokens"),
      outputTokens: otelNumber(attrs, "output_tokens"),
      thinkingTokens: null,
    };
    let call = requests.get(requestId);
    const observedAgent = attrs["agent.name"];
    const observedSkill = attrs["skill.name"];
    const observedQuery = attrs.query_source;
    if (!call && observedQuery === "compact") {
      const attribution = attributeCall({
        agentName: typeof observedAgent === "string" ? observedAgent : null,
        skillName: typeof observedSkill === "string" ? observedSkill : null,
        querySource: "compact", phase: null,
      }, identity.shape, agentModels);
      call = { id: requestId, requestId, messageId: null, model, effort,
        tokens: usage, durationMs: null, ...attribution, source: "otel" };
      requests.set(requestId, call);
    }
    if (!call || call.model !== model || !call.tokens || !sameInput(call.tokens, usage)) {
      throw new Error(`benchmark-collector-otel-request-mismatch:${requestId}`);
    }
    const fromOtelOnly = call.messageId === null;
    if (call.effort && call.effort !== effort) throw new Error("benchmark-collector-otel-effort-mismatch");
    call.tokens = usage;
    call.durationMs = otelNumber(attrs, "duration_ms");
    call.effort = effort;
    call.source = fromOtelOnly ? "otel" : "both";
    const attribution = attributeCall({
      agentName: typeof observedAgent === "string" ? observedAgent : call.worker,
      skillName: typeof observedSkill === "string" ? observedSkill : call.skill,
      querySource: typeof observedQuery === "string" ? observedQuery : null,
      phase: call.phase,
    }, identity.shape, agentModels);
    if (!fromOtelOnly &&
        (!call.unattributedReason?.startsWith("unknown-parent-tool:") || typeof observedAgent === "string")) {
      Object.assign(call, attribution);
    }
    const sum = otelSums.get(model) ?? {
      inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: null,
    };
    sum.inputTokens += usage.inputTokens;
    sum.uncachedInputTokens += usage.uncachedInputTokens;
    sum.cachedInputTokens += usage.cachedInputTokens;
    sum.cacheWriteTokens += usage.cacheWriteTokens;
    sum.outputTokens += usage.outputTokens!;
    otelSums.set(model, sum);
  }
  if (input.otel && (!otelSeen.size || otelSeen.size !== requests.size)) {
    throw new Error("benchmark-collector-otel-dropped-request");
  }
  if (input.otel) {
    for (const [model, expected] of modelTotals) {
      const actual = otelSums.get(model);
      if (!actual || actual.inputTokens !== expected.inputTokens ||
          actual.cachedInputTokens !== expected.cachedInputTokens ||
          actual.cacheWriteTokens !== expected.cacheWriteTokens ||
          actual.outputTokens !== expected.outputTokens) {
        throw new Error(`benchmark-collector-otel-total-mismatch:${model}`);
      }
    }
  }
  const calls = [...requests.values()];
  const transcriptSums = { input: 0, read: 0, write: 0 };
  const transcriptByModel = new Map<string, { input: number; read: number; write: number }>();
  for (const call of calls) {
    transcriptSums.input += call.tokens!.inputTokens;
    transcriptSums.read += call.tokens!.cachedInputTokens;
    transcriptSums.write += call.tokens!.cacheWriteTokens;
    const perModel = transcriptByModel.get(call.model) ?? { input: 0, read: 0, write: 0 };
    perModel.input += call.tokens!.inputTokens;
    perModel.read += call.tokens!.cachedInputTokens;
    perModel.write += call.tokens!.cacheWriteTokens;
    transcriptByModel.set(call.model, perModel);
    if (call.component === "unattributed" && !call.unattributedReason) {
      throw new Error("benchmark-collector-unattributed-reason-missing");
    }
  }
  if (transcriptSums.input !== totals.inputTokens || transcriptSums.read !== totals.cachedInputTokens ||
      transcriptSums.write !== totals.cacheWriteTokens) {
    throw new Error("benchmark-collector-transcript-total-mismatch");
  }
  for (const [model, expected] of modelTotals) {
    const actual = transcriptByModel.get(model);
    if (!actual || actual.input !== expected.inputTokens || actual.read !== expected.cachedInputTokens ||
        actual.write !== expected.cacheWriteTokens) {
      throw new Error(`benchmark-collector-transcript-model-mismatch:${model}`);
    }
  }
  const invalidReasons: string[] = [];
  try { requirePinnedClaude({ model: identity.configuredModel, effort: identity.configuredEffort }, input.env ?? process.env); }
  catch (error) { invalidReasons.push(error instanceof Error ? error.message : String(error)); }
  const observedModel = rootModels.size === 1 ? [...rootModels][0] : null;
  if (observedModel !== BENCHMARK_MODEL) invalidReasons.push("benchmark-model-mismatch");
  const initModels = new Set(events.filter((event) => event.type === "system" && event.subtype === "init")
    .map((event) => event.model).filter((model): model is string => typeof model === "string"));
  if (initModels.size > 1 || (initModels.size === 1 && !initModels.has(observedModel ?? ""))) {
    invalidReasons.push("benchmark-init-model-mismatch");
  }
  const transcriptEfforts = new Set(calls.map((call) => call.effort).filter((effort): effort is string => effort !== null));
  if (!input.otel && transcriptEfforts.size === 1) observedEffort = [...transcriptEfforts][0];
  if (transcriptEfforts.size > 1) invalidReasons.push("benchmark-effort-mismatch");
  if (input.transcripts && calls.some((call) => call.effort === null)) invalidReasons.push("benchmark-effort-missing");
  if (observedEffort !== null && observedEffort !== BENCHMARK_EFFORT) invalidReasons.push("benchmark-effort-mismatch");
  if (observedEffort === null) invalidReasons.push("benchmark-effort-missing");
  if (final.is_error !== false) invalidReasons.push("benchmark-run-incomplete");
  for (const [key, value] of Object.entries(identity)) {
    if (typeof value === "string" && !value) invalidReasons.push(`benchmark-identity-missing:${key}`);
  }
  if (identity.shape !== "vibe" && identity.shape !== "fleet-one-writer") invalidReasons.push("benchmark-shape-invalid");
  if (!/^[a-f0-9]{40}$/.test(identity.pluginSha)) invalidReasons.push("benchmark-plugin-sha-invalid");
  if (Number.isNaN(Date.parse(identity.startedAt))) invalidReasons.push("benchmark-start-time-invalid");
  for (const key of ["stackSetupMs", "stackTeardownMs", "wallMs"] as const) {
    if (typeof identity[key] !== "number" || !Number.isFinite(identity[key]) || identity[key] < 0) {
      invalidReasons.push(`benchmark-identity-invalid:${key}`);
    }
  }
  for (const key of ["oraclePassed", "noOutOfScopeEdits", "taskComplete", "prDraftRecordedAndClosed"] as const) {
    if (typeof identity[key] !== "boolean") invalidReasons.push(`benchmark-identity-invalid:${key}`);
  }
  const payload: Omit<ClaudeBenchmarkResult, "resultHash"> = {
    schemaVersion: 1, runtime: "claude", identity, observedModel, observedEffort,
    agentModels, valid: invalidReasons.length === 0, invalidReasons,
    success: invalidReasons.length === 0 && identity.oraclePassed && identity.noOutOfScopeEdits &&
      identity.taskComplete && identity.prDraftRecordedAndClosed,
    costUsd, modelCalls: calls.length, totals, calls,
  };
  return { ...payload, resultHash: resultHash(payload) };
}
