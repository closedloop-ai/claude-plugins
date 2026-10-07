# The vibe environment

Each vibe session runs on its own Vercel environment (ISS-12056): the web
app, the API, and Storybook deployed from the session's `andy/<slug>` branch
as production builds, backed by the session's own throwaway data in the stage
database (its own preview schema, removed when the branch is gone). Nothing
of the web app runs on this Mac. `just vibe-up` stays in symphony-alpha for
the team's local checks; the vibe skill never uses it.

## Seeded or blank

Asked once when the session starts, recorded as the session's `mode`.

- **Seeded**: the vibe seed fills the environment with realistic data under an
  org named Acme Co, with its owner and teammates. The stage API finds the
  person's Clerk user from their email and binds Acme Co to their stage org,
  with them as an admin (the run reports `personOrgAdmin`). If they belong to
  more than one stage org, the run fails saying so; the person picks the org
  by name, `touch --clerk-org-id` records it, and the environment is
  requested again. The person signs in through Clerk as themselves and lands
  in Acme Co.
- **Blank**: no data. The person signs in through Clerk as themselves and
  creates their own org.

## Starting it (`vibe-environment-worker`, create mode)

1. Take the production flag snapshot (below) and save it with
   `vibe-sessions.mjs flag-snapshot`.
2. Push the branch (`git push -u origin andy/<slug>`).
3. Write the request inputs with `vibe-sessions.mjs dispatch-inputs` and
   start the request workflow it names from main:
   `gh workflow run vibe-environment-dispatch.yml --ref main --json < <file>`.
   Inputs: `branch`, `mode`, `flag_snapshot`, `request_id` (a fresh id per
   request), and for seeded `person_email` (from ClosedLoop `get-me`) plus
   `clerk_org_id` only when the person belongs to more than one stage org;
   `desktop_auth` once the session has a local Desktop profile, always with
   `person_email` so the Desktop session belongs to the person (a blank
   session sends `person_email` only then, and never `clerk_org_id`). Never start
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
5. Record the reported URLs and commit (`touch --vercel ... --deployed <sha>`) and put
   them on the live ticket.

The URLs are the stable per-branch Vercel aliases, recorded on the session
when it is created:

| Field | What it is |
|---|---|
| `appUrl` | The web app (`app-stage-git-andy-<slug>`). Open it in the in-app Browser. |
| `apiUrl` | The API behind it (`api-stage-git-andy-<slug>`); the app finds it by hostname. |
| `storybookUrl` | Storybook (`prototypes-git-andy-<slug>`, under `/storybook`), where design reviews the components. |

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

## Redeploying (`vibe-environment-worker`, redeploy mode)

Only when the person asks ("redeploy", "redeploy to Vercel", "push it up",
"put it on Vercel", "let me see it live"). One commit of everything changed
since the last redeploy, never a local fix, then a push and the environment
requested again with the same mode; the worker reads the deployed commit from
that run and tells the orchestrator when the app and Storybook show it. Each redeploy is its own commit; nothing is squashed or
amended later.

## What runs on this Mac

- **Storybook, between redeploys**: optional, for looking at components before
  the next redeploy. It needs no database. `vibe-setup-worker` starts it
  detached on a free port and records it with `touch --stack`.
- **Desktop, only for sessions that touch Desktop**: the real Desktop app on a
  seeded local profile, signed in to the session's Vercel API as the person.
  Its database is a local file, so Docker is not needed. Web-only sessions
  never start it. See "Desktop" below.

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
5. Start the app:
   `pnpm --filter desktop vibe:profile launch --profile "<profile>" --api-origin <api> --web-origin <app>`.

If any of these fails and the setup worker cannot fix it, tell the person
plainly: "Desktop isn't available for this session yet, so we'll keep going
on the web app." Then continue web-only.

## When it fails

- A request or environment run fails: the worker reads the failed step's log
  and reports it in one or two lines.
- A Vercel build fails: the worker reads the deployment's build log; a failure
  in the session's own change goes back to a change worker, then redeploy.
- The push is refused by the repo's pre-push checks: the failing check goes to
  a change worker in fix mode, then redeploy. Never skip the checks.
- A problem with this Mac (a missing or signed-out tool): fix it per
  `preflight.md`.
- A bug in symphony-alpha itself that stops local Storybook or Desktop
  starting: the setup worker files a ClosedLoop ticket for Daniel Ochoa,
  fixes it locally in the session worktree only, and records the files with
  `vibe-sessions.mjs local-fix`, so no redeploy or handoff commits them.
- Anything else: tell the person the environment did not start, show the error
  in one or two lines, and suggest they message Daniel Ochoa with the session
  slug.
