# The vibe environment

Each vibe session runs on its own Vercel environment (ISS-12056): the web
app, the API, and Storybook deployed from the session's `vibe/<slug>` branch
as production builds, backed by the session's own throwaway data in the stage
database (its own preview schema, which nothing removes automatically: it
stays until the session is thrown away, ISS-12135). Nothing
of the web app runs on this Mac. `just vibe-up` stays in symphony-alpha for
the team's local checks; the vibe skill never uses it.

## Seeded or blank

Asked once when the session starts, recorded as the session's `mode`.

- **Seeded**: the vibe seed fills the environment with realistic data under an
  org named `<email> Co` using the signed-in person's Clerk primary email,
  with its owner and teammates; sample-data names stay unchanged. The stage
  API finds the person's Clerk user from their email and binds the seeded org to their stage org,
  with them as an admin (the run reports `personOrgAdmin`). If they are an
  admin of more than one stage org, the API binds the org their Clerk session
  last had active; only when it cannot tell does the run fail, the person
  picks by name, `touch --clerk-org-id` records it, and the environment is
  requested again. The person signs in through Clerk as themselves and lands
  in `<email> Co`. Local `pnpm vibe up` keeps Acme Co.
- **Blank**: no data. The person signs in through Clerk as themselves and
  creates their own org.

## Starting it (`vibe-environment-worker`, create mode)

1. Take the production flag snapshot (below) and save it with
   `vibe-sessions.mjs flag-snapshot`.
2. Complete "Main-sync before publication" below, then push only its exact
   validated commit through `vibe-sessions.mjs main-sync-push`, with the
   granted operation context on stdin. Never use a direct branch push.
3. Write the request inputs with `vibe-sessions.mjs dispatch-inputs` and
   start the request workflow it names from main:
   `gh workflow run vibe-environment-dispatch.yml --ref main --json < <file>`.
   `dispatch-inputs` also consumes the same granted transaction context on
   stdin; it refuses missing/stale proof before writing a request.
   Inputs: `branch`, `mode`, `flag_snapshot`, `request_id` (a fresh id per
   request), and for seeded `person_email` (from ClosedLoop `get-me`) plus
   `clerk_org_id` only when the person picked one;
   `desktop_auth` once the session has a local Desktop profile, always with
   `person_email` so the Desktop session belongs to the person (a blank
   session sends `person_email` only then, and never `clerk_org_id`), and
   `keep_flag_snapshot` (`false` only for a flag refresh) when the workflow
   declares it. Never start
   `vibe-environment.yml` directly: it holds the cloud credential and runs
   after the request workflow on its own.
