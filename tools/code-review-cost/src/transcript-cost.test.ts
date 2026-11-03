import { describe, it, expect } from "vitest";
import {
  parseUsage,
  roleCategory,
  resolveDepth,
  detectCodeReview,
  foldThread,
  accumulate,
  perModelCost,
  aggregate,
  compareAggregates,
  analyzeSession,
  scanProjects,
  type PerModel,
  type SessionCost,
} from "./transcript-cost.js";
import { join } from "node:path";
import { emptyTokenCounts } from "./pricing.js";
import { assistantEntry, writeSessionTree } from "./test-fixtures.js";

describe("parseUsage", () => {
  it("splits cache_creation into 5m and 1h tiers", () => {
    const t = parseUsage({
      input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 },
    });
    expect(t).toEqual({ input: 10, cacheRead: 20, output: 30, cacheWrite5m: 5, cacheWrite1h: 7 });
  });

  it("falls back to 5m tier when the split is absent", () => {
    const t = parseUsage({ input_tokens: 1, cache_creation_input_tokens: 99 });
    expect(t.cacheWrite5m).toBe(99);
    expect(t.cacheWrite1h).toBe(0);
  });

  it("returns zeros for missing usage", () => {
    expect(parseUsage(undefined)).toEqual(emptyTokenCounts());
  });
});

describe("roleCategory", () => {
  const cases: [string, string][] = [
    ["Verify auditor_f0", "verifier"],
    ["Bug Hunter A p0", "bug_hunter"],
    ["BHA partition 0", "bug_hunter"],
    ["BHB cross-file review", "bug_hunter"],
    ["Unified Auditor", "auditor"],
    ["Domain auth-security", "domain_critic"],
    ["Premise Reviewer", "premise"],
    ["Impact Analyzer", "impact_analyzer"],
    ["Signal extraction dispatch", "signal_extraction"],
    ["Coverage critic dispatch", "coverage_critic"],
    ["Fast-path code review", "fast_path"],
    ["Mystery agent", "other"],
  ];
  it.each(cases)("categorizes %s as %s", (desc: string, expected: string) => {
    expect(roleCategory(desc)).toBe(expected);
  });

  it("prefers verifier over a substring role match (Verify auditor...)", () => {
    expect(roleCategory("Verify auditor_f1")).toBe("verifier");
  });
});

describe("foldThread", () => {
  const lines = [
    assistantEntry("claude-opus-4-8", { output: 100 }, { tools: ["Bash", "Agent"] }),
    assistantEntry("claude-sonnet-4-6", { output: 200 }, { sidechain: true, tools: ["Read"] }),
    assistantEntry("claude-opus-4-8", { cacheRead: 1000 }, { tools: ["Bash"] }),
  ] as Parameters<typeof foldThread>[0];

  it("counts only main-thread (non-sidechain) turns when sidechainOnly=false", () => {
    const s = foldThread(lines, false);
    expect(s.turns).toBe(2);
    expect(s.tools).toEqual({ Bash: 2, Agent: 1 });
    expect(s.tokens.opus?.output).toBe(100);
    expect(s.tokens.opus?.cacheRead).toBe(1000);
    expect(s.tokens.sonnet).toBeUndefined();
  });

  it("counts every assistant turn when sidechainOnly is undefined", () => {
    const s = foldThread(lines);
    expect(s.turns).toBe(3);
    expect(s.tokens.sonnet?.output).toBe(200);
  });
});

describe("accumulate / perModelCost", () => {
  it("sums cost across model families", () => {
    const m: PerModel = {};
    accumulate(m, "opus", { ...emptyTokenCounts(), output: 1_000_000 }); // $75
    accumulate(m, "sonnet", { ...emptyTokenCounts(), output: 1_000_000 }); // $15
    expect(perModelCost(m)).toBeCloseTo(90.0, 6);
  });
});

function makeSession(id: string, mainCostTokens: number, agentSpecs: { cat: string; cost: number }[]): SessionCost {
  // Build via the public analyzer using a temp tree to keep shapes honest.
  const { projectDir } = writeSessionTree({
    project: `proj-${id}`,
    sessionId: id,
    variant: "/code-review:deep",
    mainLines: [assistantEntry("claude-opus-4-8", { output: mainCostTokens })],
    agents: agentSpecs.map((a, i) => ({
      id: `${id}-${i}`,
      description: a.cat,
      lines: [assistantEntry("claude-sonnet-4-6", { output: a.cost })],
    })),
  });
  const s = analyzeSession(projectDir, id);
  if (!s) throw new Error("expected a code-review session");
  return s;
}

