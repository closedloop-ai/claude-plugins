# Setup

## Prerequisites

- `codex`, `node` and `gh` (authenticated) on every machine that hosts sessions or checks, and this plugin installed for Codex and Claude on every machine that hosts writers, since every writer is a vibe session; the closedloop-graph MCP server (from the closedloop-core plugin) connected on every machine that runs the orchestrator or writers; `jq` where codex-fleet-monitor runs.
- For more than one machine: ssh key auth from the orchestrating machine to each other machine, so `ssh <host> true` runs with no password prompt. That is the one thing this skill cannot set up for you.

## config.env

`<fleetHome>/config.env` holds every machine-specific value; codex-fleet-monitor reads the same file and documents its own keys. Use absolute paths, since `~` expands to this machine's home.

```sh
WRITERS=<claude, codex or both>
CODEX_MACHINES=<local, remote or both: where Codex accounts have budget>
UX_PRECEDENT=<the established product the team follows for UX precedent>

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
REMOTE_FLEET_HOME=<the fleet home on that machine>
REMOTE_SHELL="zsh -lic"                     # a login shell there that puts node, codex and gh on PATH
REMOTE_HEAVY_SLOTS=<concurrent heavy checks that machine can take>
REMOTE_MAX_LOAD_PER_CORE=1.5
```

Session, request and remote state dirs are derived per program. `fleet.sh` uses `CODEX_MODEL` and `CODEX_EFFORT` as `turn` defaults, the slot and load keys, and the `REMOTE_*` keys. Vibe's worker-model policy owns sub-agent models. `MOVE_AT_PERCENT` is yours to compare with each `codex-usage` line.

## First-run interview

Ask once, in one question set, only for keys `config.env` lacks; offer the default first.

Ask nothing when the operator runs vibe (the work is their vibe session or
ticket, not a fleet they run) or the program is `one-writer` or `no-writer`:
the defaults already fit one writer, so the answers would change nothing.
Write every default below and report
them in one plain line, such as "I set this up with the defaults: this
machine, Claude writers, no outside product for UX precedent." Ask about
machines only when the operator already named another machine, never about
writers, models, effort, budget or the move threshold.

| Question | Default | Writes |
|---|---|---|
| Machines: this one only, or more (the ssh host of each)? | this one only | `REMOTE_HOST`, `REMOTE_FLEET_HOME`, `REMOTE_SHELL` |
| Writers: Claude only, Codex only, or both? | Claude only | `WRITERS` |
| Codex (when chosen): which machine's account has budget, at what usage band to move work, and which thread model and effort? | this machine; move at 80 | `CODEX_MACHINES`, `MOVE_AT_PERCENT`, `CODEX_MODEL`, `CODEX_EFFORT` |
| Which product does the team follow for UX precedent? | none; repo siblings only | `UX_PRECEDENT` |

Then set the slot counts from this machine's core count, write the file, and run steps 3 and 5 of the checklist below plus a check that this plugin is installed on each machine. Report each check as passed or failed.

## Checklist

1. Run `scripts/fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet` ([layout](./state.md)) and write `<fleetHome>/config.env`.
2. Fill `sessions.txt` and `prs.txt` as codex-fleet-monitor describes; a session started through `fleet.sh` is listed as `local|remote <name>`.
3. For each other machine: create its fleet home the same way, then check ssh and its login shell with `ssh <host> "<REMOTE_SHELL> 'command -v node codex gh'"`, which must print three paths. Install this plugin there in a persistent path.
4. Get a branch to another machine's clone without going through the code host: `git push <host>:<path to its clone> <branch>:<branch>`, then on that machine `git worktree add <worktree path> <branch>` and run the bootstrap the target repo's docs name. Push to a branch that is not checked out there.
5. On each machine, check closedloop-graph answers (its `sync_status` tool) from Claude Code and from Codex.
6. Check the transport with `fleet.sh <orchDir> local|remote session last <name>` on an existing session.
