import type { BenchmarkPhase, BenchmarkShape, TopComponent } from "./result-schema.ts";

/** Evidence carried by a transcript message or an OTEL API request. */
export interface CallEvidence {
  parentToolUseId?: string | null;
  agentName?: string | null;
  skillName?: string | null;
  querySource?: string | null;
  phase?: BenchmarkPhase | null;
}

/** One call's mutually exclusive owner and optional finer facets. */
export interface Attribution {
  component: TopComponent;
  unattributedReason: string | null;
  skill: string | null;
  worker: string | null;
  phase: BenchmarkPhase | null;
  declaredAgentModel: string | null;
}

/** A conservative phase marker: unmatched calls retain the last known phase. */
export function phaseFromTool(name: string, input: unknown): BenchmarkPhase | null {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const text = [value.command, value.skill, value.skill_name, value.subagent_type, value.description]
    .filter((item): item is string => typeof item === "string").join(" ").toLowerCase();
  if (name === "Skill" && /handoff/.test(text)) return "handoff";
  if (/gh\s+pr\s+create|pr-create|raise a pr/.test(text)) return "pr";
  if (/pre-pr-lanes|adversarial|guardrails|review/.test(text)) return "review";
  if (/handoff|handoff-inventory/.test(text)) return "handoff";
  if (/environment|deploy|main-sync-push/.test(text)) return "deploy";
  if (/commit-worktree|build|change-worker|backend-worker|primitive-worker|storybook/.test(text)) return "build";
  if (/requirements/.test(text)) return "requirements";
  if (name === "Skill" && /vibe:vibe/.test(text)) return "startup";
  return null;
}

function workerPhase(name: string): BenchmarkPhase | null {
  if (name.includes("requirements")) return "requirements";
  if (name.includes("adversarial") || name.includes("guardrails") || name.includes("verify")) return "review";
  if (name.includes("handoff")) return "handoff";
  if (name.includes("environment")) return "deploy";
  if (name.includes("change") || name.includes("backend") || name.includes("primitive") || name.includes("storybook")) return "build";
  return null;
}

/** Assign one and only one top-level owner, then the facets evidence supports. */
export function attributeCall(
  evidence: CallEvidence,
  shape: BenchmarkShape,
  agentModels: Record<string, string>,
): Attribution {
  const worker = evidence.agentName?.replace(/^vibe:/, "") ?? null;
  const directSkill = evidence.skillName ?? null;
  const skill = directSkill ?? (shape === "vibe" ? "vibe:vibe" : "vibe:fleet-orchestrator");
  let component: TopComponent;
  let unattributedReason: string | null = null;
  if (worker) {
    if (agentModels[worker]) component = "vibe";
    else if (worker === "fleet-orchestrator") component = "fleet-orchestrator";
    else { component = "unattributed"; unattributedReason = `unknown-agent:${worker}`; }
  } else if (evidence.parentToolUseId) {
    component = "unattributed";
    unattributedReason = `unknown-parent-tool:${evidence.parentToolUseId}`;
  } else if (directSkill?.startsWith("fleet-orchestrator")) {
    component = "fleet-orchestrator";
  } else if (directSkill?.startsWith("vibe:")) {
    component = "vibe";
  } else if (!evidence.querySource || evidence.querySource === "repl_main_thread") {
    component = shape === "vibe" ? "vibe" : "fleet-orchestrator";
  } else {
    component = "unattributed";
    unattributedReason = `unknown-query-source:${evidence.querySource}`;
  }
  return {
    component,
    unattributedReason,
    skill,
    worker: component === "vibe" ? worker : null,
    phase: worker && component === "vibe" ? workerPhase(worker) ?? evidence.phase ?? null : evidence.phase ?? null,
    declaredAgentModel: worker && component === "vibe" ? agentModels[worker] ?? null : null,
  };
}
