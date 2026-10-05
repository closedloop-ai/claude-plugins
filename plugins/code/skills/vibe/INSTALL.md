# Installing vibe on a new Mac

For setting up a vibe user's laptop (for example Andy's). About ten minutes of
hands-on time; the `vibe` skill installs everything else on its first run.

## Before you start

- The vibe user needs:
  - Codex Desktop (inside the ChatGPT app) installed and signed in.
  - A GitHub account in the `closedloop-ai` org with push access to
    `symphony-alpha` (handoff pushes an `andy/<slug>` branch).
  - A ClosedLoop account.
- Both pull requests must be merged to `main`:
  - claude-plugins, for the skills.
  - symphony-alpha ISS-12017, for `just vibe-up` and the seed. Every vibe
    session starts from fresh `main`.

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
- **Computer Use**: lets setup start Docker and click through installer and
  sign-in dialogs.

Quit the ChatGPT app completely and reopen it, so it loads the new plugin and
connector.

## 3. First run

Start a new Codex thread and type `$vibe`. On the first run it:

- installs whatever is missing (Homebrew, Docker Desktop, Node, pnpm, `gh`,
  `just`, `jq`)
- signs `gh` in to GitHub through the browser
- clones symphony-alpha to `~/Source/symphony-alpha` and bootstraps it

The vibe user only has to type their Mac password when an installer asks for
it. After that, `$vibe` asks what they want to work on and opens the app in
the in-app browser.

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
| `$handoff` | Send the finished work to engineering: a ticket assigned to them, a branch, and a preview link |
