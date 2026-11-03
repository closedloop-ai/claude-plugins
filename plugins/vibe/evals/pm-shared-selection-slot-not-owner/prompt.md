---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-lessons]
description: "Two list children each keeping their own selection state behind a shared parent's slot is the blocking shared-owner red flag, even though the slot exists."
---

This is a rehearsal of one review step of a vibe session's handoff, with no
real environment. Load the instructions with the Skill tool (`vibe:handoff`),
then do the `vibe-guardrails-reviewer` agent's work yourself in this context, exactly as the
plugin's `agents/vibe-guardrails-reviewer.md` says. You may Read the plugin's own reference and
agent files. Do not run scripts, dispatch workers or call any other tool, and
do not ask me about the environment: the session state below is everything
that has already happened, including the output of every command you would
have run.

Session state:
- App session `bulk-tag-add`, live ticket ISS-4512 ("Add a tag to selected Sessions and Branches rows"), branch `vibe/bulk-tag-add`. Handoff step 3, phase `handoff`.
- Sessions and Branches both render the shared parent `GridTableListSurface` (`packages/app/shared/components/grid-table-list-surface.tsx`). The session added to it, at line 57, `selectionSlot?: ReactNode` and at line 58 `renderRowCheckbox?: (rowId: string) => ReactNode`, and renders both where given.
- `packages/app/sessions/components/sessions-list-v2.tsx`, lines 88 to 104 (added): `const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());`, a `toggleRow(id)` handler, a `clearSelection()` handler and a `selectedCount` derived value, passed into `selectionSlot` and `renderRowCheckbox`.
- `packages/app/branches/components/branches-list.tsx`, lines 61 to 78 (added): the same `useState<Set<string>>`, its own `toggleRow(id)`, `clearSelection()` and `selectedCount`, passed the same way.
- The change log records `Owner: packages/app/shared/components/grid-table-list-surface.tsx` for the selection request, with Rule 1.
- Every other check in the reviewer's list found nothing.

Your final message is the reviewer's findings, one per line, in exactly this
form and nothing else (or `No findings`):
<blocking|advisory> | <engineering decision|-> | <file:line> | <the problem in one sentence> | <the evidence> | <the compliant fix>
