/**
 * Parse Claude Code session transcripts into per-agent / per-stage / per-model
 * cost for code-review runs.
 *
 * Layout this relies on (Claude Code transcript directory, one dir per encoded
 * cwd under ~/.claude/projects/):
 *   <project>/<sessionId>.jsonl                 -- main orchestrator thread
 *   <project>/<sessionId>/subagents/agent-*.jsonl       -- one per spawned agent
 *   <project>/<sessionId>/subagents/agent-*.meta.json   -- {agentType, description}
 *
 * The main thread is the code-review "walker"/orchestrator; each subagent is a
 * reviewer/verifier/critic. The subagent's `description` (from its meta file)
 * names its role (e.g. "Bug Hunter A p0", "Premise Reviewer", "Verify
 * auditor_f0"), which we bucket into a small set of role categories so cost can
 * be attributed to the activity rather than to an opaque agent id.
 *
 * Token usage lives only in these transcripts -- the Python review pipeline that
 * writes review_result.json never sees it -- so this transcript layer is the
 * only place a real cost number can come from.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import {
  type ModelFamily,
  type TokenCounts,
  type TokenKind,
  addInto,
  costOf,
  emptyTokenCounts,
  modelFamily,
} from "./pricing.js";

export type PerModel = Partial<Record<ModelFamily, TokenCounts>>;

/** Role buckets for fleet attribution. "main" is the orchestrator thread. */
export type RoleCategory =
  | "bug_hunter"
  | "domain_critic"
  | "auditor"
  | "premise"
  | "impact_analyzer"
  | "verifier"
  | "coverage_critic"
  | "signal_extraction"
  | "fast_path"
  | "other";

export interface AgentCost {
  id: string;
  description: string;
  agentType: string;
  category: RoleCategory;
  tokens: PerModel;
  turns: number;
  cost: number;
}

export interface SessionCost {
  sessionId: string;
  project: string;
  /** e.g. "/code-review:deep", "/code-review:start", "/code-review:shallow". */
  variant: string;
  /** Resolved depth tier (deep/standard/shallow) -- the cost-relevant axis. */
  depth: Depth;
  mainTokens: PerModel;
  mainTurns: number;
  mainCost: number;
  /** Main-thread tool-use counts, keyed by tool name. */
  tools: Record<string, number>;
  agents: AgentCost[];
  fleetCost: number;
  totalCost: number;
}

// --- raw transcript shapes (only the fields we read) ------------------------

interface RawCacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}
interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: RawCacheCreation;
}
interface RawContentBlock {
  type?: string;
  name?: string;
  text?: string;
}
interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  message?: { model?: string; usage?: RawUsage; content?: RawContentBlock[] | string };
}

// --- pure helpers (unit-tested without touching the filesystem) -------------

/** Extract normalized token counts from a raw `message.usage` object. */
export function parseUsage(usage: RawUsage | undefined): TokenCounts {
  const t = emptyTokenCounts();
  if (!usage) return t;
  t.input = usage.input_tokens ?? 0;
  t.cacheRead = usage.cache_read_input_tokens ?? 0;
  t.output = usage.output_tokens ?? 0;
  const cc = usage.cache_creation;
  if (cc) {
    t.cacheWrite5m = cc.ephemeral_5m_input_tokens ?? 0;
    t.cacheWrite1h = cc.ephemeral_1h_input_tokens ?? 0;
  } else {
    // Older transcripts lack the 5m/1h split; treat the lump sum as 5m so we
    // never undercount, while not over-charging it at the 1h (2x) tier.
    t.cacheWrite5m = usage.cache_creation_input_tokens ?? 0;
  }
  return t;
}

/** Bucket a subagent `description` into a role category. */
export function roleCategory(description: string | undefined): RoleCategory {
  const d = (description ?? "").toLowerCase();
  if (d.startsWith("verif")) return "verifier";
  if (d.includes("bug hunter") || /\bbh[ab]\b/.test(d) || /\bbha?\s*p?\d/.test(d)) return "bug_hunter";
  if (d.includes("auditor")) return "auditor";
  if (d.includes("domain")) return "domain_critic";
  if (d.includes("premise")) return "premise";
  if (d.includes("impact")) return "impact_analyzer";
  if (d.includes("signal")) return "signal_extraction";
  if (d.includes("coverage")) return "coverage_critic";
  if (d.includes("fast-path") || d.includes("fast path")) return "fast_path";
  return "other";
}

