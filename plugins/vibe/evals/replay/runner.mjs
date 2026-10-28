// M2: replay runner. For every corpus ticket it runs each arm (for example the
// installed plugin as `baseline` and a branch as `candidate`) at least MIN_RUNS
// times from the merge-base parent, giving the arm only the ticket. Live work
// (checkout, running the arm, capturing the diff) is injected through `deps`, so
// nothing here touches ClosedLoop or GitHub.
//
// deps = {
//   prepareWorkspace({ticket, arm, run}) -> {workspace}     // the parent checkout, PR and tests absent
//   runArm({arm, brief, workspace, run, ticket}) -> {outputText, telemetry?, branch?, contamination?}
//   captureDiff({workspace, baseSha}) -> {numstat, diffText?}   // `git diff --numstat` text
// }

import { ReplayResult } from "./results.mjs";

export const MIN_RUNS = 3;
const HIDDEN_KEYS = new Set(["pr", "pullRequest", "testFiles", "tests", "mergeBaseSha", "mergeSha", "mergeCommit", "diff", "files", "needsFlag"]);

/** What an arm may see: the ticket's own text only (and a human-written brief when the ticket has one). */
export function ticketBrief(ticket) {
  return {
    slug: ticket.slug,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: [...(ticket.acceptanceCriteria ?? [])],
    ...(typeof ticket.brief === "string" && ticket.brief.trim() ? { briefText: ticket.brief } : {}),
  };
}

/** Throws when anything that identifies the human change is in what an arm is given. */
export function assertHidden(brief) {
  const leaked = Object.keys(brief).filter((key) => HIDDEN_KEYS.has(key));
  if (leaked.length > 0) throw new Error(`brief exposes the human change: ${leaked.join(", ")}`);
}

/** The run order: for each ticket and run index, every arm in turn, so arms share conditions. */
export function planRuns({ corpus, arms, runs = MIN_RUNS }) {
  if (!Number.isInteger(runs) || runs < MIN_RUNS) throw new Error(`runs must be an integer of at least ${MIN_RUNS}.`);
  if (!Array.isArray(arms) || arms.length === 0 || new Set(arms.map((arm) => arm.name)).size !== arms.length) {
    throw new Error("arms must be a non-empty list of distinctly named arms.");
  }
  const plan = [];
  for (const ticket of corpus) {
    for (let run = 1; run <= runs; run += 1) {
      for (const arm of arms) plan.push({ slug: ticket.slug, taskClass: ticket.taskClass, arm: arm.name, run, baseSha: ticket.pr.mergeBaseSha });
    }
  }
  return plan;
}

/** Executes the plan. A step that throws is recorded as BLOCKED with its reason and the replay goes on. */
export async function runReplay({ corpus, arms, runs = MIN_RUNS, deps }) {
  const bySlug = new Map(corpus.map((ticket) => [ticket.slug, ticket]));
  const armByName = new Map(arms.map((arm) => [arm.name, arm]));
  const records = [];
  for (const step of planRuns({ corpus, arms, runs })) {
    const ticket = bySlug.get(step.slug);
    const arm = armByName.get(step.arm);
    const brief = ticketBrief(ticket);
    assertHidden(brief);
    try {
      const { workspace } = await deps.prepareWorkspace({ ticket, arm, run: step.run });
      const output = await deps.runArm({ arm, brief, workspace, run: step.run, ticket });
      const diff = await deps.captureDiff({ workspace, baseSha: step.baseSha });
      records.push({
        ...step, result: ReplayResult.Pass, workspace, branch: output.branch ?? null, outputText: output.outputText ?? "",
        telemetry: output.telemetry ?? null, contamination: output.contamination ?? null,
        numstat: diff.numstat, diffText: diff.diffText ?? null,
      });
    } catch (error) {
      records.push({ ...step, result: ReplayResult.Blocked, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return records;
}
