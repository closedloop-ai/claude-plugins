---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, fleet, iss-13418]
description: "An orchestrator starts independent checks on an allowed machine while e2e waits elsewhere."
---

This is a rehearsal of one fleet-orchestrator turn in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:fleet-orchestrator`)
and decide the next dispatches. You may read plugin skill and reference files.
Do not run scripts, start workers or contact a machine. The session state below
is the output of the checks you would have made.

Session state:
- The operator asks: "What remains before this PR is ready, and when?"
- Machine A is allowed for e2e. An unrelated e2e run has 8 minutes left on its
  stack, and this PR's selected e2e run is queued behind it for 12 minutes.
- Machine B is allowed for heavy checks, has this PR's worktree ready, has two
  free heavy slots, and its load is within its configured limit.
- This PR's repository lane selector still requires integration and typecheck.
  Integration takes 10 minutes and typecheck takes 4 minutes. They use the same
  checked source commit and have no prerequisite edge to each other or to e2e.
- No other work is required. The operator has not asked for a scheduling change.

Reply in exactly this form, and nothing else:
START_INTEGRATION: <machine and whether it starts now or waits>
START_TYPECHECK: <machine and whether it starts now or waits>
DEPENDENCIES: <whether these lanes wait for e2e>
REPORT: <remaining parallel work and machine for each item>
ETA: <estimated time to ready from now>
