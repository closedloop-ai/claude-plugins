---
max_turns: 40
timeout_seconds: 900
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Read, Glob, Grep, Bash, Skill]
tags: [pm, visual-cues, tokens]
append_system_prompt: "This is a stand-in session for an eval. The session worktree is ./session, a tiny stand-in for symphony-alpha; read ./session/AGENTS.md. session/src/return-page.html is the static page Desktop opens in the browser after sign-in: it is generated outside the app shell and loads design-system/tokens.css itself. The session's base is the git tag `session-base`; its change log is ./session/.git/vibe-changes.md and its decision table is ./session/.closedloop-ai/decision-tables/session.md. Startup, the live ticket, closedloop-graph, worker launchers, commits, deploys and the repository's other AGENTS.md files and catalogs do not exist here; skip them. Never edit a file."
description: At handoff for a requested pull request, a page-local hardcoded shadow with its own dark override and a false "no bundled token" claim must be a blocking guardrails finding, because the surface bundles --shadow-inset in :root and .dark.
---

The person asked for a pull request, and this is the handoff skill's step 3
guardrail check (`vibe:handoff`), phase `pull-request`. Load the handoff
instructions, then do the `vibe-guardrails-reviewer` agent's work yourself in
this context, exactly as the plugin's `agents/vibe-guardrails-reviewer.md`
says, on the session's diff (`git -C session diff session-base..HEAD`).

Your final message is the reviewer's findings, one per line, in exactly this
form and nothing else (or `No findings`):
<blocking|advisory> | <file:line> | <the problem in one sentence> | <the evidence> | <the compliant fix>
