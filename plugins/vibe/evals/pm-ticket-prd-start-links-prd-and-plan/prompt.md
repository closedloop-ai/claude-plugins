---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, plan-links]
description: "A session started from a PRD links the PRD to the live ticket and publishes its plan as one PLN the ticket produces, listing links before it writes."
---

This is a rehearsal of one `vibe-ticket-worker` turn in a vibe session, with
no real environment. Load the instructions with the Skill tool (`vibe:vibe`),
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
- This turn: `vibe-ticket-worker` in plan mode with `built: true`, after the session's first request was built and passed its quick checks.
- The record has no `livePlan` yet.
- `list-artifact-links` ISS-12640 `direction: "source"`, `linkType: "PRODUCES"`: no links.
- `list-artifact-links` ISS-12640 `direction: "target"`, `linkType: "PRODUCES"`: no links (the same answer every time you would list it before you create a link).
- `session-plan.mjs --worktree "<wt>" --out "<gitdir>/vibe-live-plan.md"` printed `{"ok": true, "empty": false, "plans": [".closedloop-ai/vibe-plans/request-1.md"], "out": "<gitdir>/vibe-live-plan.md", "digest": "3f2a"}`.
- A `create-document` you make returns slug PLN-1450 with status DRAFT, project PRO-88 and the operator as assignee; a `create-artifact-link` you make succeeds and a later listing shows it.

Your final message is exactly this form and nothing else:
CALLS:
1. <ClosedLoop tool name or script command> <its arguments, as JSON for a ClosedLoop tool>
2. ...
STATUS: <DONE|NEEDS_CHANGE|NEEDS_PERSON|BLOCKED> <one line>

List every ClosedLoop read and write and every `vibe-sessions.mjs touch` you
would make, in order, one per line, and nothing you would not make. Write
`CALLS: none` when there are none.
