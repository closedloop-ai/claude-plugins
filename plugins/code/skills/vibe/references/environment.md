# The vibe environment

`pnpm vibe up --ci`, run from the session's worktree, brings up a throwaway
copy of the product for this session only. It starts the environment as a
detached background process, so it keeps running between Codex turns and
after the command that started it returns. The command itself returns once
everything answers and prints one line starting with `VIBE_ENV ` followed by
JSON. Never start it with the foreground `just vibe-up` or `pnpm vibe up`:
that process holds the environment and it dies when the turn ends.

The first start can take a long time (installs, builds, and seeding; up to 30
minutes). If the command returns early or the tool call times out, the
environment keeps starting in the background. Poll `just vibe-status` every
30 seconds: it prints `{"ok":true,"running":...,"env":...}`, and once
`running` is `true` its `env` object is the same JSON as the `VIBE_ENV` line.
Before starting, run `just vibe-status`; if it already reports `running:
true`, reuse that `env` instead of starting again.

| Field | Meaning |
|---|---|
| `webUrl` | The web app, already signed in as the local admin. Open in the in-app Browser. |
| `apiUrl` | The local API behind it. |
| `desktopUrl` | The Desktop renderer through the read-only browser bridge, signed in to the same local API. |
| `storybookUrl` | Storybook for this worktree, for approving new components. |
| `database` | The throwaway Postgres database name. |
| `desktopProfile` | The throwaway Desktop profile folder. |

Everything is seeded from scratch on each start: teams, projects,
documents, comments, loops, API keys, sessions, branches, pull requests,
insights, agents, and the rest, so every screen has realistic data. The same
agent sessions appear on web and Desktop.

`just vibe-down` stops everything and deletes the database and profile.
`just vibe-status` prints the current `VIBE_ENV` record or reports that
nothing is running.

## The real Desktop window

The Desktop tab in the in-app browser cannot save or change data. To try a
Desktop write flow, run `just vibe-desktop-window` in the worktree; it opens
the real Electron app on the same throwaway profile and local API.

## When it fails

- Read the last 50 lines of the `vibe up` output first, then the background
  log `.control/vibe/up.log` in the worktree.
- `pnpm control doctor` reports ports, Docker, build state, and leftover
  stacks; `pnpm control doctor --clean` removes crashed leftovers.
- Docker not running: apply `start-colima` (when Colima is installed) or
  `start-docker` from `preflight.md`.
- A fresh worktree that was never bootstrapped: run
  `./.closedloop-ai/loops-setup.sh`, then start the environment again.
- A problem with this Mac (a missing or stopped tool, a full disk, a busy
  port): fix it per `preflight.md` and start again.
- A bug in symphony-alpha itself (it would fail the same way on any correctly
  set up Mac): the setup worker files a ClosedLoop ticket for Daniel Ochoa,
  fixes it locally in the session worktree only, and records the files it
  changed with `vibe-sessions.mjs local-fix`, so handoff leaves them out. See
  `vibe-setup-worker`.
- Anything else: tell the person the local app did not start, show the error
  in one or two lines, and suggest they message Daniel Ochoa with the session
  slug.
