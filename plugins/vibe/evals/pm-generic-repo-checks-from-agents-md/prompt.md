---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, generic-walk, generic]
---

This is a read-only rehearsal of a vibe build loop step. Load (`vibe:vibe`) and
read what you need from the plugin's references. Do not run scripts or call
any other tool.

Session state:
- The session runs in the person's own GitHub repository (npm, Playwright).
  Its AGENTS.md says: "Run the tests with `npm test`. Start the app with
  `npm run dev`."
- No provider is bound: no tracker, no graph, no provider recipes.
- The writer finished the change and the root is about to validate it before
  the first push.

Answer exactly:
RESEARCH: <how the writer locates the owning code, in one line>
CHECKS: <the command or commands that validate the change here>
BOOTSTRAP: <how the worktree is bootstrapped>
