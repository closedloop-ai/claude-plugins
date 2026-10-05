# The vibe environment

`just vibe-up`, run from the session's worktree, brings up a throwaway copy of
the product for this session only and prints one line starting with
`VIBE_ENV ` followed by JSON:

| Field | Meaning |
|---|---|
| `webUrl` | The web app, already signed in as the local admin. Open in the in-app Browser. |
| `apiUrl` | The local API behind it. |
| `desktopUrl` | The Desktop renderer through the read-only browser bridge, signed in to the same local API. |
| `storybookUrl` | Storybook for this worktree, for approving new components. |
| `database` | The throwaway Postgres database name. |
| `desktopProfile` | The throwaway Desktop profile folder. |

Everything is seeded from scratch on each `vibe-up`: teams, projects,
documents, comments, loops, API keys, sessions, branches, pull requests,
insights, agents, and the rest, so every screen has realistic data. The same
agent sessions appear on web and Desktop.

`just vibe-down` stops everything and deletes the database and profile.
`just vibe-status` prints the current `VIBE_ENV` or reports that nothing is
running.

## The real Desktop window

The Desktop tab in the in-app browser cannot save or change data. To try a
Desktop write flow, run `just vibe-desktop-window` in the worktree; it opens
the real Electron app on the same throwaway profile and local API.

## When it fails

- Read the last 50 lines of the `vibe-up` output first.
- `pnpm control doctor` reports ports, Docker, build state, and leftover
  stacks; `pnpm control doctor --clean` removes crashed leftovers.
- Docker not running: apply `start-docker` from `preflight.md`.
- A fresh worktree that was never bootstrapped: run
  `./.closedloop-ai/loops-setup.sh`, then `vibe-up` again.
- Anything else: tell the person the local app did not start, show the error in
  one or two lines, and suggest they message Daniel Ochoa with the session
  slug. Do not improvise fixes to repo scripts.
