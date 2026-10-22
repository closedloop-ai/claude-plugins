---
name: codex-fleet-monitor
description: 'Use PROACTIVELY whenever you start or are already running two or more Codex or vibe sessions, or are watching PRs on their behalf, and need to be told when anything needs attention. Replaces hand-rolled polling loops: a Codex turn that hits a usage limit stays "active" and silent, so a watcher that checks only for an open turn misses it. This reads each thread''s progress and flags IDLE, STALLED, FAILED(LIMIT), new PR comments or reviews, settled check changes, merge conflicts, and new PRs. A session whose turn failed with a transient provider error (model at capacity, rate limit, 5xx) is resumed on its own after a backoff, and an optional supervisor does the same on each host with no orchestrator running. It also prints a Codex usage line per machine (used-percent band, and whether a reached limit is spending paid credits) and, when configured, the delegated-work request files sessions drop for Claude workers.'
---

# codex-fleet-monitor

One background command polls every watched Codex thread and PR and exits with a diff when any line changes; act on it, then re-arm. Waiting costs no model tokens.

It also resumes a turn that failed with a transient provider error after a backoff ([Recovery](#recovery)); the [supervisor](#supervisor) does the same on each host when no orchestrator is awake.

## Why liveness is read from the thread, not the turn id

A Codex turn that hits a usage limit stays open and stops producing items, so "is a turn active" reports it running forever. The monitor reads each thread's last turn (status, error, newest item) and flags a turn whose newest item has not changed for `STALL_SECONDS` as `STALLED`. It never loads a thread's history (one full read passed 1 GB of RSS): `thread/read` without turns, `thread/turns/list` for the newest turn, and `thread/items/list` for its newest item, with a full read only on an App Server too old for `thread/turns/list`.

## Requirements

- Each Codex session is identified by its thread id. `scripts/liveness.mjs` (Node built-ins only) starts the managed App Server with `codex app-server daemon start` and connects through `codex app-server proxy`; `scripts/ratelimit.mjs` (the plugin's one usage reader, also imported by vibe's `codex-usage.mjs`), `scripts/recover.mjs` and `scripts/supervise.mjs` reuse its client.
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
# CLAUDE_USAGE=0                 # turn off the claude-usage line; CLAUDE_USAGE_SECONDS=600 sets how often it is read
# QUESTION_SECONDS=900          # an idle writer's question unanswered this long is QUESTION-UNANSWERED (default 15m)
# STALE_PR_SECONDS=2700         # a PR needing its writer with no push this long is STALE-PR (default 45m)
# HEARTBEAT_SECONDS=1800         # with no change, watch.sh exits with HEARTBEAT after this long (default 30m)
WATCH_NEW_PR_REPOS="owner/repo"  # open PRs here that PR_SEARCH lists or WATCH_PR_AUTHOR opened join the watch set
# WATCH_PR_AUTHOR=@me            # author whose open PRs are watched on any branch prefix (default the gh account)
PR_SEARCH="head:feature/"        # optional: search filter for that list
BOT_LOGIN_REGEX="vercel|codex|github-actions|copilot|bot"  # authors not counted as human feedback
# USAGE_HIGH_PERCENT=80         # usage below this prints one band (default MOVE_AT_PERCENT, else 80)
# CODEX_MODEL=<model>            # with CODEX_EFFORT, a thread on another model or effort gets a MODEL(...) word
# CODEX_EFFORT=high
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

`prs.txt`: the watch set, one line per PR, `owner/repo <number> [<writer>]`. The snapshot adds open PRs from `WATCH_NEW_PR_REPOS` on any branch, and drops a merged or closed PR after reporting it once; add the writer column when you assign a PR so `STALE-PR` names whom to nudge. A Claude pane writer has no turn state to read, so `STALE-PR` on its PR is its liveness signal.

## Run

```sh
scripts/watch.sh <workDir> [intervalSeconds]
```

Start it with `run_in_background`, never with `&` (a second copy for the same work dir exits 3). When it exits, handle every line, then start it again; it only watches while running. An `IDLE` line carries the writer's final message tail, also once the thread is unloaded (`notLoaded`), and says `NEEDS-REPLY` when any line asks a question or for permission, authorization or approval. Before ending any turn that handled an event, `node scripts/watcher.mjs <workDir>` must print `watcher ok`; re-arm on `MISSING`. `sessions.txt` and `prs.txt` edits take effect on the next re-arm; `scripts/snapshot.sh <workDir>` prints the state once.

## Reading the output

| Line | Meaning | Usual action |
|---|---|---|
| `HEARTBEAT ...` | nothing changed for `HEARTBEAT_SECONDS` | read every teammate message and idle writer question, then re-arm |
| `session <where> <name> RUN` | turn in progress and producing items | none |
| `session ... IDLE` | turn completed; the session is waiting for you | read its last message, give it the next turn |
| `session ... IDLE QUESTION-UNANSWERED(15m+) ...` | the writer asked something and has waited `QUESTION_SECONDS` (15 minutes) | answer it now, or tell it to proceed on its default |
| `session ... MODEL(<model>/<effort>!=<want>)` | the thread runs on another model or effort than `CODEX_MODEL` and `CODEX_EFFORT` | restart it on the configured one; other models were far slower |
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
| `codex-usage <local\|remote> under80% ok resets=<n>` / `HIGH(<band>%)` | Codex usage on that machine: one band below `USAGE_HIGH_PERCENT` (80 here), then the used percent floored to 10; `resets` counts available limit resets | on `HIGH`, warn the user at once with the band and `resets` (applying one is theirs); if they are away, move the busiest writers to Claude writers |
| `claude-usage local session=<band> week=<band>` | Claude usage from `claude -p "/usage"` on the same bands (read at most every `CLAUDE_USAGE_SECONDS`, 600) | on `HIGH`, warn the user at once with its `resets=` time; if they are away, move the busiest Claude writers to Codex writers |
| `codex-usage ... LIMIT` / `LIMIT-STOPPED` | usage limit reached; `LIMIT` means ordinary usage is still allowed, `LIMIT-STOPPED` means sessions cannot run | tell the user right away; a reset or second account is theirs to do |
| `codex-usage ... LIMIT-SPENDING-CREDITS` | limit reached and turns are now consuming paid credits | tell the user at once and stop sending turns unless they approve paid credits |
| `codex-usage ... unknown` / `unreadable READFAIL` | the App Server answered without rate limits, or it or the remote host could not be read | check `codex` on that machine |
| `requests <local\|remote> <count> <newest file>` / `requests ... UNREADABLE` | a session dropped (or you removed) a delegated-work request file | hand the new request to a Claude worker, then steer its result back to the session that asked |
| `open-prs <repo> <numbers>` | open PR list changed | add the new PR to `prs.txt` and start its review |
| `pr ... BLOCKED(unresolved threads)` | unresolved review threads (`threads=<n>`) block the merge even when approved with auto-merge armed | route each thread to the owning writer now; it is not a missing approval |
| `pr ... STALE-PR(...)` | an open PR with unresolved threads, a conflict, a draft flag or a failed check has had no push for `STALE_PR_SECONDS` (45 minutes) | ask its writer for an ETA, unblock it, or reassign it, however busy the writer looks |
| `pr ... <state> <head> <reviewDecision> <mergeable> comments= reviews= inline= threads= checks=` | any field changed | new head: re-review; count up: read the feedback; `CONFLICTING`: tell the owning session to merge the base branch; checks: act on failures (counts change only once settled, with ` (running)` meanwhile) |

Surface everything that needs a human to the user immediately: limits, paid-credit spending, stalls, failures, and new human review comments.

## Recovery

Each watcher tick runs `scripts/recover.mjs` on every machine that has sessions (unless that machine's supervisor is running, which owns recovery there). For a session whose last turn failed with a transient provider error:

1. It waits the next `RECOVERY_BACKOFF_SECONDS` value, reloads the thread (`thread/resume`) and starts a turn with the continue prompt, which tells the session to check its real state (git, merges, background jobs, locks, last push) and not redo finished steps. Retries reset once a turn completes.
2. A thread still in `systemError` after the last retry needs the App Server daemon restarted. With `AUTO_RESTART_DAEMON=1` it prints `!!! RESTARTING`, runs `codex app-server daemon restart` (at most once per `RESTART_COOLDOWN_SECONDS`), records each session's `before-restart` state, and resumes only sessions whose turn was active or failed; idle ones stay idle. With the switch off it prints one `ALERT ... daemon-restart-needed` line.
3. Retries used up outside `systemError` print one `gave-up` line. A usage limit or any other error is never resumed; those stay yours.
4. An idle session whose question ends `If no answer by <ISO time>: <default>` (vibe's `session-questions.mjs`) is told to go ahead on the default once that time passes (`proceeded-on-default`).

Every action is an `EVENT recovery ...` line in the events log, which the `recovery` snapshot line reports, so you see what happened when you wake.

| Event | Usual action |
|---|---|
| `<label> transient-failure ...` / `resumed ...` / `recovered ...` | none; read the session's last message when convenient |
| `<label> proceeded-on-default ...` | nobody answered by the deadline; answer now if the default is wrong |
| `<label> resume-failed ...` | none while retries remain |
| `pass-timeout after <N>s ...` | a pass outlasted `PASS_TIMEOUT_SECONDS`, usually a daemon that stopped answering; its connections were closed and the next pass runs on schedule | if it repeats, check `codex app-server daemon` on that host |
| `pass-failed: ...` (supervisor log) | a pass could not connect or read | if it repeats, check `codex` on that host |
| `<label> gave-up ...` | inspect the thread; resume it yourself or tell the user |
| `ALERT <host> daemon-restart-needed ...` | with the user's agreement run `codex app-server daemon restart` on that host, then resume each session there |
| `!!! RESTARTING ...` / `<label> before-restart ...` / `resumed-after-restart ...` / `left-idle-after-restart` | tell the user it happened; check each resumed session's next message |
| `ALERT <host> restart-cooldown ...` / `daemon-restart-failed` | tell the user; a second restart is theirs to decide |

## Supervisor

`scripts/supervise.sh <workDir> [intervalSeconds]` runs on the host that owns the Codex sessions, with no Claude session involved: a recovery pass over the `local` lines of `<workDir>/sessions.txt` every interval (default 60 seconds, or `SUPERVISE_INTERVAL_SECONDS`), with state and events in `LOCAL_STATE_DIR` (the work dir when unset).

- One supervisor per host: it holds `FLEET_SUPERVISOR_LOCK` (default `~/.codex/fleet-supervisor.lock`), and a second one exits with status 3. A lock left by a dead process is taken over.
- On a remote host, give it a work dir whose `sessions.txt` lists that host's sessions as `local` and whose `LOCAL_STATE_DIR` is the `REMOTE_STATE_DIR` the watcher uses, so the watcher's `recovery remote` line reads the same log.
- A pass longer than `PASS_TIMEOUT_SECONDS` (default 300) gets a `pass-timeout` event, its connections are closed and the loop goes on.
- After every pass it writes `<stateDir>/.fleet-recovery/heartbeat.json` (time, pid, interval, passes, last duration and error, RSS), which the watcher's `supervisor` line reads, and logs a `supervise: hourly` summary each hour.
- Its stdout goes to `<workDir>/supervisor.log` (or `SUPERVISOR_LOG`), rotated to `supervisor.log.1` at `LOG_MAX_BYTES` (1 MB), as `events.log` is.
- Keep it running with `templates/codex-fleet-supervisor.plist` (launchd) or `templates/codex-fleet-supervisor.service` (systemd user unit); each says how to load it. On macOS restart it with `launchctl bootout` then `launchctl bootstrap`, never `launchctl kickstart -k`, which hung the calling shell.

## Notes

- `mergeable` keeps its last known value while GitHub reports `UNKNOWN`, so it does not flap.
- Each run compares against `<workDir>/last-snapshot.txt`, so a change between an exit and the re-arm is still reported; delete it for a fresh base. Delete `<workDir>/item-history.txt` to reset stall timers. A PR's state files go once it leaves `prs.txt`.
- On the remote host the scripts are copied to `<REMOTE_STATE_DIR>/.fleet-monitor/` on every snapshot.
- A failed or empty `gh` read repeats that field's last value, so an API blip is not an event.
