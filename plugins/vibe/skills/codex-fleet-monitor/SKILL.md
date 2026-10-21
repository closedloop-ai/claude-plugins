---
name: codex-fleet-monitor
description: 'Use PROACTIVELY whenever you start or are already running two or more Codex or vibe sessions, or are watching PRs on their behalf, and need to be told when anything needs attention. Replaces hand-rolled polling loops: a Codex turn that hits a usage limit stays "active" and silent, so a watcher that checks only for an open turn misses it. This reads each thread''s progress and flags IDLE, STALLED, FAILED(LIMIT), new PR comments or reviews, settled check changes, merge conflicts, and new PRs. A session whose turn failed with a transient provider error (model at capacity, rate limit, 5xx) is resumed on its own after a backoff, and an optional supervisor does the same on each host with no orchestrator running. It also prints a Codex usage line per machine (used-percent band, and whether a reached limit is spending paid credits) and, when configured, the delegated-work request files sessions drop for Claude workers.'
---

# codex-fleet-monitor

One background command that polls every watched Codex thread and PR, and exits with a diff the moment any line changes. You read the diff, act, then re-arm it. It costs no model tokens while waiting.

It also recovers sessions on its own: a turn that failed with a transient provider error is resumed after a backoff, without waiting for you (see [Recovery](#recovery)). Between your re-arms, and when no orchestrator is awake, the [supervisor](#supervisor) does the same on the host that owns the sessions.

## Why liveness is read from the thread, not the turn id

A Codex turn that hits a usage limit stays open and simply stops producing items. Checking only "is a turn active" reports it as running forever. This monitor reads each thread's last turn (status, error, newest item) and flags a turn whose newest item has not changed for `STALL_SECONDS` as `STALLED`.

It never loads a thread's history. A long-lived thread's full read is tens of MB of JSON and pushed one process past 1 GB of RSS, so every read is `thread/read` without turns (the thread status), `thread/turns/list` for the newest turn without its items (status and error), and, for the watcher, `thread/items/list` for that turn's newest item id. An App Server without `thread/turns/list` falls back to the full read.

## Requirements

- Each Codex session is identified by its thread id. `scripts/liveness.mjs` is self-contained (Node built-ins only): it starts the managed App Server with `codex app-server daemon start`, connects through `codex app-server proxy`, and reads thread status as above. `scripts/ratelimit.mjs` reuses its client to call `account/rateLimits/read`; it is also the plugin's one usage reader and classifier, which the vibe skill's `codex-usage.mjs` gate imports. `scripts/recover.mjs` and `scripts/supervise.mjs` use the same client for recovery. Nothing outside the vibe plugin and the `codex` CLI is needed.
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
# USAGE_HIGH_PERCENT=80         # usage below this prints one band (default MOVE_AT_PERCENT, else 80)
RECOVERY_BACKOFF_SECONDS="120 300 600"  # wait before each resume of a transient failure; one retry per value
# CONTINUE_PROMPT_FILE=/path/to/continue.md  # replaces the built-in continue prompt (REMOTE_CONTINUE_PROMPT_FILE on REMOTE_HOST)
# AUTO_RESTART_DAEMON=1          # allow restarting the App Server daemon for threads stuck in systemError; off by default
# RESTART_COOLDOWN_SECONDS=1800  # at most one automatic restart per host in this window
# MY_GH_LOGIN=me                 # your own comments are not counted; defaults to `gh api user`
# PASS_TIMEOUT_SECONDS=300       # a recovery pass running longer is abandoned with a pass-timeout event
# LOG_MAX_BYTES=1048576          # events.log and supervisor.log rotate to <file>.1 at this size
# SUPERVISOR_RSS_CAP_MB=300      # a supervisor heartbeat over this RSS is RSS-HIGH
REQUESTS_DIR=/path/to/requests   # optional: local dir where sessions drop delegated-work request files
REMOTE_REQUESTS_DIR=/path/on/remote/requests  # optional: the same on REMOTE_HOST
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
| `session ... FAILED(LIMIT)` | turn errored on a usage limit | tell the user right away; a reset or second account is theirs to do |
| `session ... FAILED(TRANSIENT)` | turn errored on a transient provider failure: model at capacity, rate limit, 5xx or a dropped connection | none; recovery resumes it after the backoff (watch the `recovery` line) |
| `session ... FAILED(SYSTEM-ERROR)` | the App Server holds the thread in `systemError`; resume and new turns fail until the daemon restarts | recovery handles it after the retries when `AUTO_RESTART_DAEMON=1`; otherwise act on its ALERT |
| `session ... FAILED(ERROR)` / `STOPPED(...)` / `READFAIL` | turn errored, was interrupted, or the thread or state file is unreadable | inspect the thread; restart or resume |
| `recovery <local\|remote> <count> <last event>` | a recovery action ran on that machine; the log is `<stateDir>/.fleet-recovery/events.log` | read the new events; act on `ALERT` and `gave-up` (below) |
| `supervisor <local\|remote> ok` | that machine's supervisor wrote its heartbeat within 3 of its intervals, under the RSS cap | none |
| `supervisor ... STALE(>Ns)` / `MISSING` / `UNREADABLE` | no heartbeat for 3 intervals (a hung or dead supervisor), the lock exists with no heartbeat, or the heartbeat cannot be parsed | read `supervisor.log` there; restart the supervisor |
| `supervisor ... RSS-HIGH(>NMB)` | the supervisor's RSS is over `SUPERVISOR_RSS_CAP_MB` | read its hourly summary lines; restart it and report the leak |
| `session remote <host> UNREACHABLE` | ssh failed | check the host |
| `codex-usage <local\|remote> under80% ok resets=<n>` / `HIGH(<band>%)` | Codex account usage on that machine: one band below `USAGE_HIGH_PERCENT` (80 here) used, so ordinary use is not an event, then the used percent floored to 10; `resets` is the count of available limit resets | none below it; on `HIGH`, warn the user with the rate |
| `codex-usage ... LIMIT` / `LIMIT-STOPPED` | usage limit reached; `LIMIT` means ordinary usage is still allowed, `LIMIT-STOPPED` means sessions cannot run | tell the user right away; a reset or second account is theirs to do |
| `codex-usage ... LIMIT-SPENDING-CREDITS` | limit reached and turns are now consuming paid credits | tell the user at once and stop sending turns unless they approve paid credits |
| `codex-usage ... unknown` / `unreadable READFAIL` | the App Server answered without rate limits, or it or the remote host could not be read | check `codex` on that machine |
| `requests <local\|remote> <count> <newest file>` / `requests ... UNREADABLE` | a session dropped (or you removed) a delegated-work request file | hand the new request to a Claude worker, then steer its result back to the session that asked |
| `open-prs <repo> <numbers>` | open PR list changed | add the new PR to `prs.txt` and start its review |
| `pr ... <state> <head> <reviewDecision> <mergeable> comments= reviews= inline= checks=` | any field changed | new head: re-review; count up: read the feedback; `CONFLICTING`: tell the owning session to merge the base branch; checks: act on failures. Check counts change only once settled; while any check is pending the last settled counts show with ` (running)` |

Surface everything that needs a human to the user immediately: limits, paid-credit spending, stalls, failures, and new human review comments.

## Recovery

Each watcher tick runs `scripts/recover.mjs` on every machine that has sessions (unless that machine's supervisor is running, which owns recovery there). For a session whose last turn failed with a transient provider error:

1. It waits the next `RECOVERY_BACKOFF_SECONDS` value, then reloads the thread (`thread/resume`) and starts a turn with the continue prompt. The built-in prompt tells the session to check its real state (git status and HEAD, a merge or rebase in progress, its background jobs and slot or lock entries, its last push) and not to redo finished steps. Retries count across consecutive transient failures and reset once a turn completes.
2. If the thread is still in `systemError` after the last retry, the App Server daemon must restart. With `AUTO_RESTART_DAEMON=1` it prints a loud `!!! RESTARTING` line, runs `codex app-server daemon restart`, then resumes with the continue prompt each watched session on that machine whose turn was active (the restart interrupts it) or failed. An idle session stays idle, since a prompt would start work nobody asked for. Each session's state just before the restart is a `before-restart` event. It restarts at most once per `RESTART_COOLDOWN_SECONDS`. With the switch off it prints one `ALERT ... daemon-restart-needed` line and restarts nothing.
3. Retries used up outside `systemError` print one `gave-up` line. A usage limit or any other error is never resumed; those stay yours.

Every action is an `EVENT recovery ...` line in the events log, which the `recovery` snapshot line reports, so you see what happened when you wake.

| Event | Usual action |
|---|---|
| `<label> transient-failure ...` / `resumed ...` / `recovered ...` | none; read the session's last message when convenient |
| `<label> resume-failed ...` | none while retries remain |
| `pass-timeout after <N>s ...` | a pass outlasted `PASS_TIMEOUT_SECONDS`, usually a daemon that stopped answering; its connections were closed and the next pass runs on schedule | if it repeats, check `codex app-server daemon` on that host |
| `pass-failed: ...` (supervisor log) | a pass could not connect or read | if it repeats, check `codex` on that host |
| `<label> gave-up ...` | inspect the thread; resume it yourself or tell the user |
| `ALERT <host> daemon-restart-needed ...` | with the user's agreement run `codex app-server daemon restart` on that host, then resume each session there |
| `!!! RESTARTING ...` / `<label> before-restart ...` / `resumed-after-restart ...` / `left-idle-after-restart` | tell the user it happened; check each resumed session's next message |
| `ALERT <host> restart-cooldown ...` / `daemon-restart-failed` | tell the user; a second restart is theirs to decide |

## Supervisor

`scripts/supervise.sh <workDir> [intervalSeconds]` runs on the host that owns the Codex sessions, with no Claude session involved. It loads `<workDir>/config.env` and runs a recovery pass over the `local` lines of `<workDir>/sessions.txt` every interval (default 60 seconds, or `SUPERVISE_INTERVAL_SECONDS`). Recovery state and the events log live in `LOCAL_STATE_DIR` (the work dir when unset).

- One supervisor per host: it holds `FLEET_SUPERVISOR_LOCK` (default `~/.codex/fleet-supervisor.lock`), and a second one exits with status 3. A lock left by a dead process is taken over.
- On a remote host, give it a work dir whose `sessions.txt` lists that host's sessions as `local` and whose `LOCAL_STATE_DIR` is the `REMOTE_STATE_DIR` the watcher uses, so the watcher's `recovery remote` line reads the same log.
- Each pass is bounded by `PASS_TIMEOUT_SECONDS` (default 300, enough for a daemon restart and the resumes after it). A pass that runs longer gets a `pass-timeout` event, its App Server connections are closed so it unwinds and releases its lock, and the loop goes on.
- After every pass it writes `<stateDir>/.fleet-recovery/heartbeat.json`: time, pid, interval, pass count, last pass duration, last error and RSS. The watcher's `supervisor` line reads it, so a hung, dead or leaking supervisor is an event. Once an hour it logs a `supervise: hourly` line (passes, errors, longest pass, RSS). A clean stop removes the heartbeat.
- It logs to stdout, which the templates append to `<workDir>/supervisor.log`; at `LOG_MAX_BYTES` (default 1 MB) it copies that file to `supervisor.log.1` and empties it. `SUPERVISOR_LOG` names the file when it is elsewhere. The events log rotates the same way to `events.log.1`.
- Keep it running with `templates/codex-fleet-supervisor.plist` (launchd, macOS) or `templates/codex-fleet-supervisor.service` (systemd user unit, Linux). Each template says where to save it and how to load it; nothing is installed for you.

## Notes

- `mergeable` keeps its last known value while GitHub reports `UNKNOWN`, so it does not flap.
- Each run compares against `<workDir>/last-snapshot.txt` from the previous run, so a change between a watcher exit and its re-arm is still reported. Delete the file to start from a fresh base.
- Item history lives in `<workDir>/item-history.txt`; delete it to reset stall timers. Settled check counts live in `<workDir>/checks-*.txt`. The `keep-*`, `merge-*` and `checks-*` files of a PR are removed once it leaves `prs.txt`.
- On the remote host the scripts are copied to `<REMOTE_STATE_DIR>/.fleet-monitor/` on every snapshot.
- A failed or empty `gh` read repeats that field's last value, so an API blip is not an event.
- Don't run two copies on the same work dir.
