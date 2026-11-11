# Quality loop: visual QA during the session

Lines that start `> Provider` follow `references/provider-text.md`.

Moved out of `quality-loop.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: visual-qa-body -->
This section adds an opt-in visual QA the orchestrator offers during the
session, in Codex and Claude Code alike; it takes precedence over the lean build loop's rule that leaves
visual QA to handoff alone. This section
is the rule's one canonical statement, and handoff's visual QA compares
against the same basis.

### What it checks

<!-- generic: what-it-checks -->
Visual QA uses the repository's own visual QA skill when it ships one, run
the way handoff runs it (the handoff skill, "Browser E2E and the repository's
QA passes"); otherwise the orchestrator looks at each touched screen in the
app tab itself.

- It checks the change against the session decision table's `## Acceptance
  Criteria` list and reports each visual and UX criterion as met or not, with
  what it saw.
- On a metric, summary, or card surface, it compares the card's owning
  container, width, order and responsive placement with the established
  grid. A matching element count alone is not a layout result.
- With no criteria, it reviews against the repository's own design docs, and
  `guardrails-ui.md` when the repository has none.

It changes no code. Its confirmed findings go to the SAME writer as one fix
request in the queue, under the usual rules: design tokens and catalog
components, never new user-visible words (`guardrails.md`, "Copy"), and a
finding that needs a product choice goes through the research and necessity
gate above. The ready message names what the check found and changed, in the
person's terms. Owned prototype sessions keep their canonical single design
review at handoff instead.
<!-- end generic: what-it-checks -->
> Provider `recipes` (block `what-it-checks` of `vibe/quality-loop-visual-qa.md`)
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
`guardrails-ui.md`, "Making something look better".
<!-- end: visual-qa-body -->