describe("aggregate", () => {
  it("rolls up main/fleet split, roles, and distribution", () => {
    // main: opus output 1M = $75 ; agents sonnet output 1M = $15 each
    const s1 = makeSession("aaaaaaaa", 1_000_000, [
      { cat: "Premise Reviewer", cost: 1_000_000 },
      { cat: "Unified Auditor", cost: 1_000_000 },
    ]);
    const s2 = makeSession("bbbbbbbb", 1_000_000, [{ cat: "Domain auth", cost: 1_000_000 }]);
    const agg = aggregate([s1, s2]);

    expect(agg.sessionCount).toBe(2);
    expect(agg.mainCost).toBeCloseTo(150.0, 4); // 2 x $75
    expect(agg.fleetCost).toBeCloseTo(45.0, 4); // 3 x $15
    expect(agg.totalCost).toBeCloseTo(195.0, 4);
    expect(agg.variants["/code-review:deep"]).toBe(2);
    // output is the only token kind used here
    expect(agg.costByKind.output).toBeCloseTo(195.0, 4);

    const premise = agg.roleCosts.find((r) => r.category === "premise");
    expect(premise?.runs).toBe(1);
    expect(premise?.cost).toBeCloseTo(15.0, 4);
    // most expensive session first
    expect(agg.perSession[0]?.cost).toBeGreaterThanOrEqual(agg.perSession[1]?.cost ?? 0);
  });
});

describe("compareAggregates", () => {
  it("reports mean delta and per-role per-run change", () => {
    const baseline = aggregate([
      makeSession("c1111111", 2_000_000, [{ cat: "Premise Reviewer", cost: 1_000_000 }]),
    ]);
    // current: premise removed, cheaper main
    const current = aggregate([makeSession("d1111111", 1_000_000, [{ cat: "Unified Auditor", cost: 1_000_000 }])]);
    const cmp = compareAggregates(baseline, current);
    expect(cmp.meanDelta).toBeLessThan(0); // got cheaper
    const premiseDelta = cmp.roleDeltas.find((r) => r.category === "premise");
    expect(premiseDelta?.currentPerRun).toBe(0); // gone in current
  });
});

describe("analyzeSession / scanProjects", () => {
  it("ignores non code-review sessions and finds real ones", () => {
    const { root, projectDir } = writeSessionTree({
      project: "myproj",
      sessionId: "11111111-2222-3333-4444-555555555555",
      variant: "/code-review:deep",
      mainLines: [assistantEntry("claude-opus-4-8", { cacheRead: 500_000, output: 1000 }, { tools: ["Bash"] })],
      agents: [{ id: "x1", description: "Bug Hunter A p0", lines: [assistantEntry("claude-opus-4-8", { output: 5000 })] }],
    });
    const s = analyzeSession(projectDir, "11111111-2222-3333-4444-555555555555");
    expect(s).not.toBeNull();
    expect(s?.agents).toHaveLength(1);
    expect(s?.agents[0]?.category).toBe("bug_hunter");

    const all = scanProjects(root);
    expect(all).toHaveLength(1);
    expect(all[0]?.variant).toBe("/code-review:deep");
  });
});

describe("resolveDepth", () => {
  it("binds tier from :deep and :shallow variants regardless of args", () => {
    expect(resolveDepth("/code-review:deep", "1425")).toBe("deep");
    expect(resolveDepth("/code-review:shallow", "")).toBe("shallow");
  });

  it("defaults a bare :start to standard", () => {
    expect(resolveDepth("/code-review:start", "")).toBe("standard");
    expect(resolveDepth("/code-review:start", "PR-123 src/foo.ts")).toBe("standard");
  });

  it("honors an explicit --depth flag on :start", () => {
    expect(resolveDepth("/code-review:start", "--depth deep")).toBe("deep");
    expect(resolveDepth("/code-review:start", "--depth shallow extra")).toBe("shallow");
  });
});

describe("detectCodeReview", () => {
  it("resolves a :start --depth deep session to deep", () => {
    const { projectDir } = writeSessionTree({
      project: "p",
      sessionId: "s1",
      variant: "/code-review:start",
      args: "--depth deep",
      mainLines: [assistantEntry("claude-opus-4-8", { output: 10 })],
    });
    expect(detectCodeReview(join(projectDir, "s1.jsonl"))).toEqual({ variant: "/code-review:start", depth: "deep" });
  });

  it("resolves a bare :deep session to deep", () => {
    const { projectDir } = writeSessionTree({
      project: "p",
      sessionId: "s2",
      variant: "/code-review:deep",
      mainLines: [assistantEntry("claude-opus-4-8", { output: 10 })],
    });
    expect(detectCodeReview(join(projectDir, "s2.jsonl"))?.depth).toBe("deep");
  });
});

describe("aggregate byDepth", () => {
  it("segments cost by resolved depth tier", () => {
    const deep = makeSession("deep0000", 1_000_000, [{ cat: "Unified Auditor", cost: 1_000_000 }]); // variant :deep
    const { projectDir } = writeSessionTree({
      project: "p-std",
      sessionId: "std00000",
      variant: "/code-review:start", // -> standard
      mainLines: [assistantEntry("claude-opus-4-8", { output: 1_000_000 })],
    });
    const std = analyzeSession(projectDir, "std00000");
    if (!std) throw new Error("expected a code-review session");

    const agg = aggregate([deep, std]);
    const tiers = Object.fromEntries(agg.byDepth.map((d) => [d.depth, d]));
    expect(tiers.deep?.count).toBe(1);
    expect(tiers.standard?.count).toBe(1);
    expect(tiers.deep?.fleetCost).toBeCloseTo(15.0, 4); // auditor: sonnet 1M output
    expect(tiers.standard?.fleetCost).toBe(0); // standard fixture has no agents
    expect(tiers.shallow).toBeUndefined(); // empty tiers are omitted
  });
});
