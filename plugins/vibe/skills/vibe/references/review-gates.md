# Review gates

Defects that shipped in vibe pull requests (symphony-alpha #8947 to #8967),
recorded here once so the writer avoids them and the handoff reviewers check
for them. The mechanical half is a script, so a repeat fails handoff instead
of depending on a reviewer noticing it again; the judgment half is a short
rule each owning agent applies.

## The script

`node ../../handoff/scripts/diff-rules.mjs --worktree "<wt>" --base <inventory baseCommit>`
(from `skills/vibe/references/`; handoff runs it as `scripts/diff-rules.mjs`)
reads the session diff, uncommitted and untracked files included, and the
session change log (`$(git -C <wt> rev-parse --absolute-git-dir)/vibe-changes.md`).
It prints one JSON object and exits 1 when `blocking` is not empty:

- `blocking`: findings that stop handoff until the SAME writer fixes the code
  or records the change log line the finding names. A recorded line is
  evidence the guardrails reviewer reads, never a waiver it accepts unread.
- `requiredTests`: existing tests and e2e specs that must run on this diff
  whatever `code_tests_for` returns, each with its reason. They are added to
  the targeted set the verify worker runs; none is skipped because the graph
  does not map it.
- `requiredChecks`: repo commands that must run on this diff.

The writer runs it before `DONE` in the build loop and fixes or records each
blocking finding; handoff step 3 runs it again and refuses to continue while
`blocking` is not empty.

| Rule | Blocks when | Fix, or the change log line that records why not |
|---|---|---|
| `migration-order` | A new `packages/database/prisma/migrations/<timestamp>_<name>` is not newer than the newest migration on the base | Rename the folder to a timestamp after the base's newest |
| `migration-precedent` | A new migration indexes, alters or updates a table that already exists | Copy the lock strategy of the last three migrations touching that table (`CREATE INDEX CONCURRENTLY` where they used it; the repo's `index-lock-ok(<table>)` marker only with its reviewed reason) and record `Migration precedent: <table>: <the three migration folders>` |
| `migration-backfill` | A new migration runs an `UPDATE` with no `WHERE` (a full-table backfill) | Move the backfill out of the schema migration or bound it, as the table's precedent does; record `Migration precedent: <table>: ...` naming the precedent that did the same |
| `activity-capture` | Added code writes a captured artifact field (`status`, `priority`, `assigneeId`, `approverId`, `projectId`, `title`, `dueDate`) through a raw `artifact.update`/`updateMany`/`upsert` or `UPDATE "artifacts"` in a file that calls no `capture*` helper | Call the canonical capture in `apps/api/lib/artifact-activity-capture.ts` (for example `captureBatchProjectChange`) on the same transaction, after reading how the field's existing write path captures it; or record `Activity capture: <path>: <the existing capture call that covers this write>` |
| `tx-result-after-write` | Inside a `withDb.tx` callback, a `return Result.err(...)` or `return err(...)` follows a write, so the refusal commits a partial change | Validate before the first write, or throw so the transaction rolls back; the missing tests list gets a no-rows-changed case per refusal |
| `desktop-sync-lane` | The diff adds a Desktop sync lane (a new file under `apps/desktop/src/main/` named for an outbox, lane or sync, or a new outbox or sync table in `apps/desktop/prisma/migrations`) without the shared give-up import (`shared/lane-give-up.ts` or `telemetry/sync-lane-give-up-telemetry.ts`), with a hand-rolled exponent instead of `shared/exponential-backoff.ts`, or without a recorded `synchronizing-susan` pass | Import the shared modules (`apps/desktop/src/main/sync/AGENTS.md`, invariants 3 to 5); record `Synchronizing-susan: <verdict and findings>` from the repo's `synchronizing-susan` agent; a new outbox table also records `Engineering needed (forbidden path): apps/desktop/src/main/sync/AGENTS.md; why: the lane roster names the new lane` |
| `artifact-link-delete` | An added `artifactLink.deleteMany` or `DELETE FROM "artifact_links"` does not constrain `sourceId`, `targetId` and `linkType` | Delete only the exact edge the write replaces; the missing tests list gets an external parent and a second parent that must survive |
| `ticketed-comment` | A removed comment carries an `ISS-`, `PRD-`, `PLN-` or `FEA-` slug or a URL, and no added line carries the same comment | Carry it with the code it explains (a move or extraction keeps its comments); or record `Comment removed: <path>: <slug or URL>: <what the change made false>` |
| `shared-path` | A modified service or library file in `apps/api` or a `packages/app` data source that two or more other files import | Record `Shared path: <path>: unchanged for existing callers; evidence: <test or missing test entry with legacy fixtures>` or `Shared path: <path>: changed; ruling: <human source>` |
| `story-outcome` | A changed story file's `expect` lines changed and the Storybook version did not | A story whose asserted outcome flipped is renamed, and a rename is a release (`apps/storybook/TAXONOMY.md`: bump plus one Version History entry); or record `Story outcome unchanged: <path>: <why the assertion still states the same outcome>` |
| `story-entry` | A new story file renders a component that already has a current (not v1.0) entry on the base, or a new entry is titled or named for a harness, adapter or preview | Put the states on the consumed component's current entry; or record `Story entry: <path>: <sibling replacement it is, or the Placement block that placed it>` |

`requiredTests`:

- A changed `apps/api/app/**/route.ts`: every `e2e/` spec that names its
  endpoint, because specs pin request bodies exactly and an untagged spec does
  not run on the pull request.
- A change to `packages/design-system/lib/grid-table-v2-types.ts`, any file
  named for `grid-table-v2`, or a line naming `GridTableV2`:
  `apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts` and
  every `apps/app/__tests__/*-host-capability-parity.test.ts`. These read
  other files' source, so `code_tests_for` does not map them.

`requiredChecks`: a new or changed migration runs
`pnpm check:destructive-migrations` and `pnpm check:migration-immutability`
(the repo's own index-lock and immutability gates).

## Judgment rules

Each rule names its owner. Findings go to the SAME writer like any other.

Backend writes and reads (`vibe-backend-worker`, `vibe-adversarial-reviewer`):

1. A new mutation route has one test that feeds the client request builder's
   real output into the real route or service; until it exists it is on the
   missing tests list. A precondition the client builds from lane-local or
   loaded rows while the server compares the whole scope is a finding.
2. The version or precondition a mutation sends comes from the read the user
   acted on; a GET of the precondition inside the `mutationFn` is a finding.
3. Ids from a request matched against ids Postgres returns are normalized
   (UUID case) at the parse boundary, with a mixed-case case on the missing
   tests list.
4. A cross-source identity or dedupe key equals a database uniqueness
   constraint (`@@unique`), or the change log says why not.
5. Changing a port's identity field (a `scope` value) means `rg` every
   comparison of that field and its constant; a composite port routes by the
   id argument, never by shared mutable state ("last opened detail").
6. Data read after a query is data on the query result, never a `WeakMap`
   keyed by object identity, which structural sharing replaces.
7. A per-row read (`get-document` and the like) never reads a whole project
   or tree scope (`apps/api/AGENTS.md`, Query Shape); a `do`/`while` over a
   cursor has a bound and matches the pagination criterion.
8. Replacing a write path lists every case the old path delivered (an
   offline-created session, a local-only branch) and shows the new one
   delivers each.
9. A failure classification maps each status or code to item or lane-wide
   with one row per case, through the lane's profile in
   `apps/desktop/src/shared/sync-failure-classification.ts`, never a local
   set (`apps/desktop/src/main/sync/AGENTS.md`, invariant 4).
10. A function whose failure changes from throw to `Result` has every caller
    checked; an `await` whose `ok` is never read is a finding.
11. A new optional request field gets a version-skew case at each boundary
    (an unknown value still commits the write); a bare enum that rejects it
    is a finding.
12. A new post-commit dispatch (`waitUntil` and the like) inside a service
    lists every caller, scripts and the vibe seed included, and states what
    happens outside a request.
13. A new sort over rows another module already orders imports that
    comparator; changing an order means `rg` of the old comment's noun.
14. A UI permission gate for a new route reads the same scope constant the
    route's `requiredScopes` uses.
15. A change to a persisted snapshot or receipt shape diffs the feed
    reader's render for every catalog row; a blanked line is a capability
    loss to escalate. A new persisted field key needs its catalog row and
    cited copy, or it is not written.

Frontend wiring (`vibe-adversarial-reviewer`, `vibe-guardrails-reviewer`):

16. A settlement or rollback contract is checked with the consumer
    subscribed to the real query cache (its `onMutate` echo), not rows passed
    as props; the missing tests list gets that case.
17. `focus()` reachable from a promise callback checks that focus still
    belongs to the control first.
18. For each host opted into a retained-failure or settle contract, trace
    the handler's return type to the mutation promise; a `void` handler
    makes the feature unreachable there.
19. A design-system contract styled by attribute is grepped against every
    consumer for conflicting utility classes (`opacity-0` and the like) and
    cascade layers; the rule goes where it wins.
20. Before migrating a control, trace the render path from the target route
    to each instance and list sibling duplicates (the prototype's copy
    included).
21. Plumbing-only changes leave render props unchanged; a changed cell
    rendering under a "no UI change" claim is a finding.
22. A change to a selection or gate predicate cites a human source and is
    compared with the sibling hosts and with open pull requests touching the
    same lines.
23. Every control a deleted or replaced card or row rendered (per-row More
    actions, favorite) maps to a home in the new layout or to an operator
    ruling; a dropped control is a capability trade to escalate.

Tests through real paths (`vibe-verify-worker`, `vibe-guardrails-reviewer`):

24. At least one test per acceptance criterion runs through the real hook
    and `QueryClient` across two fetches; view tests that mock the page-data
    hook prove nothing about the cache or refetch path.
25. Touch and narrow specs load the consumed surface (the product host or
    the prototype route), never a Storybook fixture alone; a real touch run
    never dispatches synthetic pointer events for the gesture under test, and
    compact assertions are re-derived from what the narrow row renders.
26. Deleting a test file whose subject was replaced, not removed, ports each
    case the successor still enforces or cites the ruling that retires it,
    case by case.
27. A receipt or integration expectation is a literal or the spec's words,
    never a call to the production builder, in a repair as in a new test.

Storybook (`vibe-storybook-decomposer`, `vibe-guardrails-reviewer`):

28. Placement returns the consumed component's existing current entry; an
    adapter, harness or preview never gets an entry of its own, and a v1.0
    file takes only a compile-only repair.
29. A lifecycle tag follows rollout: `stable` means "matches the live app"
    (`apps/storybook/TAXONOMY.md`), and a surface reachable only behind a
    default-off flag is not live, so its entry is not `stable`; it takes the
    tag and root TAXONOMY gives work still under review.
30. Every story state names the production code that emits it; a state no
    server or client path produces is removed.
