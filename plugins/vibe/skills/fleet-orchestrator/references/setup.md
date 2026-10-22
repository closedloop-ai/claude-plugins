# Setup

## Prerequisites

- `codex`, `node` and `gh` (authenticated) on every machine that hosts sessions or checks, and this plugin installed for Codex and Claude on every machine that hosts writers, since every writer is a vibe session; the closedloop-graph MCP server (from the closedloop-core plugin) connected on every machine that runs the orchestrator or writers; `jq` where codex-fleet-monitor runs.
- For more than one machine: ssh key auth from the orchestrating machine to each other machine, so `ssh <host> true` runs with no password prompt. That is the one thing this skill cannot set up for you.

## config.env

`<orchDir>/config.env` holds every machine-specific value. codex-fleet-monitor reads the same file; its own keys are documented in that skill. Use absolute paths: a `~` would expand to this machine's home, not the other machine's.

```sh
WRITERS=<claude, codex or both>
CODEX_MACHINES=<local, remote or both: where Codex accounts have budget>
UX_PRECEDENT=<the established product the team follows for UX precedent>

LOCAL_STATE_DIR=<orchDir>/sessions          # Codex session state files on this machine
REQUESTS_DIR=<orchDir>/requests             # visual-work request files from sessions here

# Codex model policy, with names from your Codex account
CODEX_MODEL=<model for each Codex writer thread>
CODEX_EFFORT=<the high effort level, not the maximum>

HEAVY_SLOTS=<concurrent heavy checks this machine can take>
MAX_LOAD_PER_CORE=1.5                       # a heavy slot refuses this machine above this load per core
MOVE_AT_PERCENT=<codex-usage band at which to move writers off a machine>

# The target repo's own names for the program practices
GREEN_REF=<the ref post-merge CI advances when main is healthy>
GREEN_WATCH_AGENT=<the repo's agent that fixes a red post-merge batch, if it has one>
REPO_MEMORY_CMD=<the command that adds an entry to the team's repo memory>
REQUIRED_DUTIES="green-watch"               # board.mjs status prints MISSING-DUTY for each one without an owner

# One other machine; leave all of these out for a single machine
REMOTE_HOST=<ssh host or alias>
REMOTE_STATE_DIR=<orchestration dir on that machine>/sessions
REMOTE_REQUESTS_DIR=<orchestration dir on that machine>/requests
REMOTE_SHELL="zsh -lic"                     # a login shell there that puts node, codex and gh on PATH
REMOTE_HEAVY_SLOTS=<concurrent heavy checks that machine can take>
REMOTE_MAX_LOAD_PER_CORE=1.5
```

`fleet.sh` uses `LOCAL_STATE_DIR` (default `<orchDir>/sessions`), `CODEX_MODEL` and `CODEX_EFFORT` as `turn` defaults, the slot counts, and the `REMOTE_*` keys. Sub-agent models are not configured here: vibe's worker-model policy owns them. `MOVE_AT_PERCENT` is for you: compare it with each `codex-usage` line.

## First-run interview

Ask once, in one question set, only for keys `config.env` lacks; offer the default first.

| Question | Default | Writes |
|---|---|---|
| Machines: this one only, or more (the ssh host of each)? | this one only | `REMOTE_HOST`, `REMOTE_STATE_DIR`, `REMOTE_REQUESTS_DIR`, `REMOTE_SHELL` |
| Writers: Claude only, Codex only, or both? | Claude only | `WRITERS` |
| Codex (when chosen): which machine's account has budget, at what usage band to move work, and which thread model and effort? | this machine; move at 80 | `CODEX_MACHINES`, `MOVE_AT_PERCENT`, `CODEX_MODEL`, `CODEX_EFFORT` |
| Which product does the team follow for UX precedent? | none; repo siblings only | `UX_PRECEDENT` |

Then set `LOCAL_STATE_DIR`, `REQUESTS_DIR` and the slot counts from this machine's layout and core count, write the file, and run steps 3 and 5 of the checklist below plus a check that this plugin is installed on each machine. Report each check as passed or failed.

## Checklist

1. Create the orchestration dir in a path that survives a reboot, with `sessions/`, `prompts/`, `requests/` and `findings/` ([layout](./state.md)), and write `config.env`.
2. Fill `sessions.txt` and `prs.txt` as codex-fleet-monitor describes; a session started through `fleet.sh` is listed as `local|remote <name>`.
3. For each other machine: create its orchestration dir the same way, then check ssh and its login shell with `ssh <host> "<REMOTE_SHELL> 'command -v node codex gh'"`, which must print three paths. Install this plugin there in a persistent path.
4. Get a branch to another machine's clone without going through the code host: `git push <host>:<path to its clone> <branch>:<branch>`, then on that machine `git worktree add <worktree path> <branch>` and run the bootstrap the target repo's docs name. Push to a branch that is not checked out there.
5. On each machine, check closedloop-graph answers (its `sync_status` tool) from Claude Code and from Codex.
6. Check the transport with `fleet.sh <orchDir> local|remote session last <name>` on an existing session.
