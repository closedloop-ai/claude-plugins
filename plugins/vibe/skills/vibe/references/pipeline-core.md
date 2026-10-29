# Class pipeline core

The rules every class pipeline shares, each written once, here. A class
pipeline skill (`vibe-pipeline-trivial-ui`, `-ui-feature`, `-backend`,
`-docs-config`) cites them by id and restates none of them. The manifest and its
classes are in `references/triage.md`.

## PC-1 Policy steps

Every step the manifest records as `required (policy)` runs as the vibe skill
describes it: the live ticket, your copy of the app and its flag snapshot,
Desktop, the session decision table, the plan publish, redeploys and every
handoff step. A step runs differently only when its `effective` value in the
manifest says so, and `effective` leaves `run` only for `environment` (`defer`)
and `desktop` (`skip`), automatically, when the evidence shows the step is not
needed (`references/triage.md`, "Applying the manifest").

## PC-2 Quality gates

Acceptance criteria before ready and the session decision table
(`references/quality-loop.md`), the handoff review of the final diff, and the
lane check (`scripts/pre-pr-lanes.mjs check`) apply to every class. A class
changes who reads the diff, never whether it is read.

## PC-3 Lanes and end-to-end specs

Lanes and end-to-end specs come from `pnpm test:lanes` and the target
repository's e2e path filter, never from the class.

## PC-4 Words the person sees

Every word the person sees follows `references/plain-words.md`. A class adds no
user-visible text.

## PC-5 Unknown class

A manifest with class `unknown`, or no manifest, uses the vibe skill's flow with
no class pipeline skill.