/** Accumulate one model's tokens into a PerModel map (lazily creating the slot). */
export function accumulate(map: PerModel, family: ModelFamily, tokens: TokenCounts): void {
  let slot = map[family];
  if (!slot) {
    slot = emptyTokenCounts();
    map[family] = slot;
  }
  addInto(slot, tokens);
}

/** Total USD cost across every model family in a PerModel map. */
export function perModelCost(map: PerModel): number {
  let total = 0;
  for (const family of Object.keys(map) as ModelFamily[]) {
    const slot = map[family];
    if (slot) total += costOf(family, slot);
  }
  return total;
}

export interface ThreadStats {
  tokens: PerModel;
  turns: number;
  tools: Record<string, number>;
}

/**
 * Fold a list of parsed transcript entries into per-model token totals, an
 * assistant-turn count, and tool-use counts. `sidechainOnly` selects between
 * the main thread (false) and an embedded subagent stream (true); pass
 * undefined to count every assistant message regardless of sidechain flag
 * (subagent files are already isolated, so they use undefined).
 */
export function foldThread(entries: RawEntry[], sidechainOnly?: boolean): ThreadStats {
  const tokens: PerModel = {};
  const tools: Record<string, number> = {};
  let turns = 0;
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    if (sidechainOnly !== undefined && Boolean(e.isSidechain) !== sidechainOnly) continue;
    const msg = e.message;
    if (!msg) continue;
    const family = modelFamily(msg.model);
    if (family) accumulate(tokens, family, parseUsage(msg.usage));
    turns += 1;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_use" && block.name) {
          tools[block.name] = (tools[block.name] ?? 0) + 1;
        }
      }
    }
  }
  return { tokens, turns, tools };
}

// --- filesystem layer -------------------------------------------------------

function readJsonl(path: string): RawEntry[] {
  const out: RawEntry[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawEntry);
    } catch {
      // tolerate partially-written / truncated trailing lines
    }
  }
  return out;
}

function firstText(content: RawContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

/** Review depth tier. `standard` is the default for a bare `/code-review:start`. */
export type Depth = "deep" | "standard" | "shallow";

export const DEPTHS: Depth[] = ["deep", "standard", "shallow"];

const CR_COMMAND_RE = /<command-name>(\/code-review:[a-z]+)<\/command-name>/;
const CR_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const DEPTH_FLAG_RE = /--depth[\s=]+(shallow|standard|deep)\b/;

/**
 * Resolve the actual depth tier of a run from its command variant and args.
 *
 * The `:deep` and `:shallow` command wrappers bind their tier regardless of
 * args (start.md). A bare `/code-review:start` defaults to `standard`, but an
 * explicit `--depth <tier>` flag in its args overrides that. The command name
 * alone is therefore NOT a reliable depth signal for the `:start` path -- hence
 * the args parse.
 */
export function resolveDepth(variant: string, args: string): Depth {
  if (variant.endsWith(":deep")) return "deep";
  if (variant.endsWith(":shallow")) return "shallow";
  const m = DEPTH_FLAG_RE.exec(args);
  if (m) return m[1] as Depth;
  return "standard";
}

export interface CodeReviewMatch {
  variant: string;
  depth: Depth;
}

/**
 * Detect whether a session is a code-review run, returning the command variant
 * (e.g. "/code-review:deep") and resolved depth tier, or null. Only the first
 * few user turns are read so this stays cheap when scanning hundreds of
 * sessions.
 */
export function detectCodeReview(path: string): CodeReviewMatch | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let userSeen = 0;
  for (const line of raw.split("\n")) {
    if (userSeen > 6) break;
    if (!line.trim()) continue;
    let e: RawEntry;
    try {
      e = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    if (e.type !== "user") continue;
    userSeen += 1;
    const text = firstText(e.message?.content);
    const m = CR_COMMAND_RE.exec(text);
    if (m) {
      const variant = m[1] ?? "/code-review";
      const argsMatch = CR_ARGS_RE.exec(text);
      return { variant, depth: resolveDepth(variant, argsMatch?.[1] ?? "") };
    }
  }
  return null;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
}

/** Analyze one subagent transcript + its meta file into an AgentCost. */
function analyzeAgent(subdir: string, agentFile: string): AgentCost {
  const id = basename(agentFile).replace(/\.jsonl$/, "");
  const metaPath = join(subdir, `${id}.meta.json`);
  let meta: AgentMeta = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as AgentMeta;
    } catch {
      meta = {};
    }
  }
  const stats = foldThread(readJsonl(join(subdir, agentFile)));
  const description = meta.description ?? "";
  return {
    id,
    description,
    agentType: meta.agentType ?? "",
    category: roleCategory(description),
    tokens: stats.tokens,
    turns: stats.turns,
    cost: perModelCost(stats.tokens),
  };
}

