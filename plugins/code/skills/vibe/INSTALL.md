# Installing vibe on a new Mac

For setting up a vibe user's laptop (for example Andy's). About ten minutes of
hands-on time; the `vibe` skill installs everything else on its first run.

## Before you start

- The vibe user needs:
  - Codex Desktop (inside the ChatGPT app) installed and signed in.
  - A GitHub account in the `closedloop-ai` org with push access to
    `symphony-alpha` (every session pushes a `vibe/<slug>` branch and starts
    its Vercel environment through a GitHub workflow).
  - A ClosedLoop account.
  - To have signed in at least once to the stage app,
    https://app.closedloop-stage.ai, with the same work account and to have
    an organization there. A seeded session binds its sample company to that
    account and organization; without them the environment stops and asks
    for the sign-in.
- These must be merged to `main`:
  - claude-plugins, for the skills.
  - symphony-alpha ISS-12056 (the per-session Vercel environment and its
    request workflow) and ISS-12048 (the production flag snapshot). Every
    vibe session starts from fresh `main`.

## 1. Install the plugin and connect ClosedLoop

In Terminal on the vibe user's Mac:

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
"$CODEX" plugin marketplace add closedloop-ai/claude-plugins
"$CODEX" plugin add code@closedloop-ai
"$CODEX" mcp add closedloop --url https://mcp.closedloop.ai/mcp
```

The last command opens the browser. Have the vibe user sign in to ClosedLoop
with their own account. Codex stores an OAuth sign-in, not an API key.

closedloop-graph (ticket and code intelligence) is optional. The workers use
it when it is connected and fall back to searching the repository when it is
not, so nothing needs to be set up for it.

Check:

```bash
"$CODEX" plugin list | grep code@closedloop-ai   # installed, enabled
"$CODEX" mcp list                                # closedloop (OAuth)
```

## 2. Turn on the Codex plugins vibe uses

In Codex Desktop, open Plugins and make sure these are added and enabled:

- **Browser**: the in-app browser the work happens in.
- **Computer Use**: lets setup click through installer and sign-in dialogs.

Quit the ChatGPT app completely and reopen it, so it loads the new plugin and
connector.

## 3. First run

Start a new Codex thread and type `$vibe`. On the first run it:

- finds an existing symphony-alpha checkout anywhere in the home folder (by
  its GitHub remote, so the folder can have any name, including spaces) and
  remembers it in `~/.codex/vibe/config.json`; only when there is none does it
  clone one to `~/Source/symphony-alpha`. It then bootstraps it
- installs whatever is missing (Homebrew, Node, pnpm, `gh`, and `jq`), and puts a Node that satisfies the repo's `engines` range first on
  PATH for every new shell. Docker is not needed: the app runs on Vercel.
- signs `gh` in to GitHub through the browser

The vibe user only has to type their Mac password when an installer asks for
it. After that, `$vibe` asks what they want to work on and whether to start
with sample data (seeded) or empty (blank), sets up that session's own
Vercel environment (web app, API, and Storybook; a few minutes), and opens
it in the in-app browser, where they sign in as themselves. Nothing of the
web app runs on the Mac. The Desktop app runs on the Mac for every session,
signed in to that environment, and opens as a second in-app browser tab.

If a step fails, run the preflight on its own to see which check is red:

```bash
bash ~/.codex/plugins/cache/closedloop-ai/code/*/skills/vibe/scripts/vibe-preflight.sh
```

## Updating

Check which version is installed and where the `closedloop-ai` marketplace
comes from:

```bash
"$CODEX" plugin list --marketplace closedloop-ai   # VERSION column of code@closedloop-ai
"$CODEX" plugin marketplace list                  # ROOT of closedloop-ai
```

How to update depends on how the marketplace was added.

**Git marketplace** (added with
`"$CODEX" plugin marketplace add closedloop-ai/claude-plugins`, as in step 1;
this is the vibe user's install). `marketplace upgrade` refreshes Codex's copy
of the Git repo.

```bash
"$CODEX" plugin marketplace upgrade closedloop-ai
"$CODEX" plugin list --marketplace closedloop-ai
```

If `code@closedloop-ai` still shows the old version, install it again from
the refreshed marketplace:

```bash
"$CODEX" plugin add code@closedloop-ai
```

**Local folder marketplace** (added with
`"$CODEX" plugin marketplace add <path to a claude-plugins checkout>`; ROOT is
that checkout). `marketplace upgrade` only refreshes Git marketplaces, so it
does not update this one. Pull the checkout, then install the plugin again:

```bash
git -C "<path to the claude-plugins checkout>" pull
"$CODEX" plugin add code@closedloop-ai
"$CODEX" plugin list --marketplace closedloop-ai
```

In both cases, quit the ChatGPT app completely (Cmd+Q, not just closing the
window) and reopen it, so it loads the new skills and workers. The new
version is the `version` in `plugins/code/.codex-plugin/plugin.json` on
claude-plugins `main`.

## Daily use

| Command | What it does |
|---|---|
| `$vibe` | Start something new, or pick up where they left off |
| "redeploy" (in a vibe session) | Put the latest changes on their Vercel copy of the app |
| `$handoff` | Check and finish the work's ticket and hand it to whoever they name to pick it up next (usually design, then engineering) |
