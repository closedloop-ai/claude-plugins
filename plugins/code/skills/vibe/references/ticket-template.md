# The live ticket

Every vibe session has one ClosedLoop issue ticket, created when the session
starts (assigned to the person running the session, the session record's
`operator`, status In Progress) and kept current by the
workers while the person works. Engineering and design read it to know what
was built, what is missing, and where to look. Handoff checks it is complete;
it never writes it from scratch.

## Rules for every worker that edits it

- Read the latest version with `get-document` (`includeContent: true`, a large
  `contentMaxChars`) immediately before you write, change only the sections
  your step owns (table below), keep every other section exactly as it is,
  and write the whole body back with `create-document-version`. Never edit
  status, assignee, or title unless your instructions say so.
- The Environment, Production flag snapshot, and Sessions sections are never
  written by hand: run `node <vibe skill>/scripts/vibe-sessions.mjs
  ticket-sections --worktree "<wt>"` and paste its `markdown` over those three
  sections.
- `Pending.` marks a section or line nobody has filled yet. Replace it when
  you fill it; leave it when you have nothing for it. Handoff refuses a ticket
  that still has one.
- Write for an engineer who never saw the session, in plain words. Use the
  person's own words for what they asked for; never invent requirements.
- ClosedLoop strips angle-bracketed text from ticket content, so anything
  written in angle brackets (a component like `<TagMenu>`, a placeholder like
  `<tag>`) must go in a code span or it disappears.
- Keep the headings exactly as below; the handoff check finds sections by
  heading. Omit `## API requirements` in a full-scope session, and
  `## Backend built` and `## Backend still missing` in a draft one.

| Section | Written by | When |
|---|---|---|
| What this is | `vibe-ticket-worker` | session start |
| Scope and acceptance criteria | `vibe-ticket-worker`, then `vibe-change-worker` | session start; whenever the person changes what they want |
| Environment | `ticket-sections` (via `vibe-environment-worker`) | environment start, every redeploy |
| Progress | `vibe-change-worker`, `vibe-backend-worker`, `vibe-primitive-worker`, `vibe-environment-worker` | after each change and each redeploy |
| API requirements (draft) | `vibe-change-worker` | as each stub is made; reconciled at handoff |
| Backend built, Backend still missing (full) | `vibe-backend-worker`, `vibe-change-worker` | as backend work is built or found missing |
| Production flag snapshot | `ticket-sections` (via `vibe-environment-worker`) | environment start, a refresh the person asked for |
| Sessions | `ticket-sections` (via `vibe-environment-worker`, `vibe-ticket-worker`) | every redeploy, handoff |
| Handoff | `vibe-ticket-worker` | handoff |
| Engineering checklist | `vibe-ticket-worker` | session start, keeping only the lines for the session's scope |

## Body

```markdown
## What this is

<Two or three sentences in the person's words: what someone will be able to
do and why it matters. Name the originating ticket if the session started from
one.>

Built in a vibe session by <operator name>. Scope: <draft: frontend only, with
sample data where the API does not exist yet | full: frontend and backend>.

## Scope and acceptance criteria

- Scope: <what is in, what is deliberately out>
- Acceptance criteria:
  - [ ] <one checkable line each, quoted from the person or the originating
    ticket>

## Environment

<From ticket-sections: branch and base, seeded or blank data, the Vercel app,
API, and Storybook URLs, and the last deployed commit.>

## Progress

- <date>: <one line per change or redeploy, newest last>

## API requirements

<Draft scope only. One subsection per stub, written when the stub is made:>

### <n>. <what the screen needs>

- Stub: `<path>` (`<export>`), used by `<hook>` in `<components>`
- Kind: read | write
- Suggested endpoint: `<METHOD /path>` (closest existing route: `<path>`)
- Request and response: <fields with types>
- Rules: <the person's rules, verbatim>

<Or "None: every screen uses existing API endpoints.">

## Backend built

<Full scope only. One line per endpoint, service, type, model, or migration
built, with its path and decision table.>

## Backend still missing

<Full scope only. What the screens need that is not built yet, or "None.">

## Production flag snapshot

<From ticket-sections: when it was taken, for which PostHog user, and every
flag with its value.>

## Sessions

<From ticket-sections: the Codex session ids of the orchestrator and every
subagent that worked on this.>

## Handoff

<Filled at handoff.>
- Components added: <path> with story <path>, one line each, or "none"
- Components changed: <path>: <what changed>, or "none"
- Storybook footprint: <components added and changed with story counts, net
  sidebar rows, governance problems left>
- Checks: <lint, source gates, typecheck, tests (full scope: every lane), each
  pass or fail>
- Reviews: <n fixed, n rejected; one line each, rejected with why>
- Tests whose old-UI assertions were updated on purpose: <list or "none">
- Pre-existing failures not touched by this work: <list or "none">
- Next: Nenad Antic reviews the components in the Storybook above and comments
  here when he signs off, then reassigns this ticket to Daniel Ochoa, who
  finishes it through analysis, a pull request, and merge.

## Engineering checklist

- [ ] Implement each endpoint under API requirements in `apps/api` (thin
      route, service, Zod validation, org scoping) with shared types in
      `packages/api/src/types/` (draft scope)
- [ ] Replace each `*.vibe-stub.ts` fixture with the real API call in its
      hook, then delete the stub file (draft scope)
- [ ] Review the backend listed under Backend built and finish anything under
      Backend still missing (full scope)
- [ ] Add or extend route, service, hook, and component tests for the real
      data path
- [ ] Decide whether a net-new surface needs a default-off PostHog flag before
      merge (closed-by-default UI policy)
- [ ] Verify shared `packages/app` changes on both web and Desktop
- [ ] Open the pull request to `main`; independent code review
```