/**
 * Analyze a single code-review session by id within a project directory.
 * Returns null if the session is not a code-review run.
 */
export function analyzeSession(projectDir: string, sessionId: string): SessionCost | null {
  const sessionPath = join(projectDir, `${sessionId}.jsonl`);
  const match = detectCodeReview(sessionPath);
  if (!match) return null;

  const main = foldThread(readJsonl(sessionPath), false);
  const agents: AgentCost[] = [];
  const subdir = join(projectDir, sessionId, "subagents");
  if (existsSync(subdir)) {
    for (const f of readdirSync(subdir)) {
      if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
        agents.push(analyzeAgent(subdir, f));
      }
    }
  }
  const mainCost = perModelCost(main.tokens);
  const fleetCost = agents.reduce((s, a) => s + a.cost, 0);
  return {
    sessionId,
    project: basename(projectDir),
    variant: match.variant,
    depth: match.depth,
    mainTokens: main.tokens,
    mainTurns: main.turns,
    mainCost,
    tools: main.tools,
    agents,
    fleetCost,
    totalCost: mainCost + fleetCost,
  };
}

/** Find every code-review session under a transcript root (~/.claude/projects). */
export function scanProjects(projectsRoot: string): SessionCost[] {
  const out: SessionCost[] = [];
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const projName of projects) {
    const projectDir = join(projectsRoot, projName);
    let entries: string[];
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      entries = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.replace(/\.jsonl$/, "");
      const result = analyzeSession(projectDir, sessionId);
      if (result) out.push(result);
    }
  }
  return out;
}

// --- aggregation ------------------------------------------------------------

export interface RoleAggregate {
  category: RoleCategory;
  cost: number;
  runs: number;
  turns: number;
}

export interface DepthBreakdown {
  depth: Depth;
  count: number;
  totalCost: number;
  mean: number;
  median: number;
  mainCost: number;
  fleetCost: number;
  /** Mean orchestrator turns and mean agent count -- the cost drivers per tier. */
  meanTurns: number;
  meanAgents: number;
}

export interface Aggregate {
  sessionCount: number;
  totalCost: number;
  mainCost: number;
  fleetCost: number;
  costByKind: Record<TokenKind, number>;
  costByModel: Partial<Record<ModelFamily, number>>;
  roleCosts: RoleAggregate[];
  /** Per-tier cost breakdown -- the like-for-like axis for measuring changes. */
  byDepth: DepthBreakdown[];
  variants: Record<string, number>;
  perSession: { sessionId: string; project: string; variant: string; mainTurns: number; agents: number; cost: number }[];
  stats: { mean: number; median: number; min: number; max: number; p90: number };
}

const TOKEN_KINDS: TokenKind[] = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"];

