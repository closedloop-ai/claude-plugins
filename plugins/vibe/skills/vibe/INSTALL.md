# Installing vibe on a new Mac

Lines that start `> Provider` follow `references/provider-text.md`.

For setting up a vibe user's laptop. About ten minutes of
hands-on time; the `vibe` skill installs everything else on its first run.

## Before you start

- The vibe user needs:
  - Codex Desktop (inside the ChatGPT app) installed and signed in.
<!-- generic: before -->
  - A GitHub account with push access to the repository they will work in
    (every session pushes a `vibe/<slug>` branch).
- claude-plugins `main` carries the skills. Every vibe session starts from
  fresh `main` of the repository.
<!-- end generic: before -->
> Provider `tickets+recipes` (block `before` of `vibe/install.md`)

<!-- generic: install -->
## 1. Install the plugins
<!-- end generic: install -->
> Provider `tickets+graph` (block `install` of `vibe/install.md`)

In Terminal on the vibe user's Mac:

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
"$CODEX" plugin marketplace add closedloop-ai/claude-plugins
"$CODEX" plugin add vibe@closedloop-ai
"$CODEX" plugin add closedloop-core@closedloop-ai
"$CODEX" plugin add vibe-core@closedloop-ai
> Provider `tickets+graph` (block `install-2` of `vibe/install.md`)
```

vibe-core carries vibe's hooks. Codex runs a plugin's hooks only after you
approve them: open Codex once and approve vibe-core's hooks in /hooks. Each
vibe-core release can ask again; a vibe release does not. vibe's setup check
says when Codex reports that an approval is needed.

> Provider `tickets+graph` (block `connections` of `vibe/install.md`)

Check:

```bash
"$CODEX" plugin list | grep vibe@closedloop-ai   # installed, enabled
"$CODEX" plugin list | grep closedloop-core@closedloop-ai   # installed, enabled
"$CODEX" plugin list | grep vibe-core@closedloop-ai   # installed, enabled
<!-- generic: check -->
```
<!-- end generic: check -->
> Provider `tickets+graph` (block `check` of `vibe/install.md`)

## 2. Turn on the Codex plugins vibe uses

In Codex Desktop, click Plugins in the sidebar and make sure these are added and enabled:

- **Browser**: the in-app browser the work happens in. Vibe never uses
  Computer Use; a dialog that needs a click is yours.

Quit the ChatGPT app completely and reopen it, so it loads the new plugin and
connector.

## 3. First run

Click New chat in the sidebar and type `$vibe`. On the first run it:

<!-- generic: first-run -->
- uses the git checkout it runs in, or the one the person names, and
  remembers it in `~/.codex/vibe/config.json` (folder names can have any
  name, including spaces). It then bootstraps it the way the repository
  documents
- installs whatever is missing (Homebrew, Node, the repository's package
  manager, `gh`, and `jq`), and puts a Node that satisfies the repo's
  `engines` range first on PATH for every new shell.
<!-- end generic: first-run -->
> Provider `recipes` (block `first-run` of `vibe/install.md`)
- signs `gh` in to GitHub through the browser

The vibe user only has to type their Mac password when an installer asks for
<!-- generic: first-run-2 -->
it. After that, `$vibe` asks what they want to work on, starts the app the way
the repository documents, and opens it in the in-app browser.
<!-- end generic: first-run-2 -->
> Provider `recipes` (block `first-run-2` of `vibe/install.md`)

If a step fails, run the preflight on its own to see which check is red:

```bash
bash ~/.codex/plugins/cache/*/vibe/*/skills/vibe/scripts/vibe-preflight.sh
```

## Updating

`$vibe` checks this itself at the start of every session
(`scripts/plugin-version.mjs`): it compares every plugin from vibe's marketplace installed
in Codex, and in Claude Code when that is installed too, with claude-plugins
`main`. When one is older, it asks the vibe user whether to update now or keep
going, saying that an older version could give worse results, and records the
answer. On update it runs the commands below for the marketplace each plugin
came from, in each app that has an outdated plugin, checks the new version is
installed, then asks them to quit and reopen the ChatGPT app. In the app's
default "Ask for approval" mode the check needs one "Allow once" (it reads
GitHub and saves its result outside the workspace, which the sandbox blocks).
When the check still cannot reach GitHub, the session carries on and says so.
The first reply's setup check lists the installed closedloop-core and vibe
versions either way.

To update by hand, check which version is installed and where the `closedloop-ai` marketplace
comes from:

```bash
"$CODEX" plugin list --marketplace closedloop-ai   # VERSION column of vibe@closedloop-ai
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

If `vibe@closedloop-ai` still shows the old version, install it again from
the refreshed marketplace:

```bash
"$CODEX" plugin add vibe@closedloop-ai
"$CODEX" plugin add closedloop-core@closedloop-ai
"$CODEX" plugin add vibe-core@closedloop-ai
```

**Local folder marketplace** (added with
`"$CODEX" plugin marketplace add <path to a claude-plugins checkout>`; ROOT is
that checkout). `marketplace upgrade` only refreshes Git marketplaces, so it
does not update this one. Pull the checkout, then install the plugin again:

```bash
git -C "<path to the claude-plugins checkout>" pull
"$CODEX" plugin add vibe@closedloop-ai
"$CODEX" plugin add closedloop-core@closedloop-ai
"$CODEX" plugin add vibe-core@closedloop-ai
"$CODEX" plugin list --marketplace closedloop-ai
```

`plugin add` deletes every older vibe version's cache, including the one a
running session was recorded under. Nothing needs restoring: a stopped
helper's lock releases without its old version and a writer moves through
`references/quality-loop.md`'s turn stranded by a plugin upgrade. A turn still running
loses its scripts, so install between turns.

In both cases, quit the ChatGPT app completely (Cmd+Q, not just closing the
window) and reopen it, so it loads the new skills and workers. The new
version is the `version` in `plugins/vibe/.codex-plugin/plugin.json` on
claude-plugins `main`.

## Daily use

| Command | What it does |
|---|---|
| `$vibe` | Start something new, or pick up where they left off |
<!-- generic: daily -->
| "redeploy" (in a vibe session) | Put the latest changes on their running copy of the app |
| `$handoff` | Check and finish the work and hand it to whoever they name to pick it up next (usually design, then engineering) |
<!-- end generic: daily -->
> Provider `tickets+recipes` (block `daily` of `vibe/install.md`)

## Worker chats in the Codex app sidebar

Vibe's Claude workers save their sessions, and the Codex app's Import from
Claude turns each saved Claude session into a chat in the sidebar; with Keep
imports in sync on, it imports new ones every 12 hours. Each worker chat is
titled `vibe <role> · <session> · <request>`. To keep them out of the sidebar,
leave recent chats out of a Claude import and turn Keep imports in sync off.
Vibe never changes the app's settings.
