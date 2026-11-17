# Provider text for skills/vibe/references/triage.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: mockup-row -->
| `mockup` | every touched file is under `apps/prototypes`, or the request asks for a mockup | the existing "Mockup sessions" flow |
<!-- end: mockup-row -->

<!-- block: desktop-surface -->
  surface (`apps/desktop`, `packages/app`, or a request that names Desktop).
<!-- end: desktop-surface -->

<!-- block: extra-gates -->
class adds (`workflow-code-review` for `backend`, `logical-qa` for
`data-metric`). `e2e.source` is always `the repository's lane report and its e2e path filter`
(here `pnpm test:lanes` and the e2e path filter).
<!-- end: extra-gates -->

<!-- block: known-gates -->
- each `extraGates` entry the handoff knows (`workflow-code-review`,
  `logical-qa`) runs as an additional gate; an unknown name is ignored.
<!-- end: known-gates -->
