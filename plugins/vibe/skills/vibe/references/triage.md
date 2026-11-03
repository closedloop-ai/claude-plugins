# Triage manifest

`scripts/vibe-triage.mjs` classifies the request into one class and prints the
step manifest the orchestrator follows. It is deterministic: the same request
text and touched paths give the same manifest. The shared rules every class
follows are in `references/pipeline-core.md`, not here.

## When it runs

Once, in "Starting new" after the requirements brief exists:

`node scripts/vibe-triage.mjs classify --request "<the request>" [--ticket-file <file>] [--paths <likely files from the brief>] --out <file>`

Keep the file beside the session record. `node scripts/vibe-triage.mjs check --manifest <file>`
validates a manifest. A resumed session whose manifest file is missing runs
today's flow. The class is set once; it is not re-classified when the writer
touches other files (mid-run upgrade rules are not part of this release).

## Classes

| Class | Chosen when | Pipeline skill |
|---|---|---|
| `trivial-ui` | one non-test UI file and no backend file, or a copy-only request | `vibe-pipeline-trivial-ui` |
| `ui-feature` | more than one UI file, UI with backend files, or a request that names UI work | `vibe-pipeline-ui-feature` |
| `backend` | backend files only, or a request that names backend work and no UI | `vibe-pipeline-backend` |
| `docs-config` | docs, scripts or config files only | `vibe-pipeline-docs-config` |
| `data-metric` | a metric or cost surface, or a request about a number the product shows | `vibe-pipeline-ui-feature`, plus the extra gate |
| `mockup` | every touched file is under `apps/prototypes`, or the request asks for a mockup | the existing "Mockup sessions" flow |
| `unknown` | the evidence does not decide one area | none: the vibe skill's flow |

Touched paths decide once they are known; request and ticket text decide before
that. Evidence that does not decide stays `unknown`; it is never guessed.

## Manifest

`schemaVersion`, `class`, `reason[]`, `evidence{paths, keywords, sources,
desktopRelevant}`, `applyRecommendations`, `steps`, `skipped[]`. The schema is
`validateManifest` in the script.

Each step in `steps` is `required (policy)` with an `effective` value. Only
`environment` and `desktop` carry a `recommendation` (`action` is `run`,
`defer`, `skip` or `unknown`, with a `reason` and `evidence`):

- `environment`: `defer` means create it on first need (the person asks to see
  the app, UI evidence is requested, or the writer asks) instead of at session
  start. It is never skipped.
- `desktop`: `skip` means leave Desktop out; the evidence names no Desktop-relevant
  surface (`apps/desktop`, `packages/app`, or a request that names Desktop).
- A `defer` or `skip` is only recommended when touched paths are known. A class
  that rests on request text alone recommends nothing to leave out.

Every `defer` or `skip` recommendation is logged in `skipped[]` with its step,
action, reason, evidence and whether it was applied. `check` fails when a
recommendation is missing from the log or has no reason or evidence.

`review.scope` names who reads the final diff and `extraGates` lists what a
class adds (`workflow-code-review` for `backend`, `logical-qa` for
`data-metric`). `e2e.source` is always `pnpm test:lanes and the e2e path filter`.

## The switch

`VIBE_TRIAGE_APPLY_RECOMMENDATIONS` is off by default. `classify` is its only
reader and records the result as `applyRecommendations`. While it is off, every
step's `effective` is `run`: the orchestrator does exactly what the vibe skill
describes, whatever the class and whatever the recommendations say.

The orchestrator never reads the variable; it reads `effective`:

- `environment` `effective: defer`: do not stand up the environment in "Starting
  new" step 7. Run section 3 (create mode) at the first need above, and always
  before anything that needs a deployed copy.
- `desktop` `effective: skip`: leave out the Desktop bullet of section 3. If the
  person asks to open Desktop, run it then.

Turning the switch on relaxes "Start Desktop for every session" and the
expectation that an environment exists from the start. Both await the owner's
ruling (ISS-13333, ISS-13334), so the switch stays off in shipped use.
