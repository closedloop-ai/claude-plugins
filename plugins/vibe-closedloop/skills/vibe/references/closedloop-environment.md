Steps in this file written for symphony-alpha apply only in a repository that commits `.closedloop-ai/vibe-recipes.json`.

Before FIRST publication, register/resume the SAME implementation writer under
section 5's actual identity/hold/lease rules, not a new bootstrap source actor.
ROOT commits the checked deliverable LOCALLY under normal hooks, still unpushed,
before `commit-worktree.mjs --prepare-main-sync`; if no deliverable changed,
no extra commit is needed. Protected dirty localFix source remains preserved/blocking.
Apply `references/environment.md`, "Main-sync before publication" (one
`main-sync-inputs` pass, after the merge commit); no stale interim raw push.

Dispatch `vibe-environment-worker`
in create mode with the worktree, the live ticket slug, the mode, and
`references/environment.md` and matching transaction/context. It preserves
flag snapshot rules, pushes the explicit validated SHA through the gate,
starts the environment through GitHub, follows it to the end, records
the URLs on the session, and fills the ticket's Environment, Production flag
snapshot, and Sessions sections.

A resumed session whose `vercel.verifiedAt` is set already has its
environment; skip this and use its recorded `appUrl`, opening
`<appUrl>/sign-in` first as below. A resumed session
without it (one started before environments were verified) goes through
create mode again; the worker keeps its flag snapshot. If the worker returns `NEEDS_PERSON` asking which of
the person's organizations should hold the example company, ask the person exactly its question, record the org
id the worker mapped to their answer with
`node scripts/vibe-sessions.mjs touch --worktree "<wt>" --clerk-org-id <org_...>`,
and dispatch it again. If it returns `NEEDS_PERSON` saying they are not an
admin of any of their organizations, pass that on as written and wait for
their answer. If it returns `BLOCKED`, tell the person in one or two
plain lines what failed and which supported recovery or handover you are
taking (`references/guardrails.md`, "Plugins and tooling"). Never open or
give the person a URL after `BLOCKED`: any
preview address without its own deployment shows the stage production app.

When it returns `DONE`:
- Open `<appUrl>/sign-in` (the `appUrl` it returned, verified against the
  branch's own deployment) in a Codex in-app Browser tab and make the browser
  visible, since the root sends a signed-out visitor to account creation.
  Later, use the plain `appUrl`, or `<appUrl>/sign-in` if a tab lands on
  account creation. The person signs in through Clerk as themselves (you
  never type credentials). Seeded: they land in the example company as an admin. Blank: they create
  their own org.
- Confirm the tab shows the app (with seeded data when seeded), not an error
  page or an empty shell, before saying it is ready.
- Start Desktop for every session, per the Desktop section of
  `references/environment.md`, unless the manifest's `desktop` step has
  `effective: skip` (`references/triage.md`, "The switch"; off by default), and
  open it as a second tab:
  1. Run `node scripts/vibe-sessions.mjs desktop-tab --worktree "<wt>"`. If it
     reports `running`, skip to step 3.
  2. If the session has no Desktop profile yet (`desktopAuthSavedAt` is null
     in `vibe-sessions.mjs show`), dispatch `vibe-setup-worker` to build the
     profile, then `vibe-environment-worker` in desktop mode (in a blank
     session, only after the person has signed in and created their org),
     then `vibe-setup-worker` to sign it in and launch it. If it has one,
     dispatch `vibe-setup-worker` to launch it. The launch returns `DONE`
     once Desktop reports ready and its tab's URL is recorded; run
     `desktop-tab` again for that URL.
  3. Open its `url` exactly as given (never shortened, never shown to the
     person) in a second Codex in-app Browser tab, and confirm it shows the
     Desktop app's navigation, not `Connecting to Closedloop Desktop…`, an
     error, or a refused connection. `running` with no `url` means the
     worktree predates the tab: Desktop is its own window, with no tab to open.
  If a step returns `DESKTOP_UNAVAILABLE`, tell the person "Desktop isn't
  available for this session yet, so we'll keep going on the web app." and
  continue web-only.

If setup diagnoses a repo bug that stops local startup, route its ticket and
evidence to the SAME persistent writer for the managed local workaround in
`quality-loop.md`. Keep the diagnosis and ticket internal. The sole writer
records every changed file as a local fix; no redeploy or handoff commits it.
Setup only retries the launch after that verified correction, never patches code.

### Bringing a tab back

When the person asks to reopen the app or Desktop, open a new tab for it:
- The web app: the plain `appUrl` (`<appUrl>/sign-in` if it lands on account
  creation).
- Desktop: run `node scripts/vibe-sessions.mjs desktop-tab --worktree "<wt>"`.
  If it reports `running`, open its `url` exactly as given. Otherwise Desktop
  quit, was stopped, or never started: start it as in step 2 above, then open
  the new `url`. `DESKTOP_UNAVAILABLE` and `running` with no `url` are
  handled as in step 3 above. Never open a Desktop URL from an earlier launch
  or a tab's address bar; each launch has its own.
