# The live ticket

Every vibe session has one ClosedLoop issue ticket, created when the session
starts (assigned to the person running the session, the session record's
`operator`, status In Progress) and kept current by the
workers while the person works. Engineering and design read it to know what
was built, what is missing, and where to look. Handoff checks it is complete;
it never writes it from scratch.

## Rules for every worker that edits it

Owned prototype sessions retain these headings and ownership rules. Their
record sections truthfully name the canonical immutable prototype preview,
slug, full deployed SHA and verification timestamp, with `None.` for the
production flag snapshot. No app/API/Storybook URLs or seeded/blank data are
fabricated. Backend built is `None.`; Backend still missing lists evidenced
promotion work or `None.`. Handoff includes the canonical decision log and
single design-review result alongside shared-surface stories, check/review
summaries, and the person's resolved next owner. The prototype worker owns
these updates; the same ticket worker verifies completeness and assignment.

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
  heading.

| Section | Written by | When |
|---|---|---|
| What this is | `vibe-ticket-worker` | session start |
| Scope and acceptance criteria | `vibe-ticket-worker`, then `vibe-change-worker` | session start; whenever the person changes what they want |
| Environment | `ticket-sections` (via `vibe-environment-worker`) | environment start, every redeploy |
| Progress | `vibe-change-worker`, `vibe-backend-worker`, `vibe-primitive-worker`, `vibe-environment-worker` | after each change and each redeploy |
| Backend built, Backend still missing | `vibe-backend-worker`, `vibe-change-worker` | as backend work is built or found missing |
| Production flag snapshot | `ticket-sections` (via `vibe-environment-worker`) | environment start, a refresh the person asked for |
| Sessions | `ticket-sections` (via `vibe-environment-worker`, `vibe-ticket-worker`) | every redeploy, handoff |
| Handoff | `vibe-ticket-worker` | handoff |
| Grading | `vibe-ticket-worker` | handoff, copied unchanged from this template |
| Engineering checklist | `vibe-ticket-worker` | session start |

## Body

````markdown
## What this is

<Two or three sentences in the person's words: what someone will be able to
do and why it matters. Name the originating ticket if the session started from
one.>

Built in a vibe session by <operator name>.

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

## Backend built

<One line per endpoint, service, type, model, or migration built, with its
path and decision table, or "None: every screen uses existing API endpoints.">

## Backend still missing

<What the screens need that is not built yet, or "None.">

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
- Design decisions: <one line per non-trivial request: the owner it was
  built in and the rule that chose it; for each restructure at handoff, the
  owner, its shape, and the alternative rejected and why>, or "none: only
  copy, color, or spacing changed"
- Storybook footprint: <components added and changed with story counts, net
  sidebar rows, governance problems left>
- Checks: <lint, source gates, typecheck, tests (every lane when the session
  changed backend code), each pass or fail>
- Reviews: <n fixed, n rejected; one line each, rejected with why>
- Failing tests that assert what the person deliberately changed, left for
  engineering to update (vibe never edits tests): <list or "none">
- Pre-existing failures not touched by this work: <list or "none">
- Next: <the next owner the person chose at handoff, by full name> picks
  this up. Usually design reviews the components in the Storybook above (it
  opens after signing in to Vercel with a team account) and comments here on
  sign-off, then engineering finishes it through analysis, a pull request,
  and merge.

## Grading

Whoever picks this up grades it at pickup, before changing anything: design
when it is assigned to them, engineering when design passes it on, before
opening the PR. Set your field, `Design grade` or `Eng grade` (High / Medium /
Low), in the issue's Custom Fields section below the body (it starts
collapsed), then post one comment using the template below. When the PR
merges, engineering adds what had to be fixed before merge.

High = took it as is or with small tweaks. Medium = real fixes, but we kept
the structure. Low = had to redo a meaningful part.

```
Grade: High / Medium / Low

Yes / no, plus one line when it's a no:
1. Followed our codebase rules. AGENTS.md and the nearest owning AGENTS.md, no lint or gate suppressions added to get green.
2. Reused existing components. No hand-rolled copy of something we already ship, and no duplicated helpers or types.
3. Storybook is right. Every new or changed component has stories in the right place, and the controls are usable. (Design)
4. Extended the existing pattern. For example, behavior the children of a shared parent share built once in that parent so each gets it, not one copy per child.
5. Backend is wired correctly. Route, service, shared types, Zod and migration follow our layering, and nothing is left on a stub. (Eng)
6. No invented copy. Every user-visible string came from a person or an existing label.
7. What we had to fix before merge. A count and a short list. (Eng, filled in at merge)
```

## Engineering checklist

- [ ] Review the backend listed under Backend built and finish anything under
      Backend still missing
- [ ] Add or extend route, service, hook, and component tests for the real
      data path
- [ ] Decide whether a net-new surface needs a default-off PostHog flag before
      merge (closed-by-default UI policy)
- [ ] Verify shared `packages/app` changes on both web and Desktop
- [ ] Open the pull request to `main`; independent code review
````
