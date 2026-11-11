# The vibe environment

Lines that start `> Provider` follow `references/provider-text.md`.

<!-- generic: intro -->
The app runs on this Mac: `vibe-setup-worker` starts it from the session
worktree with the command the repository documents for local development,
and the person looks at it in the in-app browser (Codex) or at its local
link (Claude Code). A provider with recipes for the repository can run it on
a hosted environment instead.
<!-- end generic: intro -->
> Provider `recipes` (block `intro` of `vibe/environment.md`)

<!-- generic: seeded-and-starting -->
## Running the app locally

`vibe-setup-worker` reads the repository's `AGENTS.md`, then its README, for
the command that runs the app for local development (for example its `dev`
script), starts it detached in the session worktree on a free port when the
command takes one, logs to `<private git dir>/vibe-app.log`, and waits until
its URL answers. It records `appUrl` and `appPid` on the session's stack
(`vibe-sessions.mjs touch --stack`), and `vibe-sessions.mjs stop` stops it.
When the app needs services the repository starts separately (a database,
say), the same documented steps start them, each recorded on the stack; a
step that needs a secret this machine lacks is reported in one plain line,
never worked around. With no documented way to run it, nothing starts, and
changes are shown through the writer's checks and screenshots.
<!-- end generic: seeded-and-starting -->
> Provider `recipes` (block `seeded-and-starting` of `vibe/environment.md`)

## Storybook links

<!-- generic: storybook-links -->
Every Storybook link given to the person opens
<!-- end generic: storybook-links -->
> Provider `recipes` (block `storybook-links` of `vibe/environment.md`)
the full Storybook UI, with its sidebar and controls: the Storybook base
alone, or `<storybook-base>/?path=/story/<story-id>` for one story. The base
<!-- generic: storybook-links-2 -->
is the local `storybookUrl` in the session's stack. Never give the bare canvas,
`<storybook-base>/iframe.html?id=<story-id>&viewMode=story`, which shows the
story without the sidebar or controls. This section is the rule's one
canonical statement; the skills and the workers point at
<!-- end generic: storybook-links-2 -->
> Provider `recipes` (block `storybook-links-2` of `vibe/environment.md`)
it. `scripts/vibe-sessions.mjs link --story <story-id>` builds the link from
the session record, and a link given to the person also follows
`plain-words.md`, "Links to what the person should look at".

> Provider `recipes` (block `flags-and-redeploy` of `vibe/environment.md`)

## What runs on this Mac

<!-- generic: what-runs -->
- **The app**: as "Running the app locally" says.
- **Storybook**: optional, for looking at components; `vibe-setup-worker`
  starts it detached on a free port and records it with `touch --stack`.
<!-- end generic: what-runs -->
> Provider `recipes` (block `what-runs` of `vibe/environment.md`)

## Capturing a reference

