# Provider text for agents/vibe-consolidated-reviewer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: plan-exclude -->
- Diff once with `git -C <wt> diff "$(git -C <wt> merge-base HEAD origin/main)"`
  plus `git -C <wt> ls-files --others --exclude-standard`; exclude exactly
  `.closedloop-ai/vibe-plans/`. Read the full changed files and the callers of
  anything changed.
<!-- end: plan-exclude -->

<!-- block: graph-block -->
For each confirmed finding: `severity` (high, medium, low), `file:line`, which
reviewer's check it is (`guardrails <n>` or `adversarial <n>`), what breaks and
for whom, the triggering input or state, the evidence and the smallest fix.
Then one line per area checked and found clean, and one line naming every
check you ran yourself because the file did not cover it. Return "No proven
findings" when that is the result. End with the Graph block
(`../skills/vibe/references/closedloop-graph.md`).
<!-- end: graph-block -->
