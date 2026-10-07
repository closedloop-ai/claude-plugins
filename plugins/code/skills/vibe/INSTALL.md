# Installing vibe on a new Mac

For setting up a vibe user's laptop (for example Andy's). About ten minutes of
hands-on time; the `vibe` skill installs everything else on its first run.

## Before you start

- The vibe user needs:
  - Codex Desktop (inside the ChatGPT app) installed and signed in.
  - A GitHub account in the `closedloop-ai` org with push access to
    `symphony-alpha` (every session pushes an `andy/<slug>` branch and starts
    its Vercel environment through a GitHub workflow).
  - A ClosedLoop account.
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

The vibe workers also use closedloop-graph (ticket and code intelligence). If
`"$CODEX" mcp list` does not show `closedloop-graph`, run the closedloop-graph
connect command from the graph operator on this Mac. It needs the vibe user's
Tailscale access.

Check:

```bash
"$CODEX" plugin list | grep code@closedloop-ai   # installed, enabled
"$CODEX" mcp list                                # closedloop (OAuth) and closedloop-graph
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
- installs whatever is missing (Homebrew, Node, pnpm, `gh`, `just`, and
  `jq`), and puts a Node that satisfies the repo's `engines` range first on
  PATH for every new shell. Docker is not needed: the app runs on Vercel.
- signs `gh` in to GitHub through the browser

The vibe user only has to type their Mac password when an installer asks for
it. After that, `$vibe` asks what they want to work on and whether to start
with sample data, sets up their own copy of the app on Vercel (a few
minutes), and opens it in the in-app browser, where they sign in as
themselves.

If a step fails, run the preflight on its own to see which check is red:

```bash
bash ~/.codex/plugins/cache/closedloop-ai/code/*/skills/vibe/scripts/vibe-preflight.sh
```

## Updating

```bash
"$CODEX" plugin marketplace upgrade closedloop-ai
"$CODEX" plugin add code@closedloop-ai
```

Then restart the ChatGPT app.

## Daily use

| Command | What it does |
|---|---|
| `$vibe` | Start something new, or pick up where they left off |
| "redeploy" (in a vibe session) | Put the latest changes on their Vercel copy of the app |
| `$handoff` | Check and finish the work's ticket and hand it to Nenad Antic for design review, then engineering |