function emptyKindCosts(): Record<TokenKind, number> {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

function addKindCosts(into: Record<TokenKind, number>, map: PerModel): void {
  for (const family of Object.keys(map) as ModelFamily[]) {
    const slot = map[family];
    if (!slot) continue;
    for (const kind of TOKEN_KINDS) {
      into[kind] += costOf(family, { ...emptyTokenCounts(), [kind]: slot[kind] });
    }
  }
}

function addModelCosts(into: Partial<Record<ModelFamily, number>>, map: PerModel): void {
  for (const family of Object.keys(map) as ModelFamily[]) {
    const slot = map[family];
    if (!slot) continue;
    into[family] = (into[family] ?? 0) + costOf(family, slot);
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx] ?? 0;
}

/** Group sessions by resolved depth tier and summarize each group. */
function depthBreakdown(sessions: SessionCost[]): DepthBreakdown[] {
  const out: DepthBreakdown[] = [];
  for (const depth of DEPTHS) {
    const group = sessions.filter((s) => s.depth === depth);
    if (group.length === 0) continue;
    const costs = group.map((s) => s.totalCost).sort((a, b) => a - b);
    const total = costs.reduce((a, b) => a + b, 0);
    out.push({
      depth,
      count: group.length,
      totalCost: total,
      mean: total / group.length,
      median: percentile(costs, 0.5),
      mainCost: group.reduce((s, x) => s + x.mainCost, 0),
      fleetCost: group.reduce((s, x) => s + x.fleetCost, 0),
      meanTurns: group.reduce((s, x) => s + x.mainTurns, 0) / group.length,
      meanAgents: group.reduce((s, x) => s + x.agents.length, 0) / group.length,
    });
  }
  return out;
}

/** Roll a set of analyzed sessions into the headline cost breakdown. */
export function aggregate(sessions: SessionCost[]): Aggregate {
  const costByKind = emptyKindCosts();
  const costByModel: Partial<Record<ModelFamily, number>> = {};
  const roleMap = new Map<RoleCategory, RoleAggregate>();
  const variants: Record<string, number> = {};
  let mainCost = 0;
  let fleetCost = 0;

  for (const s of sessions) {
    variants[s.variant] = (variants[s.variant] ?? 0) + 1;
    mainCost += s.mainCost;
    fleetCost += s.fleetCost;
    addKindCosts(costByKind, s.mainTokens);
    addModelCosts(costByModel, s.mainTokens);
    for (const a of s.agents) {
      addKindCosts(costByKind, a.tokens);
      addModelCosts(costByModel, a.tokens);
      let role = roleMap.get(a.category);
      if (!role) {
        role = { category: a.category, cost: 0, runs: 0, turns: 0 };
        roleMap.set(a.category, role);
      }
      role.cost += a.cost;
      role.runs += 1;
      role.turns += a.turns;
    }
  }

  const costs = sessions.map((s) => s.totalCost).sort((a, b) => a - b);
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const roleCosts = [...roleMap.values()].sort((a, b) => b.cost - a.cost);

  return {
    sessionCount: sessions.length,
    totalCost,
    mainCost,
    fleetCost,
    costByKind,
    costByModel,
    roleCosts,
    byDepth: depthBreakdown(sessions),
    variants,
    perSession: sessions
      .map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        variant: s.variant,
        mainTurns: s.mainTurns,
        agents: s.agents.length,
        cost: s.totalCost,
      }))
      .sort((a, b) => b.cost - a.cost),
    stats: {
      mean: costs.length ? totalCost / costs.length : 0,
      median: percentile(costs, 0.5),
      min: costs[0] ?? 0,
      max: costs[costs.length - 1] ?? 0,
      p90: percentile(costs, 0.9),
    },
  };
}

// --- comparison (baseline vs current) ---------------------------------------

export interface Comparison {
  baseline: { sessionCount: number; meanCost: number; medianCost: number };
  current: { sessionCount: number; meanCost: number; medianCost: number };
  meanDelta: number;
  meanPctChange: number;
  roleDeltas: { category: string; baselinePerRun: number; currentPerRun: number; pctChange: number }[];
}

function rolePerRun(agg: Aggregate): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of agg.roleCosts) m.set(r.category, r.runs ? r.cost / r.runs : 0);
  return m;
}

/** Compare two aggregates (typically baseline vs post-change) on mean/median
 * total cost and per-run cost of each role. */
export function compareAggregates(baseline: Aggregate, current: Aggregate): Comparison {
  const bRoles = rolePerRun(baseline);
  const cRoles = rolePerRun(current);
  const categories = new Set<string>([...bRoles.keys(), ...cRoles.keys()]);
  const roleDeltas = [...categories]
    .map((category) => {
      const b = bRoles.get(category) ?? 0;
      const c = cRoles.get(category) ?? 0;
      return {
        category,
        baselinePerRun: b,
        currentPerRun: c,
        pctChange: b ? ((c - b) / b) * 100 : 0,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
  const meanDelta = current.stats.mean - baseline.stats.mean;
  return {
    baseline: { sessionCount: baseline.sessionCount, meanCost: baseline.stats.mean, medianCost: baseline.stats.median },
    current: { sessionCount: current.sessionCount, meanCost: current.stats.mean, medianCost: current.stats.median },
    meanDelta,
    meanPctChange: baseline.stats.mean ? (meanDelta / baseline.stats.mean) * 100 : 0,
    roleDeltas,
  };
}
