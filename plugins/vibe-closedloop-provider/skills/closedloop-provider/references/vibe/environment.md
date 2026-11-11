# Provider text for skills/vibe/references/environment.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: intro -->
Each vibe session runs on its own Vercel environment: the web
app, the API, and Storybook deployed from the session's `vibe/<slug>` branch
as production builds, backed by the session's own throwaway data in the stage
database (its own preview schema, which nothing removes automatically: it
stays until the session is thrown away). Nothing
of the web app runs on this Mac. `just vibe-up` stays in the repository for
the team's local checks; the vibe skill never uses it.
<!-- end: intro -->

<!-- block: seeded-and-starting -->
## Seeded or blank

Asked once when the session starts, recorded as the session's `mode`. When
the person asks to switch it, record the new mode with `vibe-sessions.mjs
touch --worktree "<wt>" --mode <seeded|blank>` and request the environment
again; the request carries the recorded mode.

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
<!-- end: seeded-and-starting -->

<!-- block: storybook-links -->
Every Storybook link given to the person or written on the live ticket opens
the full Storybook UI, with its sidebar and controls: the Storybook base
alone, or `<storybook-base>/?path=/story/<story-id>` for one story. The base
is the verified Vercel `storybookUrl` or the local `storybookUrl` in the
session's stack. Never give the bare canvas,
`<storybook-base>/iframe.html?id=<story-id>&viewMode=story`, which shows the
story without the sidebar or controls. This section is the rule's one
canonical statement; the skills, the ticket template and the workers point at
it. `scripts/vibe-sessions.mjs link --story <story-id>` builds the link from
the session record, and a link given to the person also follows
`plain-words.md`, "Links to what the person should look at".
<!-- end: storybook-links -->

<!-- block: flags-and-redeploy -->
## The production flag snapshot

Taken once, when the environment is created: every feature flag's
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

After each change the build loop finishes, without the person asking, and
whenever the person still says "redeploy" (or "redeploy to Vercel", "push it
up", "put it on Vercel", "let me see it live"); changes that arrive while a
deploy runs go out together in the next one (`SKILL.md`, section 6). The
orchestrator makes one commit of everything changed since the last redeploy, never a local fix, with
`scripts/commit-worktree.mjs` (the repository's commit hook runs there; no
worker ever commits). Then the worker pushes, requests the environment again
with the same mode, reads the deployed commit from that run, and tells the
orchestrator when the app and Storybook show it. A failed pre-push check may be
fixed and amended while that commit is still local. After push, each redeploy
is immutable; every required correction is a new commit, never an amend or
force push.
<!-- end: flags-and-redeploy -->

<!-- block: what-runs -->
- **Storybook, between redeploys**: optional, for looking at components before
  the next redeploy. It needs no database. `vibe-setup-worker` starts it
  detached on a free port and records it with `touch --stack`.
- **Desktop, for every session**: the real Desktop app on a seeded local
  profile, signed in to the session's Vercel API as the person, shown to the
  person as a second in-app Browser tab through its browser bridge (the
  Desktop window opens too). Its database is a local file, so Docker is not
  needed. See "Desktop" below.
<!-- end: what-runs -->

<!-- block: reference-link -->
- **A reference link.** A prototype preview, a Storybook story, an existing
  page in our product or a public page of another product: a throwaway
  headless Playwright script kept outside the worktree and deleted
  afterwards (the acceptance check's quick-script rule), which opens the URL
  and saves a screenshot, or the control skill's `screenshot` for a screen
  in our product under its own rules (hidden, never `--allow-write`, `eval`
  or `eval-main`, `pnpm control down` for every session it started). Never
  sign in to another product or type a credential. Save the image with
  `reference-images.mjs save --file`, then read it like any other reference.
<!-- end: reference-link -->

<!-- block: before-deploy -->
- **Before the deploy.** A component with a story: the story in local
  Storybook (the `storybookUrl` on the session's stack; `vibe-setup-worker`
  starts it when none runs), which shows the worktree's code as it changes,
  captured from the story's canvas URL with the throwaway script above (a
  capture may use the canvas; a link given to the person still follows
  "Storybook links"). A screen Desktop shows: the control skill under its own
  rules (`pnpm -C apps/desktop build`, then `pnpm control up desktop --mode
  e2e`, `goto <id>`, `wait --settled`, `screenshot --locator <L>`, and
  `pnpm control down` for every session it started), never `--headed`,
  `--allow-write`, `eval` or `eval-main`. A page rendered outside both (a
  generated static page, say) is opened by the throwaway script. The local
  web app does not run on this Mac, so a web-only screen with no story is
  compared after the deploy instead.
<!-- end: before-deploy -->

<!-- block: desktop -->
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
   worktree whose `vibe:profile launch` predates the browser tab logs the
   window but no URL: the launch is
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
gate merges fresh main when it merges (step 1) and obeys this owned-Desktop stop rule; it never
stops an unrelated Desktop or changes a running renderer's tree.
<!-- end: desktop -->

<!-- block: desktop-lane -->
The Desktop Electron lane is the exception (ISS-13321): no vibe machine runs
it, and since symphony-alpha's desktop-e2e job skips pull requests no run
exists for a branch before merge. The executor returns it under
`e2eLeftForCi`, covered by the post-merge desktop-e2e-validation run that
publishes `desktop-e2e/validated`, and it does not hold
`requiredE2eComplete`. The ticket's Engineering checklist carries it
(`ticket-template.md`, "E2E left for CI"). An operator-dispatched run bound
through `mainSyncCiRun` still verifies as above and replaces that entry.
<!-- end: desktop-lane -->

<!-- block: build-failures -->
- A request or environment run fails: the worker reads the failed step's log
  and reports it in one or two lines.
- A Vercel build fails: the worker reads the deployment's build log; a failure
  in the session's own change resumes the SAME persistent writer, then redeploy.
<!-- end: build-failures -->