4. Follow both runs to the end. Both are titled
   `Vibe environment <branch> (<request_id>)`. The `vibe-environment.yml` run
   makes sure the branch head has ready app, API, and Storybook deployments
   (Vercel does not build a commit it already built, so a new branch still at
   main's commit gets none on its own) and reports their URLs and the deployed
   commit. Its success is the only sign the environment is ready: GitHub
   deployments carry the commit, not the branch, as their `ref`, and
   `*.preview.closedloop-stage.ai` answers for any branch, deployed or not.
5. Download the run's `vibe-environment-result` artifact and record it with
   `vibe-sessions.mjs environment-result --request-id <request_id>`, which
   checks it against the request, the session's branch and mode, and the
   worktree's HEAD before recording the URLs, deployment ids, and deployed
   commit. Nothing else records them. Then put them on the live ticket.

The URLs are the stable per-branch Vercel aliases. The session record holds
the predicted ones from when it is created, but they are shown or opened only
once `environment-result` has recorded a verified result:

| Field | What it is |
|---|---|
| `appUrl` | The web app (`app-stage-git-vibe-<slug>`). Open it in the in-app Browser. |
| `apiUrl` | The API behind it (`api-stage-git-vibe-<slug>`); the app finds it by hostname. |
| `storybookUrl` | Storybook (`prototypes-git-vibe-<slug>`, under `/storybook`), where design reviews the components. It sits behind Vercel's sign-in: a viewer not signed in to Vercel with a team account is sent to `vercel.com` (`sso-api`) instead. |

## The production flag snapshot

Taken once, when the environment is created (ISS-12048): every feature flag's
production value, evaluated in PostHog with the public project key (`phc_`)
as the person's real account (their Clerk user id, the PostHog distinct id)
and real ClosedLoop org. PostHog is one project for stage and production, so
no other credential is needed. The key is public (it ships in every browser
bundle); `scripts/posthog-key.mjs` reads it from the checkout's
`apps/app/.env.local`, or from the production app's page when a fresh checkout
has none, so no Vercel sign-in is needed. The environment uses these values instead of
evaluating flags live. Every redeploy keeps the same snapshot; it is taken
again only when the person asks, and applied by requesting the environment
again with the same mode (a ready environment is kept; a different mode would
rebuild it). Shape (validated by `flag-snapshot`):
`{ takenAt, distinctId, orgId?, flags }`, each flag `true`, `false`, or a
variant name.

## Redeploying (the orchestrator commits, then `vibe-environment-worker`, redeploy mode)

Only when the person asks ("redeploy", "redeploy to Vercel", "push it up",
"put it on Vercel", "let me see it live"). The orchestrator makes one commit
of everything changed since the last redeploy, never a local fix, with
`scripts/commit-worktree.mjs` (the repository's commit hook runs there; no
worker ever commits). Then the worker pushes, requests the environment again
with the same mode, reads the deployed commit from that run, and tells the
orchestrator when the app and Storybook show it. Each redeploy is its own
commit; nothing is squashed or amended later.

## What runs on this Mac

- **Storybook, between redeploys**: optional, for looking at components before
  the next redeploy. It needs no database. `vibe-setup-worker` starts it
  detached on a free port and records it with `touch --stack`.
- **Desktop, for every session**: the real Desktop app on a seeded local
  profile, signed in to the session's Vercel API as the person, shown to the
  person as a second in-app Browser tab through its browser bridge (the
  Desktop window opens too). Its database is a local file, so Docker is not
  needed. See "Desktop" below.

## Desktop

The one place these commands live; `vibe-setup-worker` runs them from the
worktree. The profile folder is `<gitdir>/vibe-desktop-profile`, where
`<gitdir>` is `git -C "<wt>" rev-parse --absolute-git-dir` (never inside the
repo). `<api>` and `<app>` are the session's `vercel.apiUrl` and
`vercel.appUrl`.

1. Build the seeded profile, once:
   `pnpm --filter desktop vibe:profile prepare --out "<profile>" --now <ISO now>`.
2. Make its auth claim and save it on the session:
   `pnpm --filter desktop vibe:profile auth-claim --profile "<profile>"` prints
   one JSON line `{refreshTokenHash, publicKeySpki, gatewayId}` (public values;
   no secret leaves the Mac). Write it to a file and run
   `vibe-sessions.mjs desktop-auth --worktree "<wt>" --file "<file>"`.
3. `vibe-environment-worker` in desktop mode requests the environment again so
   it signs that profile in for the person's own user (blank sessions: only
   after the person has signed in and created their org).
4. Sign the profile in to the session's environment:
   `pnpm --filter desktop vibe:profile sign-in --profile "<profile>" --api-origin <api> --web-origin <app>`.
   It works once per profile: signing in rotates the profile's refresh token,
   so it refuses a profile that is already signed in. A profile that needs
   signing in again (another environment, a lost session) is prepared fresh
   from step 1.
5. Start the app detached, logging owner-only to the session's private git
   directory:
   `(umask 077; nohup pnpm --filter desktop vibe:profile launch --profile "<profile>" --api-origin <api> --web-origin <app> > "<gitdir>/vibe-desktop.log" 2>&1 & echo $!)`.
   It refuses a profile that is not signed in. The command does not return
   while Desktop is open: it runs the dev launcher with the browser bridge,
   which builds what it needs and then runs Electron, and it exits only when
   the app quits (non-zero if Desktop failed). Desktop is up once the log
   shows `Desktop window visible`; if the command exits before that line, the
   end of the log says why. Just before that line the log prints
   `Desktop browser URL: http://127.0.0.1:<port>/design-system/browser.html?closedloopBridgeToken=<token>`.
6. Record the launch (the pid `echo $!` printed) and that URL on the
   session: `vibe-sessions.mjs desktop-launched --worktree "<wt>" --pid <pid> --log "<gitdir>/vibe-desktop.log"`.
   It reads the URL from the log and keeps anything else the stack lists. A
   worktree whose `vibe:profile launch` predates the browser tab
   (symphony-alpha before ISS-12182) logs the window but no URL: the launch is
   recorded with no URL and Desktop keeps running as its own window, as it
   did before the tab existed.

To stop Desktop, send SIGTERM to the `scripts/dev-launch.mjs` process under
the recorded `desktopPid` (`ps -o pid,ppid,command` shows the tree): it
passes the signal to Electron, and the launch command then exits. Electron
can take up to a minute to finish quitting.

