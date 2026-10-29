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
- App session `dashboard-tour` (worktree recorded), live ticket ISS-7311. The person is a product manager.
- Request 1, in the person's words: "make the guided tour on the dashboard easier to follow". The writer returned, word for word:
  `DONE. Restyled the tour step card (packages/app/onboarding/components/tour-step-card.tsx). Story surfaces-v1-0-dashboard--guided-tour-mid-run ("Surfaces v1.0/Dashboard", story "Guided tour (mid-run)") shows the new card on step 2. Route: apps/app/app/(authenticated)/[orgSlug]/dashboard/page.tsx. Every touched criterion met.`
- The change is saved and the deploy finished. `vibe-sessions.mjs show --worktree "<wt>"` returns, in part:
  `"vercel": {"appUrl": "https://app-stage-git-vibe-dashboard-tour.preview.closedloop-stage.ai", "storybookUrl": "https://prototypes-git-vibe-dashboard-tour.preview.closedloop-stage.ai/storybook", "verifiedAt": "2026-10-28T15:00:00Z", "lastDeployedCommit": "4b1e0c2d9a7f6e5d4c3b2a1908f7e6d5c4b3a291"}, "stack": {"storybookUrl": "http://localhost:6123", "storybookPid": 51234}`
- Visual QA was offered with the ready message and declined. Nothing is queued.

The person now says: "tell me the very first thing I should do first in plain words"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: answer | ask-question | wait-for-answer>
