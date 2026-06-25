/**
 * cost-report -- attribute the token spend of code-review runs from Claude Code
 * session transcripts.
 *
 * The Python review pipeline never sees token usage, so review_result.json's
 * telemetry block is empty. This CLI fills that gap retroactively: point it at a
 * session (or scan every code-review session under ~/.claude/projects) and it
 * reports total cost, the main-orchestrator vs subagent-fleet split, cost by
 * token kind (cache read/write dominate), and cost per reviewer role. Save a
 * run as JSON to establish a baseline, then pass --baseline later to measure the
 * impact of a cost-reduction change.
 *
 * Usage:
 *   cost-report --session <path/to/session.jsonl>
 *   cost-report --project <~/.claude/projects/<encoded-cwd>>
 *   cost-report --scan [--projects-root <dir>]
 *   cost-report --scan --save baseline.json          # write JSON baseline
 *   cost-report --scan --baseline baseline.json       # compare against baseline
 *   cost-report --session <path> --json               # machine-readable
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join } from "node:path";
import { runWhenMain } from "./cli.js";
import {
  type Aggregate,
  type SessionCost,
  aggregate,
  analyzeSession,
  compareAggregates,
  scanProjects,
} from "./transcript-cost.js";
import type { TokenKind } from "./pricing.js";

const HELP = `cost-report -- code-review token/cost attribution from session transcripts

Input (choose one):
  --session <file.jsonl>   Analyze a single Claude Code session transcript.
  --project <dir>          Analyze every code-review session in one project dir.
  --scan                   Scan every project under --projects-root.

Options:
  --depth <tier>           Filter to one tier: deep | standard | shallow.
                           Use for like-for-like baselines (deep-vs-deep).
  --projects-root <dir>    Transcript root (default: ~/.claude/projects).
  --save <file.json>       Write the JSON aggregate (use as a baseline later).
  --baseline <file.json>   Compare this run against a saved baseline aggregate.
  --json                   Emit the JSON aggregate instead of the text report.
  --top <n>                Rows to show in role/session tables (default: 12).
  --help                   Show this help.
`;

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(0)}%` : "0%";
}

const KIND_LABEL: Record<TokenKind, string> = {
  cacheRead: "cache read",
  cacheWrite1h: "cache write 1h",
  cacheWrite5m: "cache write 5m",
  output: "output",
  input: "input (uncached)",
};

function renderReport(agg: Aggregate, top: number): string {
  const L: string[] = [];
  const n = agg.sessionCount;
  L.push("=".repeat(64));
  L.push(`CODE-REVIEW COST REPORT  (${n} session${n === 1 ? "" : "s"})`);
  L.push("=".repeat(64));
  L.push(`  total spend ........ ${fmtUsd(agg.totalCost)}`);
  if (n > 1) {
    L.push(`  mean / median ...... ${fmtUsd(agg.stats.mean)} / ${fmtUsd(agg.stats.median)}`);
    L.push(`  min / max / p90 .... ${fmtUsd(agg.stats.min)} / ${fmtUsd(agg.stats.max)} / ${fmtUsd(agg.stats.p90)}`);
  }
  const variantKeys = Object.keys(agg.variants).sort();
  if (variantKeys.length) {
    L.push(`  variants ........... ${variantKeys.map((v) => `${v}=${agg.variants[v]}`).join("  ")}`);
  }

  if (agg.byDepth.length) {
    L.push("");
    L.push("COST BY DEPTH (like-for-like axis -- compare deep-to-deep, etc.)");
    L.push(
      `  ${"tier".padEnd(9)} ${"runs".padStart(5)} ${"mean".padStart(9)} ${"median".padStart(9)} ${"main%".padStart(6)} ${"turns".padStart(6)} ${"agents".padStart(7)}`,
    );
    for (const d of agg.byDepth) {
      const grandRow = d.mainCost + d.fleetCost;
      L.push(
        `  ${d.depth.padEnd(9)} ${String(d.count).padStart(5)} ${fmtUsd(d.mean).padStart(9)} ${fmtUsd(d.median).padStart(9)} ${pct(d.mainCost, grandRow).padStart(6)} ${d.meanTurns.toFixed(0).padStart(6)} ${d.meanAgents.toFixed(1).padStart(7)}`,
      );
    }
  }

  L.push("");
  L.push("MAIN ORCHESTRATOR vs SUBAGENT FLEET");
  const grand = agg.mainCost + agg.fleetCost;
  L.push(`  main orchestrator .. ${fmtUsd(agg.mainCost)}  (${pct(agg.mainCost, grand)})`);
  L.push(`  subagent fleet ..... ${fmtUsd(agg.fleetCost)}  (${pct(agg.fleetCost, grand)})`);

  L.push("");
  L.push("COST BY TOKEN KIND");
  const kinds: TokenKind[] = ["cacheRead", "cacheWrite1h", "output", "cacheWrite5m", "input"];
  for (const k of kinds) {
    L.push(`  ${KIND_LABEL[k].padEnd(18)} ${fmtUsd(agg.costByKind[k]).padStart(11)}  (${pct(agg.costByKind[k], grand)})`);
  }

  L.push("");
  L.push("SUBAGENT FLEET COST BY ROLE");
  L.push(`  ${"role".padEnd(18)} ${"$total".padStart(10)} ${"runs".padStart(6)} ${"$/run".padStart(8)} ${"turns/run".padStart(10)}`);
  for (const r of agg.roleCosts.slice(0, top)) {
    const perRun = r.runs ? r.cost / r.runs : 0;
    const turnsPer = r.runs ? r.turns / r.runs : 0;
    L.push(
      `  ${r.category.padEnd(18)} ${fmtUsd(r.cost).padStart(10)} ${String(r.runs).padStart(6)} ${fmtUsd(perRun).padStart(8)} ${turnsPer.toFixed(1).padStart(10)}`,
    );
  }

  if (n > 1) {
    L.push("");
    L.push(`TOP ${Math.min(top, agg.perSession.length)} SESSIONS BY COST`);
    L.push(`  ${"session".padEnd(10)} ${"variant".padEnd(10)} ${"turns".padStart(6)} ${"agents".padStart(7)} ${"cost".padStart(9)}`);
    for (const s of agg.perSession.slice(0, top)) {
      const variant = s.variant.split(":").pop() ?? s.variant;
      L.push(
        `  ${s.sessionId.slice(0, 8).padEnd(10)} ${variant.padEnd(10)} ${String(s.mainTurns).padStart(6)} ${String(s.agents).padStart(7)} ${fmtUsd(s.cost).padStart(9)}`,
      );
    }
  }
  return L.join("\n");
}

function renderComparison(baseline: Aggregate, current: Aggregate): string {
  const c = compareAggregates(baseline, current);
  const L: string[] = [];
  L.push("");
  L.push("=".repeat(64));
  L.push("COMPARISON vs BASELINE");
  L.push("=".repeat(64));
  L.push(`  baseline: ${c.baseline.sessionCount} sessions, mean ${fmtUsd(c.baseline.meanCost)}, median ${fmtUsd(c.baseline.medianCost)}`);
  L.push(`  current:  ${c.current.sessionCount} sessions, mean ${fmtUsd(c.current.meanCost)}, median ${fmtUsd(c.current.medianCost)}`);
  const arrow = c.meanDelta <= 0 ? "▼" : "▲";
  L.push(`  mean delta: ${arrow} ${fmtUsd(Math.abs(c.meanDelta))} (${c.meanPctChange >= 0 ? "+" : ""}${c.meanPctChange.toFixed(1)}%)`);
  L.push("");
  L.push("  per-run cost by role (baseline -> current):");
  for (const r of c.roleDeltas) {
    const sign = r.pctChange > 0 ? "+" : "";
    L.push(
      `    ${r.category.padEnd(18)} ${fmtUsd(r.baselinePerRun).padStart(8)} -> ${fmtUsd(r.currentPerRun).padStart(8)}  (${sign}${r.pctChange.toFixed(0)}%)`,
    );
  }
  return L.join("\n");
}

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      project: { type: "string" },
      scan: { type: "boolean", default: false },
      depth: { type: "string" },
      "projects-root": { type: "string" },
      save: { type: "string" },
      baseline: { type: "string" },
      json: { type: "boolean", default: false },
      top: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const projectsRoot = values["projects-root"] ?? join(homedir(), ".claude", "projects");
  const top = values.top ? Math.max(1, parseInt(values.top, 10) || 12) : 12;

  let sessions: SessionCost[];
  if (values.session) {
    const result = analyzeSession(dirname(values.session), basename(values.session).replace(/\.jsonl$/, ""));
    if (!result) {
      process.stderr.write(`not a code-review session (no /code-review: command found): ${values.session}\n`);
      return 1;
    }
    sessions = [result];
  } else if (values.project) {
    const projectName = basename(values.project);
    sessions = scanProjects(dirname(values.project)).filter((s) => s.project === projectName);
  } else if (values.scan) {
    sessions = scanProjects(projectsRoot);
  } else {
    process.stderr.write("error: one of --session, --project, or --scan is required\n\n");
    process.stderr.write(HELP);
    return 2;
  }

  if (values.depth) {
    const want = values.depth;
    if (want !== "deep" && want !== "standard" && want !== "shallow") {
      process.stderr.write(`error: --depth must be deep, standard, or shallow (got "${want}")\n`);
      return 2;
    }
    sessions = sessions.filter((s) => s.depth === want);
  }

  if (sessions.length === 0) {
    const scope = values.depth ? ` at depth=${values.depth}` : "";
    process.stderr.write(`no code-review sessions found${scope}\n`);
    return 1;
  }

  const agg = aggregate(sessions);

  if (values.save) {
    writeFileSync(values.save, JSON.stringify(agg, null, 2));
    process.stderr.write(`baseline written to ${values.save}\n`);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderReport(agg, top)}\n`);

  if (values.baseline) {
    const baseline = JSON.parse(readFileSync(values.baseline, "utf8")) as Aggregate;
    process.stdout.write(`${renderComparison(baseline, agg)}\n`);
  }

  return 0;
}

runWhenMain(import.meta.url, main);