If any of these fails and the setup worker cannot fix it, tell the person
plainly: "Desktop isn't available for this session yet, so we'll keep going
on the web app." Then continue web-only.

### The Desktop tab

The URL is the Desktop app's screens served from this Mac by the session
worktree's own renderer, talking to the Desktop window, which stays the only
place the person's credentials live. Open it exactly as recorded, never
truncated or with the token removed, in a new in-app Browser tab; a route
can be added after it (`#/sessions`). The tab removes the token from its
address bar once it loads, so a reopen always uses the recorded URL, never
one copied from a tab. Each launch has its own port and token: a URL from an
earlier launch does not open. The token lets whoever holds it read the
session's Desktop data while that launch runs, so it never goes in chat, on
the ticket, or in a commit. The tab reads and shows data; saving changes in
it is not supported (the bridge forwards reads only).

`vibe-sessions.mjs desktop-tab --worktree "<wt>"` returns `running` and the
`url` to open. It hands out the URL only while the recorded launch is still
running; `running: false` means Desktop was never started for the session,
quit, or was stopped, and is started again with step 5 then step 6 (the
profile stays signed in, so steps 1 to 4 are not repeated). `running: true`
with no `url` is a launch that predates the tab: Desktop is open as its own
window only.

### Never swap the worktree under a running Desktop

The Desktop renderer reloads live from the worktree's source. Merging main
into the worktree, pulling, rebasing, resetting, or checking out another
commit while Desktop runs reloads it against a different tree and crashes it
(React `insertBefore` NotFoundError, "Maximum update depth exceeded", screens
stuck loading; a restart fixes it). Before any such step, stop Desktop (above);
after it, start Desktop again with step 5 then step 6, which records a new
port and token, and open the new tab. Ordinary edits to files, which is all
the SAME writer performs, are fine while it runs. The main-sync publication
gate merges fresh main and obeys this owned-Desktop stop rule; it never
stops an unrelated Desktop or changes a running renderer's tree.

## Main-sync before publication

Before EVERY first push, later redeploy, independent flags/Desktop deployment
request, owned prototype share and final handoff, begin a fresh coherent transaction.
Git push itself can trigger Vercel, so a stale interim push is forbidden even
when no request workflow has started. The root keeps this sequence internal:

ROOT commits the reviewed deliverable LOCALLY through the existing commit
script and normal hooks, still unpushed, BEFORE preparation. Private plans stay
excluded; interfering protected localFix source is preserved and blocks parity,
not silently included or discarded. A clean result needs no extra local commit.

Before publisher preparation, resume the SAME registered source actor for
`node <plugin-root>/skills/vibe/scripts/vibe-sessions.mjs main-sync-inputs --worktree "<wt>"`
with its actual exclusive `progress` context on stdin. This source-owned
readiness operation verifies canonical private-plan exclusion, tracked/index
parity, the existing read-only Biome derivative and finite generated dependencies.
It uses existing pure owners or a pristine owned detached validation checkout
and normal canonical bootstrap, never another feature branch/source writer.
Unknown extra/edited/consumed outputs and protected localFix code remain blocked
and preserved. It never deletes retained reports or reads their bodies as PASS.
Inputs needed by a selected replay/verdict reader are not output-only evidence.
Finish that actual record turn before the publisher below; readiness is not a
main capture, test authority, validation PASS or permission to publish.

1. Stop only the session's owned Desktop through its existing operational
   owner before changing its source. The publishing helper's exact existing
   create/redeploy or prototype-share record turn runs
   `node <plugin-root>/skills/vibe/scripts/commit-worktree.mjs --prepare-main-sync --worktree "<wt>"`
   with `{ "context": <granted operationContext> }` on stdin. It fetches
   `origin main`, captures the private FETCH_HEAD SHA once, and stages an
   ordinary noncommitting merge. It never commits, pushes, resets, rebases,
   stashes, changes mode/data, or manually edits a conflict. Retain the
   returned `transactionId`, `mainSha`, original base and imported-file facts.
2. End that helper turn using actual stopped/completed evidence before any
   source continuation. The SAME registered writer extends its existing
   session table/local canonical plan before source fixes and checks frozen
   earlier behavior/interactions against the merged result. All conflicts,
   generated source and fixes stay with that writer; new tests remain
   handoff-only. Upstream imports are not newly authored feature tests, but
   no actual early/unrecorded test edit is retrospectively relabeled.
