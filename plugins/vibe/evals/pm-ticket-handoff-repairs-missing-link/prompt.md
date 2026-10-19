---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, plan-links]
description: "Handoff finds the live ticket no longer produces the recorded PLN and repairs the link instead of creating another PLN or asking the person."
---

This is a rehearsal of one `vibe-ticket-worker` turn in a vibe session, with
no real environment. Load the instructions with the Skill tool (`vibe:handoff`),
then do the `vibe-ticket-worker` agent's work yourself in this context, exactly
as the plugin's `agents/vibe-ticket-worker.md` says. You may Read the plugin's
own reference, script and agent files. Do not run scripts, dispatch workers or
call any ClosedLoop or other tool, and do not ask me about the environment: the
session state below gives the result of every read, listing and script you
would run. Instead of making them, list the calls you would make.

Session state:
- App session `board-chips`, worktree `<wt>`, branch `vibe/board-chips`. The session record's `ticket` (the document the session started from) is PRD-718, its `liveTicket` is ISS-12640 and its operator id is `6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f`.
- `get-document` ISS-12640: title "Board filter chips", projectId PRO-88, assigneeId `6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f` (the operator), status IN_PROGRESS.
- `get-document` PRD-718: id `11111111-2222-4333-8444-555555555555`, type PRD.
- This turn: `vibe-ticket-worker` in handoff mode. Its steps 1 to 6 are done; do step 7 (the "Source link and session plan" check) and stop before step 8. The person asked to pass the work to design.
- The record has `livePlan: PLN-1450` and `livePlanStatus: APPROVED`.
- `list-artifact-links` ISS-12640 `direction: "source"`, `linkType: "PRODUCES"`: one link, source PRD-718, target ISS-12640.
- `list-artifact-links` ISS-12640 `direction: "target"`, `linkType: "PRODUCES"`: no links (someone deleted the ticket's link to its plan).
- `get-document` PLN-1450: status APPROVED, projectId PRO-88, assigneeId `6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f`.
- `get-document-content` PLN-1450 returned its latest version in one chunk, saved to `<gitdir>/vibe-live-plan-published.md`.
- `session-plan.mjs --worktree "<wt>" --out "<gitdir>/vibe-live-plan.md" --published "<gitdir>/vibe-live-plan-published.md"` printed `{"ok": true, "empty": false, "plans": [".closedloop-ai/vibe-plans/request-1.md"], "digest": "41d0", "current": true}`.
- A `create-artifact-link` you make succeeds and a later listing shows it.

Your final message is exactly this form and nothing else:
CALLS:
1. <ClosedLoop tool name or script command> <its arguments, as JSON for a ClosedLoop tool>
2. ...
STATUS: <DONE|NEEDS_CHANGE|NEEDS_PERSON|BLOCKED> <one line>

List every ClosedLoop read and write and every `vibe-sessions.mjs touch` you
would make, in order, one per line, and nothing you would not make. Write
`CALLS: none` when there are none.
