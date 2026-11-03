---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-lessons]
description: "A marked agent-draft paragraph in a product docs page is blocking in every phase: nothing agent-written goes into public docs."
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
- App session `grouped-list-sections`, live ticket ISS-4410, branch `vibe/grouped-list-sections`. Handoff step 3, phase `handoff`.
- The inventory's `outsideAllowed` lists `{ "path": "apps/web/content/docs/features/documents.mdx", "status": "M" }`.
- `diff --name-only session-base apps/web/content/docs docs` printed `apps/web/content/docs/features/documents.mdx`.
- That file's diff adds lines 40 to 44:
  ```
  {/* Agent draft (ISS-4410): approve before merge */}
  Grouped lists now show each group as a band with its count. Collapse a band
  and share the link: the recipient sees the same bands collapsed.
  {/* End agent draft */}
  ```
- The change log says: "Feature docs: drafted the grouped-sections paragraph in apps/web/content/docs/features/documents.mdx, marked as an agent draft for design to approve."
- Every other check in the reviewer's list found nothing.

Your final message is the reviewer's findings, one per line, in exactly this
form and nothing else (or `No findings`):
<blocking|advisory> | <engineering decision|-> | <file:line> | <the problem in one sentence> | <the evidence> | <the compliant fix>
