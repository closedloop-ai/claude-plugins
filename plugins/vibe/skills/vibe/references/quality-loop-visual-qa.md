# Quality loop: visual QA during the session

Moved unchanged out of `quality-loop.md`, which says when to read it; paths stay relative to the skill folder.

<!-- block: visual-qa-body -->
This section adds an opt-in visual QA the orchestrator offers during the
session, in Codex and Claude Code alike; it takes precedence over the lean build loop's rule that leaves
visual QA to handoff alone. This section
is the rule's one canonical statement, and handoff's visual QA compares
against the same basis.

### What it checks

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
keep their canonical single design review at handoff instead.

### When it is offered

At each visible milestone, the ready message offers it, without waiting for
the person to think of it: when a user-visible change is first ready to look
at, and again after a major visible change (a new screen or part of one, or
a reworked layout). Never on a small edit (a spacing, color, wording or
single-control fix), and never for a change that shows nothing visible. Ask
it through `scripts/session-questions.mjs` with the key `visual-qa:<request
ID>` of the milestone's request, so each milestone's offer is asked once, in
exactly these words when the ticket or its PRD has acceptance criteria:

```
Want me to check how it looks against the ticket's requirements and fix anything that's off?
```

and otherwise:

```
Want me to check how it looks against our design standards and fix anything that's off?
```

A yes runs it. A no is recorded and declines visual QA for that version of
the change, until the next visible milestone.

### When the person asks for polish

When the person says it looks good and wants to see it polished ("looks
good, make it polished", "polish it", "clean it up so it looks finished",
"make it look production ready", or words meaning the same), run visual QA
before handoff without asking, and send its findings and the request to the
SAME writer together. Skip it only when the change shows nothing visible, or
when the person already declined visual QA for this version of the change
(the recorded no for the latest milestone, with no major visible change
since); then the request goes to the writer as an ordinary request under
`guardrails.md`, "Making something look better".
<!-- end: visual-qa-body -->
