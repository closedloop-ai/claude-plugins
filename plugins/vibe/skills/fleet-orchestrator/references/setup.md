# Setup

## Prerequisites

- `codex`, `node` and `gh` (authenticated) on every machine that hosts sessions or checks, and this plugin installed for Codex and Claude on every machine that hosts writers, since every writer is a vibe session; `jq` where codex-fleet-monitor runs.
- For more than one machine: ssh key auth from the orchestrating machine to each other machine, so `ssh <host> true` runs with no password prompt. That is the one thing this skill cannot set up for you.

## config.env

`<orchDir>/config.env` holds every machine-specific value. codex-fleet-monitor reads the same file; its own keys are documented in that skill. Use absolute paths: a `~` would expand to this machine's home, not the other machine's.

```sh
LOCAL_STATE_DIR=<orchDir>/sessions          # Codex session state files on this machine
REQUESTS_DIR=<orchDir>/requests             # visual-work request files from sessions here

# Codex model policy, with names from your Codex account
CODEX_MODEL=<main model: writers and reviewers>
CODEX_EXPLORER_MODEL=<cheaper model: explorers and read-only sub-agents>
CODEX_EFFORT=<the high effort level, not the maximum>

HEAVY_SLOTS=<concurrent heavy checks this machine can take>

# One other machine; leave all of these out for a single machine
REMOTE_HOST=<ssh host or alias>
REMOTE_STATE_DIR=<orchestration dir on that machine>/sessions
REMOTE_REQUESTS_DIR=<orchestration dir on that machine>/requests
REMOTE_SHELL="zsh -lic"                     # a login shell there that puts node, codex and gh on PATH
REMOTE_HEAVY_SLOTS=<concurrent heavy checks that machine can take>
```

`fleet.sh` uses `LOCAL_STATE_DIR` (default `<orchDir>/sessions`), `CODEX_MODEL` and `CODEX_EFFORT` as `turn` defaults, the slot counts, and the `REMOTE_*` keys. `CODEX_EXPLORER_MODEL` goes into each session's prompt, which tells the session which model its own sub-agents use.

## Checklist

1. Create the orchestration dir in a path that survives a reboot, with `sessions/`, `prompts/`, `requests/` and `findings/` ([layout](./state.md)), and write `config.env`.
2. Fill `sessions.txt` and `prs.txt` as codex-fleet-monitor describes; a session started through `fleet.sh` is listed as `local|remote <name>`.
3. For each other machine: create its orchestration dir the same way, then check ssh and its login shell with `ssh <host> "<REMOTE_SHELL> 'command -v node codex gh'"`, which must print three paths. Install this plugin there in a persistent path.
4. Get a branch to another machine's clone without going through the code host: `git push <host>:<path to its clone> <branch>:<branch>`, then on that machine `git worktree add <worktree path> <branch>` and run the bootstrap the target repo's docs name. Push to a branch that is not checked out there.
5. Check the transport with `fleet.sh <orchDir> local|remote session last <name>` on an existing session.
