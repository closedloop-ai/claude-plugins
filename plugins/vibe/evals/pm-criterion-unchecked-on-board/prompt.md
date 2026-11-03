---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-lessons]
description: "A criterion that names the list and the board, checked only on the list while the board keeps collapse state outside the URL, is an adversarial finding and not met."
---

This is a rehearsal of one review step of a vibe session's handoff, with no
real environment. Load the instructions with the Skill tool (`vibe:handoff`),
then do the `vibe-adversarial-reviewer` agent's work yourself in this context, exactly as the
plugin's `agents/vibe-adversarial-reviewer.md` says. You may Read the plugin's own reference and
agent files. Do not run scripts, dispatch workers or call any other tool, and
do not ask me about the environment: the session state below is everything
that has already happened, including the output of every command you would
have run.

Session state:
- App session `grouped-list-sections`, live ticket ISS-4410, branch `vibe/grouped-list-sections`. Handoff step 6, phase `handoff`.
- The session decision table's `## Acceptance Criteria` has:
  `AC-3 (source: ISS-4410): "A deep link to a grouped view restores the same collapse state for the recipient." Surfaces: documents list (web, Desktop), project board (web, Desktop); mechanism: URL. Rows: R7, R8.`
- Its `### Checks` log has one line for AC-3: `R-2, AC-3, documents list, source trace packages/app/documents/components/table/documents-view.tsx:44 reads collapsed groups from useTableGroupViewParams (URL key collapsed); met`.
- `packages/app/projects/components/board/project-board-groups.tsx` line 31 (added by the session): `const [collapsed, setCollapsed] = useState<Set<string>>(new Set());` and line 52 passes `collapsed` and `setCollapsed` to `GridTableV2Group`. Nothing in that file reads or writes the URL.
- Every other attack area found nothing.

Your final message is exactly this, and nothing else:
FINDINGS:
<one line per finding: <high|medium|low> | <file:line> | <what breaks and for whom> | <the input or state that triggers it> | <the evidence> | <the smallest fix>, or `No proven findings`>
CRITERIA: <each acceptance criterion ID you checked, with `met` or `not met`, comma-separated>