How a reference reaches the writer as an image (`quality-loop.md`, "Visual
references").

- **Looking at an image.** Both harnesses can: `Read` on the path in Claude
  Code, `view_image` on the path in Codex. A reference the person attached is
  already a saved file (`scripts/reference-images.mjs`).
- **A reference link.** A prototype preview, a Storybook story, an existing
  page in our product or a public page of another product: a throwaway
  headless Playwright script kept outside the worktree and deleted
  afterwards (the acceptance check's quick-script rule), which opens the URL
<!-- generic: reference-link -->
  and saves a screenshot. Never sign in to another product or type a
  credential. Save the image with `reference-images.mjs save --file`, then
  read it like any other reference.
<!-- end generic: reference-link -->
> Provider `recipes` (block `reference-link` of `vibe/environment.md`)

## Capturing for the reference check

Only when the session has a reference image (`quality-loop.md`, "The
reference check before ready"); with none, nothing here runs. One screenshot
of each touched screen or component in each theme it supports, hidden, from
the session worktree, leaving no tracked file behind.

<!-- generic: before-deploy -->
- **Before showing it.** A component with a story: the story in local
  Storybook (the `storybookUrl` on the session's stack; `vibe-setup-worker`
  starts it when none runs), captured from the story's canvas URL with the
  throwaway script above (a capture may use the canvas; a link given to the
  person still follows "Storybook links"). A screen of the running app: the
  throwaway script on its local `appUrl`. A page rendered outside both (a
  generated static page, say) is opened by the throwaway script.
<!-- end generic: before-deploy -->
> Provider `recipes` (block `before-deploy` of `vibe/environment.md`)
- **Same viewport.** The control skill's browser is 1440 by 900. When the
  reference has another width, take the screenshot with the throwaway script
  at the reference image's width.
- **Light and dark.** The final state is captured in both themes wherever the
  surface supports both: it renders inside the
  app or Desktop shell, or its stylesheet has a `.dark` or
  `prefers-color-scheme: dark` block. A story: its canvas URL once with
  `&globals=theme:light` and once with `&globals=theme:dark` (the Storybook
  theme toolbar). A static or generated page: the throwaway script once with
  Playwright's `colorScheme: "light"` and once with `colorScheme: "dark"`,
  adding the `dark` class on `<html>` when the page keys on it. A Desktop
  screen control cannot switch: the story of the touched component in both
  themes. Only a surface with a single theme gets one capture, and its Checks
  line says so.
- **After the deploy.** In Claude Code, the orchestrator's own browser tab is
  signed in as the person: the Chrome extension's screenshot when it is
  connected. In Codex there is no computer use (`guardrails.md`, "Processes
  and state"): the orchestrator writes the visual-check request that section
  describes and hands it to a Claude worker, never a screenshot of the
  in-app Browser tab. A session without either has no preview screenshot, so
  the writer's local screenshot is the only comparison, and a touched screen
  it could not capture keeps its visual criteria `not met yet` with that
  reason.

> Provider `recipes` (block `desktop` of `vibe/environment.md`)

## Main-sync before publication

Before EVERY first push, later redeploy, independent flags/Desktop deployment
request, owned prototype share and final handoff, begin a fresh coherent transaction.
Git push itself can trigger Vercel, so a stale interim push is forbidden even
when no request workflow has started. The root keeps this sequence internal:

ROOT commits the checked deliverable LOCALLY through the existing commit
script and normal hooks, still unpushed, BEFORE preparation. Private plans stay
excluded; interfering protected localFix source is preserved and blocks parity,
not silently included or discarded. A clean result needs no extra local commit.

1. Stop only the session's owned Desktop through its existing operational
   owner before changing its source. The publishing helper's exact existing
   create/redeploy or prototype-share record turn runs
   `node <plugin-root>/skills/vibe/scripts/commit-worktree.mjs --prepare-main-sync --worktree "<wt>"`
   with `{ "context": <granted operationContext> }` on stdin. It fetches
   `origin main`, captures the private FETCH_HEAD SHA once, and stages an
   ordinary noncommitting merge only in final-merge mode
   (`vibe-sessions.mjs touch --main-merge final`, set once QA passes or when
   the person asks for a main merge now). Otherwise main waits
   (`mainMerge: "deferred"`), conflicts included, and the branch's own base
   stands in as its main; a failing check is fixed on that base. It never commits or pushes. Retain the
   returned `transactionId`, `mainSha`, original base and imported-file facts.
   If the launcher cannot mint a supported publisher grant, ROOT does not
   invent one: fetch `origin main`, stage `git merge --no-commit --no-ff
   origin/main`, keep conflicts with the same writer, then finish through
   `commit-worktree.mjs`. This fallback prepares only the merge; publication
   still waits for a real grant.
2. End that helper turn using actual stopped/completed evidence before any
   source continuation. The SAME registered writer extends its existing
   session table/local canonical plan before source fixes and checks frozen
   earlier behavior/interactions against the merged result. All conflicts,
   generated source and fixes stay with that writer. A merge that conflicts
   only on the Storybook version file and Version History (main ships a
   Storybook release several times a day) is settled with
   `node <plugin-root>/skills/vibe/scripts/storybook-version-merge.mjs --worktree "<wt>"`:
   main's version bumped by the session's own level, both entries kept, the
   session's on top; the writer then updates its entry's counts to the
   merged tree. Any other conflict, or its refusal, the writer
   resolves as before. No new tests are written
   unless the person asked for a pull request, and the writer only repairs
   existing tests the merge broke (`guardrails.md`, "Tests").
3. Only the root commits the staged merge/fixes through the existing commit
   script and normal hooks. This ordinary main-sync merge is the one extra
   commit allowed after the reviewed feature commit; it brings in main and is
   not iteration. Then resume that SAME writer for its exact
   source-owned record continuation (`progress`) with the captured
   `mainSyncTransactionId` and root-controlled `publicationPurpose`.
   Run `node <plugin-root>/skills/vibe/scripts/vibe-sessions.mjs main-sync-inputs --worktree "<wt>"`
   once, after this exact committed merge/fix result; no readiness pass
   precedes capture. It proves generated inputs in one pristine checkout;
   unknown or edited outputs and localFix code block, and
   retained reports are never PASS. A failing producer names its command,
   exit or timeout and private log: fix that cause rather than rerunning
   into the same bound.
   It preserves captured imports/original test history and returns
   `validationWitness`, whose `recipeSha256` binds the actual fixed recipe and
   budgets to transaction, committed HEAD/tree and input identity. Finish that
   record turn; ROOT grants the same actor's next validation continuation with
   this opaque value as `mainSyncValidation`, never a manufactured PASS.
   It runs `node <plugin-root>/skills/vibe/scripts/vibe-sessions.mjs main-sync-validate --worktree "<wt>"`
   with the granted context on stdin. The shared executor runs the existing
   scope/phase command matrix and records actual results at committed HEAD.
   Its affected test selection is pinned to the captured `mainSha`, so only the session's own HEAD or tree changing, or a
   rewritten `origin/main`, invalidates it, never `origin/main` advancing.
   At handoff a failing check is run again on the captured `mainSha` in one
   disposable bootstrapped checkout, bounded by `run-bounded.mjs`; one that
   also fails there is `main-preexisting` and does not block publication
   (`quality-loop.md`, "Failures already on main"). Its recipe binds that comparison's reserve, so the Claude
   envelope covers it.
   A check that changes source returns to this writer/root commit/recheck
   sequence; a known generated-output change gets one bounded whole-matrix
   restart, and unknown outputs or continued churn yield no receipt. FULL
   local lint-scripts has a fixed 30-minute budget; the general worker keeps
   its 15-minute default and 30-minute maximum, and only the Root-owned
   witness derives a finite Claude envelope. Missing, tampered, stale or
   canceled proof blocks, never an enlarged caller timeout.
4. Validation checks every tracked/index byte/mode and scoped executable
   overlay against committed input before/between/after checks and again at
   consumption. Managed `localFixes` remain commit exclusions, NEVER check
   exclusions: preserve interfering code/records, report their tickets, and
   BLOCK through the existing same-writer workaround/exclusion/restore flow.
   Never stash, discard, copy a validation checkout, invent PASS or validate
   corrected local bytes while deploying different committed source. Private
   non-source plans/evidence/logs may remain. Preserve exact actor/lease and
   current registration metadata; a missing or upgraded definition follows
   quality-loop's recorded migration.
5. A fresh publishing turn receives the same `mainSyncTransactionId` and
   purpose in its parent-issued grant. Claude injects `operationContext` in
   the turn envelope; native Codex's parent composes it from its actual
   role/action/worker/request/record lease, runtime `codex`, exact worktree,
   and granted purpose/transaction. Never derive authority from raw task
   text, borrow another role's lease, print a lease or clear a lock because a
   short CLI PID ended. Input is `{ "context": <operationContext> }` on
   stdin, optionally with the matching `transactionId`; no caller command
   list or `passed: true` is accepted. Copy the envelope's `operationContext`
   verbatim, never a context rebuilt field by field: any field that differs
   from the launcher's record is refused, and the refusal names each one.
   A publication attempt/no-op consumes proof for this exact publisher
   runtime/worker/request/lease. Same-turn retries retain it; a later
   publishing turn must prepare fresh, not recycle an old transaction.
   If the current operation includes flags/Desktop continuation, ROOT
   predeclares at most two `mainSyncRequestContinuations` in the actual
   publisher grant: exact runtime, unique parent-assigned requestId and
   recordAction (`flags` or `desktop`). Do not infer intent from task text or
   add it in caller stdin after the grant. The first consumer binds actual
   worker/lease; replay or another helper turn is not the same continuation.
6. Create/redeploy uses `vibe-sessions.mjs main-sync-push`, which pushes the
   explicit validated SHA through normal hooks, then `dispatch-inputs` with
   that context. It refuses while a migration the branch adds sorts before
   main's newest one in the same folder (`scripts/migration-order.mjs`): the
   SAME writer renames it to a later timestamp, contents unchanged. Prototype share uses `main-sync-share` admission plus the
   same exact-SHA push gate, then only canonical readiness/immutable URL
   inspection. No helper or source writer commits. Failures stop publication;
   the root resumes the same writer, not a replacement author.
7. Flags/Desktop have separate request-only grants, but their workflows can
   newly deploy even without a push. An independent request must first route
   through canonical fresh preparation/redeploy under the publisher's own
   grant. Only a predeclared current-operation continuation may consume a
   matching current validated/pushed transaction for its requested action,
   but cannot prepare/merge/push or borrow create/redeploy/share ownership.
   Missing/stale/unreserved state returns canonical redeploy first; after that
   genuinely completed turn, resume the reserved request under its own grant. Keep its
   explicit snapshot/auth effects, same mode, seeded data and existing
   keep-snapshot behavior. Do not turn a request-only negative into a new
   publisher capability.

Capture one main SHA per coherent transaction; a later main advance starts a
new transaction next time, not an endless refresh loop or an unvalidated head.
The final handoff repeats this sequence with handoff purpose/whole-table
evidence. If the fresh merge creates no new result and the exact checked SHA
already has verified current publication, `main-sync-push` returns
`alreadyPublished: true`, `pushed: false`: issue NO synthetic environment
request/redeploy merely because handoff. Explicit flags/Desktop requests are
not that no-op. Never merge the feature branch into production main here.

Existing lane selection uses the owning reporter's structured exports through
Node/tsx, never a blind run of every lane or a guessed JSON switch. Browser
automation stays headless; Electron requires the actual documented Linux
dbus/keyring/Xvfb harness and prerequisites, not bare Playwright or PWDEBUG.
BUILD preview may carry named incomplete unsupported E2E evidence while its
existing preparation checks execute; this is not E2E PASS or final alignment.
HANDOFF separates safe publication preparation from completed required coverage:
publish its exact final snapshot for CI/live QA with limitations retained, never
substitute build PASS or call that completed coverage. No automatic Vibe-branch Electron path is established;
route any existing CI permission internally to ROOT, never dispatch it without
explicit authorization, open a feature PR or invent a new harness/env knob.
After the exact final snapshot is published, ROOT may bind
`mainSyncCiRun: {runId, attempt}` to the SAME source writer's actual handoff
progress grant and resume `main-sync-validate` for that same transaction.
The read-only consumer verifies canonical loaded-main workflow identity,
actual successful required job/steps, trusted checkout action SHA and pre-test
runner env SHA against unchanged owned HEAD/tree/input. It never dispatches,
accepts caller PASS, trusts run.head_sha as tested source, stores raw secret
logs or treats later spoofed stdout as proof. Missing evidence leaves
`requiredE2eComplete: false`; final handoff remains incomplete. Do not re-fetch
main repeatedly while CI waits. CI is per push; `qa-impact.mjs` decides local QA.
> Provider `recipes` (block `desktop-lane` of `vibe/environment.md`)

### What the validation proof accepts

The shared main-sync executor (`scripts/dist/main-sync.mjs`) enforces these;
none of them is a step a worker takes by hand.

- Imported main changes stay distinct from feature scope, while original
  feature test history remains available for phase verification even after
  main absorbs identical bytes.
- The existing ignored root `.biome-noscan.jsonc` is recognized only when its
  bytes match the reviewed canonical pure producer applied to the complete
  committed config. Modified, stale or deceptive derivatives and unrelated
  executable overlays still block; the gate never invokes the writing hook.
- Ignored files under a `.codex/`, `.claude/`, `.agents/`, `.vscode/` or
  `.idea/` folder are the person's own agent and editor config, never a
  validation input, and never block main sync. The same files untracked but
  not ignored still block as uncommitted executables.
- Source-owned input readiness preserves canonical unconsumed private
  diagnostics and retained reports without accepting their contents as
  coverage. Known generated dependencies need complete pure or pristine owner
  verification before execution; unknown extras, edited bodies, producer drift
  and aliases remain blocked.
- Selected package proofs use bounded deduplicated names and full
  byte/mode/set digests in the existing private receipt.
- Report admission follows actual selected entries, tasks, configs and
  producer inputs. Selected module coverage follows the finite committed tree;
  the existing 4,096 ceiling bounds distinct cwd/argv contexts rather than
  source file count. Data imports use the same path predicate as the shared
  code/config parser; retained-report references and global private planning
  protection remain enforced.
- An unrelated capable reader is not selected consumption. Ordinary bootstrap
  health cannot mint validation proof. Meaningful retained report data,
  default verdicts and replay still block, while proven same-call test
  fixtures remain nonretained inputs and never stand in for required coverage.
- Workflow main SHA, generic log matches and caller PASS are not coverage
  proof.

## When it fails

<!-- generic: build-failures -->
- The app fails to start: `vibe-setup-worker` reads its log and reports it
  in one or two lines; a failure in the session's own change resumes the SAME
  persistent writer.
<!-- end generic: build-failures -->
> Provider `recipes` (block `build-failures` of `vibe/environment.md`)
- The push is refused by the repo's pre-push checks: the failing check goes to
  the SAME persistent writer in fix mode, then redeploy. Never skip the checks.
- A problem with this Mac (a missing or signed-out tool): fix it per
  `preflight.md`.
- A bug in the repository itself that stops local Storybook or Desktop
  starting: setup diagnoses and files/reuses the existing ticket, without
  editing code. The SAME persistent writer makes the smallest managed local
  workaround in this session worktree, records every changed file with
  `vibe-sessions.mjs local-fix` under that ticket, and returns the fix evidence.
  Existing exclusion and restore rules still apply: no redeploy or handoff
  commits these files. Setup retries only after the writer supplies the fix;
  the permanent correction remains with the bug's ticket owner.
- Anything else: return the exact failure and paths tried to the orchestrator.
  Use the recovery or supported handover in `guardrails.md`, "Plugins and
  tooling"; do not turn an unclassified failure into an engineering task for
  the person.
