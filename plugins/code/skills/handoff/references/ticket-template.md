# Handoff ticket body

Fill every section from the session; leave none as a placeholder. Write for an
engineer who has never seen the session.

```markdown
## What this is

<Two or three sentences in the requester's words: what someone can now do and
why it matters. Name the originating ticket if the session started from one.>

Vibe-coded by Andrew Eye. Frontend only; backend work is listed below. This
ticket stays IN_PROGRESS while engineering takes it over: reassign it to
yourself and branch off `andy/<slug>`.

## Where to look

- Branch: `andy/<slug>` (base: origin/main at <short base commit>)
- Preview: <stable preview URL> (stage API; stubbed screens show fixtures)
- Screens: <route or FEATURE_MAP id> - <one line each>

## What changed

- Components added: <path> - <one line each>, with story <path>
- Components changed: <path> - <what changed>
- Labs flags: <key, or "none">

## Storybook footprint

From `pnpm vibe storybook-diff` against the session's base on main:
- Components added: <title> (<n> stories) - one line each, or "none"
- Components changed: <title> (+<n> / -<n> stories)
- Net sidebar rows: <+n>
- Governance problems remaining: <list, or "none">

## Backend work needed

<One line per stub: method and suggested endpoint, what it returns or does,
and the consumer hook. "None" when there are no stubs.> Full detail is in the
attached api-requirements.md.

## Engineering checklist

- [ ] Implement each endpoint in api-requirements.md in `apps/api` (thin
      route, service, Zod validation, org scoping) and its shared types in
      `packages/api/src/types/`
- [ ] Replace each `*.vibe-stub.ts` fixture with the real API call in its hook,
      then delete the stub file and move its types to the shared location
- [ ] Add API route and service tests; extend hook and component tests to the
      real data path
- [ ] Decide whether a net-new surface needs a default-off PostHog flag before
      merge (closed-by-default UI policy)
- [ ] Verify shared `packages/app` changes on both web and Desktop
- [ ] Independent code review

## Checks run at handoff

- Lint, source gates, typecheck (affected), tests (affected): <result>
- Adversarial review: <n> findings fixed, <n> rejected
  - Fixed: <one line each>
  - Rejected: <one line each with the reason>
- Tests whose old-UI assertions were updated on purpose: <list or "none">
- Pre-existing failures not touched by this work: <list or "none">
```