3. Only the root commits the staged merge/fixes through the existing commit
   script and normal hooks. Then resume that SAME writer for its exact
   source-owned record continuation (`progress`) with the captured
   `mainSyncTransactionId` and root-controlled `publicationPurpose`.
   Run `main-sync-inputs` again after this exact committed merge/fix result.
   It preserves captured imports/original test history and returns
   `validationWitness`, whose `recipeSha256` binds the actual fixed recipe and
   budgets to transaction, committed HEAD/tree and input identity. Finish that
   record turn; ROOT grants the same actor's next validation continuation with
   this opaque value as `mainSyncValidation`. Never manufacture commands,
   duration, PASS, retrospective authoring phase or a replacement registration.
   It runs `node <plugin-root>/skills/vibe/scripts/vibe-sessions.mjs main-sync-validate --worktree "<wt>"`
   with the granted context on stdin. The shared executor runs the existing
   scope/phase command matrix and records actual results at committed HEAD.
   A source-generating check that changes source returns to this writer/root
   commit/recheck sequence, never an operational publisher repair.
   Known selected generated-output changes require canonical re-verification
   and ONE bounded whole-matrix restart within the original command budgets;
   only authenticated changed owners regenerate, with untouched proof retained.
   unrelated writes, unknown outputs or continued churn yield no receipt.
   FULL local lint-scripts has a fixed 30-minute outer process budget; aggregate
   test budgets derive from actual selected owning allocations. These are not
   CI, assertion, individual-test or hook deadline changes. The general worker
   keeps its 15-minute default and 30-minute maximum. Only the actual Root-owned
   validation witness permits a derived finite Claude whole-turn envelope.
   Its canonical recipe also binds the finite selected recovery lifecycle reserve;
   this never doubles check budgets or grants per-owner restarts.
   Prelaunch reads bounded recipe data without child execution; after owned
   process handlers exist, actual inputs and recipe are recomputed. Missing,
   tampered, stale or canceled proof blocks, never an enlarged caller timeout.
4. Validation checks every tracked/index byte/mode and scoped executable
   overlay against committed input before/between/after checks and again at
   consumption. Managed `localFixes` remain commit exclusions, NEVER check
   exclusions: preserve interfering code/records, report their tickets, and
   BLOCK through the existing same-writer workaround/exclusion/restore flow.
   Never stash, discard, copy a validation checkout, invent PASS or validate
   corrected local bytes while deploying different committed source. Private
   non-source plans/evidence/logs may remain. Preserve exact actor/lease and
   opaque original registration metadata; current helper paths do not
   re-register or replace a native source actor whose old cache is absent.
5. A fresh publishing turn receives the same `mainSyncTransactionId` and
   purpose in its parent-issued grant. Claude injects `operationContext` in
   the turn envelope; native Codex's parent composes it from its actual
   role/action/worker/request/record lease, runtime `codex`, exact worktree,
   and granted purpose/transaction. Never derive authority from raw task
   text, borrow another role's lease, print a lease or clear a lock because a
   short CLI PID ended. Input is `{ "context": <operationContext> }` on
   stdin, optionally with the matching `transactionId`; no caller command
   list or `passed: true` is accepted.
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
   that context. Prototype share uses `main-sync-share` admission plus the
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
Node/tsx, never blind `test:lanes --exec` or a guessed JSON switch. Browser
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
main repeatedly while CI waits. Changed source/new preparation invalidates proof.

## When it fails

- A request or environment run fails: the worker reads the failed step's log
  and reports it in one or two lines.
- A Vercel build fails: the worker reads the deployment's build log; a failure
  in the session's own change resumes the SAME persistent writer, then redeploy.
- The push is refused by the repo's pre-push checks: the failing check goes to
  the SAME persistent writer in fix mode, then redeploy. Never skip the checks.
- A problem with this Mac (a missing or signed-out tool): fix it per
  `preflight.md`.
- A bug in symphony-alpha itself that stops local Storybook or Desktop
  starting: setup diagnoses and files/reuses the existing ticket, without
  editing code. The SAME persistent writer makes the smallest managed local
  workaround in this session worktree, records every changed file with
  `vibe-sessions.mjs local-fix` under that ticket, and returns the fix evidence.
  Existing exclusion and restore rules still apply: no redeploy or handoff
  commits these files. Setup retries only after the writer supplies the fix;
  the permanent correction remains with the bug's ticket owner.
- Anything else: tell the person the environment did not start, show the error
  in one or two lines, and suggest they message Daniel Ochoa with the session
  slug.
