---
name: codex-fleet-monitor
description: 'Use PROACTIVELY whenever you start or are already running two or more Codex or vibe sessions, or are watching PRs on their behalf, and need to be told when anything needs attention. Replaces hand-rolled polling loops: a Codex turn that hits a usage limit stays "active" and silent, so a watcher that checks only for an open turn misses it. This reads each thread''s progress and flags IDLE, STALLED, FAILED(LIMIT), new PR comments or reviews, check changes, merge conflicts, and new PRs.'
---

# codex-fleet-monitor

One background command that polls every watched Codex thread and PR, and exits with a diff the moment any line changes. You read the diff, act, then re-arm it. It costs no model tokens while waiting.

## Why liveness is read from the thread, not the turn id

A Codex turn that hits a usage limit stays open and simply stops producing items. Checking only "is a turn active" reports it as running forever. This monitor reads each thread's last turn (status, error, item count) and flags a turn whose item count has not grown for `STALL_SECONDS` as `STALLED`.

## Requirements

- Each Codex session is identified by its thread id. `scripts/liveness.mjs` is self-contained (Node built-ins only): it starts the managed App Server with `codex app-server daemon start`, connects through `codex app-server proxy`, and calls `thread/read`. Nothing outside the vibe plugin and the `codex` CLI is needed.
- `codex`, `node`, `jq`, `gh` (authenticated) on this machine; `codex` and `node` on the remote host, reachable through `REMOTE_SHELL`.

## Set up a work dir

Pick a scratch dir (one per orchestration) and create:

`config.env`

```sh
LOCAL_STATE_DIR=/path/to/local/state/files   # only for two-column sessions
REMOTE_HOST=user@host            # omit when there are no remote sessions
REMOTE_STATE_DIR=/path/on/remote # remote scratch dir; also holds state files for two-column sessions
REMOTE_SHELL="zsh -lic"          # login shell so node/codex are on PATH (default)
STALL_SECONDS=720                # no new thread items for this long means STALLED (default 12m)
WATCH_NEW_PR_REPOS="owner/repo"  # optional: list open PRs here to spot new ones
PR_SEARCH="head:feature/"        # optional: search filter for that list
BOT_LOGIN_REGEX="vercel|codex|github-actions|copilot|bot"  # authors not counted as human feedback
# MY_GH_LOGIN=me                 # your own comments are not counted; defaults to `gh api user`
```

`sessions.txt`: one line per Codex session, in either form:

- `local|remote <label> <threadId>`: the thread id directly.
- `local|remote <name>`: reads `<stateDir>/<name>.json`, which must contain a `threadId` field (`LOCAL_STATE_DIR` or `REMOTE_STATE_DIR`). Use this when another tool already writes per-session state files.

The label is what appears in the output lines.

`prs.txt`: one line per PR to watch, `owner/repo <number>`. Add a PR when it opens, remove it when it merges.

## Run

```sh
scripts/watch.sh <workDir> [intervalSeconds]
```

Start it with `run_in_background`. You are notified when it exits. Read its output, handle every line, then start it again; it only watches while running. Editing `sessions.txt` or `prs.txt` takes effect on the next re-arm. `scripts/snapshot.sh <workDir>` prints the current state once.

## Reading the output

| Line | Meaning | Usual action |
|---|---|---|
| `session <where> <name> RUN` | turn in progress and producing items | none |
| `session ... IDLE` | turn completed; the session is waiting for you | read its last message, give it the next turn |
| `session ... STALLED(...)` | turn open but silent | check for a usage limit or a hung command; tell the user if it needs them |
| `session ... FAILED(LIMIT)` | turn errored on usage or rate limit | tell the user right away; a reset or second account is theirs to do |
| `session ... FAILED(ERROR)` / `STOPPED(...)` / `READFAIL` | turn errored, was interrupted, or the thread or state file is unreadable | inspect the thread; restart or resume |
| `session remote <host> UNREACHABLE` | ssh failed | check the host |
| `open-prs <repo> <numbers>` | open PR list changed | add the new PR to `prs.txt` and start its review |
| `pr ... <state> <head> <reviewDecision> <mergeable> comments= reviews= inline= checks=` | any field changed | new head: re-review; count up: read the feedback; `CONFLICTING`: tell the owning session to merge the base branch; checks: act on failures |

Surface everything that needs a human to the user immediately: limits, stalls, failures, and new human review comments.

## Notes

- `mergeable` keeps its last known value while GitHub reports `UNKNOWN`, so it does not flap.
- Item history lives in `<workDir>/item-history.txt`; delete it to reset stall timers.
- Don't run two copies on the same work dir.
