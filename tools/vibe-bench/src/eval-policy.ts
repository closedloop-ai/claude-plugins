/** Runtime names supported by the local vibe eval harness. */
export type EvalRuntime = "claude" | "codex";

/** Skill tags derived from the `vibe:<skill>` invocation in each case prompt. */
export type EvalSkill = "vibe" | "handoff" | "fleet-orchestrator";

/**
 * One reviewed policy for local nightly evaluation.
 * Changing a value is intentionally visible in source control and T0 tests.
 */
export const EVAL_POLICY = {
  claudeModel: "claude-sonnet-5-5",
  claudeJudgeModel: "claude-opus-5-5",
  codexModel: "gpt-6-sol",
  codexJudgeModel: "gpt-6-luna",
  failureReruns: 2,
  concurrency: 3,
  codexConcurrency: 2,
  reliabilityThreshold: 0.95,
  reliabilityMinimumObservations: 3,
} as const;

/** Refuse every paid eval path in hosted automation environments. */
export function requireDeveloperMachine(env: NodeJS.ProcessEnv = process.env): void {
  const hosted = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL",
    "TEAMCITY_VERSION", "TF_BUILD"];
  if (hosted.some((name) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
  })) throw new Error("eval-model-calls-forbidden-in-ci");
}
