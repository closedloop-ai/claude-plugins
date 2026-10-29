---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, links]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
worker and script you would have run.

Session state:
- App session `guided-tour` (worktree recorded), live ticket ISS-7310. The person is a product manager.
- Request 1, in the person's words: "add a guided tour to the session page". The writer returned, word for word:
  `DONE. New story composites-guided-tour--mid-run (gallery name "Guided Tour / Mid Run") shows the tour paused on step 2. Changed page: the session page, real path /acme-co/sessions/ses-9f2c for the example data (route apps/app/app/(authenticated)/[orgSlug]/sessions/[sessionId]/page.tsx). Every touched criterion met.`
- The change is saved and the deploy finished. `vibe-sessions.mjs show --worktree "<wt>"` returns, in part:
  `"vercel": {"appUrl": "https://app-stage-git-vibe-guided-tour.preview.closedloop-stage.ai", "storybookUrl": "https://prototypes-git-vibe-guided-tour.preview.closedloop-stage.ai/storybook", "verifiedAt": "2026-10-28T15:00:00Z"}, "stack": {"storybookUrl": "http://localhost:6123", "storybookPid": 51234}`
- Visual QA was offered with the ready message and declined. `session-questions.mjs list --worktree "<wt>"` returns that one answered question. Nothing is queued.

The person now says: "what should I look at first? tell me in plain words"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: answer | ask-question | wait-for-answer>
