# Vibe: mockup sessions

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: mockup-flow -->
Use `new-prototype` without an app data mode only when current main provides the canonical prototype
skill. Otherwise use `new` and share the repository's app or Storybook preview.
Both start on an owned `vibe/<slug>` branch from fresh main.
Bootstrap/ticket setup remains operational. Then register/resume the SAME
persistent implementation writer under section 5 and forward the person's
mockup request. It reads the absolute canonical
`<repo-root>/.claude/skills/prototype/SKILL.md` guidance, plans locally and
performs all prototype/shared surface/registry changes itself. Do not spawn a separate prototype source writer.

Preserve canonical mock-data, componentization, visual/product review and
metadata ownership. Ignore canonical steps asking for a second source writer,
worktree/branch or a technical-plan approval. All corrections return to this
same context, and no tests are authored (`references/guardrails.md`, "Tests").

After the writer's quick checks pass, the orchestrator commits with its
script. Dispatch `vibe-prototype-worker` only in operational share mode to
publish that exact checked commit through canonical Vercel sharing. If it
needs source generation/fixes, return those facts to the SAME writer. No
helper silently edits registry, metadata or implementation to make sharing pass.

Share the verified preview URL and its access instructions. Keep the full SHA
and slug in the session record. Post progress while sharing waits. Resume the existing writer
ID and publication; chat, annotations, fixes and handoff all queue to it.
Never create a new worktree/branch for these requests or an arbitrary
unrecorded prototype. Next-owner assignment and canonical metadata transitions
remain in the handoff flow.
<!-- end: mockup-flow -->
