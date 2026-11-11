# Provider text for skills/vibe/INSTALL.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: before -->
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
  - symphony-alpha's per-session Vercel environment and its request
    workflow, and its production flag snapshot. Every
    vibe session starts from fresh `main`.
<!-- end: before -->

<!-- block: install -->
## 1. Install the plugins and connect ClosedLoop

In Terminal on the vibe user's Mac:

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
"$CODEX" plugin marketplace add closedloop-ai/claude-plugins
"$CODEX" plugin add vibe@closedloop-ai
"$CODEX" plugin add closedloop-core@closedloop-ai
"$CODEX" plugin add vibe-core@closedloop-ai
"$CODEX" mcp add closedloop --url https://mcp.closedloop.ai/mcp
```
<!-- end: install -->

<!-- block: connections -->
The last command opens the browser. Have the vibe user sign in to ClosedLoop
with their own account. Codex stores an OAuth sign-in, not an API key.

closedloop-graph (ticket and code intelligence) is required: every vibe and
handoff worker that locates, changes, or reviews code calls it for each
change. `"$CODEX" mcp list` must show a `closedloop-graph` row with Status
`enabled`; if there is none, get its connection from engineering before the
first run. If a connection ever stops answering, the vibe skill has its setup
worker restore it (`references/preflight.md`, "Restoring a connection").
<!-- end: connections -->

<!-- block: check -->
```bash
"$CODEX" plugin list | grep vibe@closedloop-ai   # installed, enabled
"$CODEX" plugin list | grep closedloop-core@closedloop-ai   # installed, enabled
"$CODEX" plugin list | grep vibe-core@closedloop-ai   # installed, enabled
"$CODEX" mcp list                                # closedloop (OAuth) and closedloop-graph
```
<!-- end: check -->

<!-- block: first-run -->
- finds an existing symphony-alpha checkout anywhere in the home folder (by
  its GitHub remote, so the folder can have any name, including spaces) and
  remembers it in `~/.codex/vibe/config.json`; only when there is none does it
  clone one into the person's usual source folder. It then bootstraps it
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
<!-- end: first-run -->

<!-- block: daily -->
| "redeploy" (in a vibe session) | Put the latest changes on their Vercel copy of the app |
| `$handoff` | Check and finish the work's ticket and hand it to whoever they name to pick it up next (usually design, then engineering) |
<!-- end: daily -->
