# Provider text for skills/vibe/references/quality-loop-visual-qa.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: what-it-checks -->
Visual QA uses the repository's own design pack: its read-only visual
QA skill (`/visual-qa` in Claude Code, `$visual-qa` in Codex), which `/design`
and `$design` route production review through.

- When the linked ticket or its PRD has acceptance criteria, visual QA checks
  the change against them: the run gets the session decision table's
  `## Acceptance Criteria` list (those criteria, plus any the person's
  requests added) and reports each visual and UX criterion as met or not,
  with what it saw. For shared scope it compares each consumer page against
  that page's approved prototype route, flags every control present in the
  prototype but missing in production, and inventories rendered controls for
  any with no requirement naming that control on that surface.
- On a metric, summary, or card surface, it compares the card's owning
  container, width, order and responsive placement with the established grid
  or the page's official prototype story. A matching element count alone is
  not a layout result.
- When neither has any, it falls back to the design pack's best-practice
  review, against `.claude/design/soul.md`, as the skill does when there is
  no spec.

Run it the way handoff runs its visual QA (the handoff skill, "Browser E2E
and the repository's QA passes"): the skill dispatches its own read-only
agents on the session's last deployed commit, with the session's app link
and the screens the change touched. It changes no code. Its confirmed
findings go to the SAME writer as one fix request in the queue, under the
usual rules: design tokens and catalog components,
never new user-visible words (`guardrails.md`, "Copy"), and a finding that
needs a product choice goes through the research and necessity gate above.
That fix deploys like any other request, and the ready message names what
the check found and changed, in the person's terms. Owned prototype sessions
<!-- end: what-it-checks -->
