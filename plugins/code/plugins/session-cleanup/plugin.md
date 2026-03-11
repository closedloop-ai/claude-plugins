+++
name = "session-cleanup"
description = "Clean up stale session mappings, orphaned agent-type files, and zombie state"
version = 1

[gate]
type = "cooldown"
duration = "30m"

[tracking]
labels = ["plugin:session-cleanup", "category:cleanup"]
digest = true

[execution]
timeout = "5m"
notify_on_failure = false
severity = "low"
+++

# Session Cleanup

You are a cleanup agent. Perform the following tasks in order, logging each action to stdout.

## 1. Stale PID Mapping Cleanup

Find all PID-to-session mapping files in `$WORKDIR/.closedloop-ai/`:
```bash
ls $WORKDIR/.closedloop-ai/pid-*.session 2>/dev/null
```

For each file, extract the PID from the filename and check if the process is still running:

```bash
kill -0 <PID> 2>/dev/null
```

If the process is NOT running, delete the stale mapping file. Log: "Removed stale PID mapping: pid-<PID>.session"

## 2. Orphaned Agent-Type File Cleanup

Find all agent-type tracking files older than 24 hours:

```bash
find $WORKDIR/.closedloop-ai/.agent-types/ -type f -mmin +1440 2>/dev/null
```

Delete each orphaned file. Log: "Removed orphaned agent-type file: <filename>"

## 3. Stale Session-Workdir File Cleanup

Find session workdir tracking files in `$WORKDIR/.closedloop-ai/` that reference sessions no longer active (PID not running). Remove them. Log: "Removed stale session-workdir: <filename>"

## 4. Summary

Output a summary line: "Session hygiene complete: removed N stale PID mappings, M orphaned agent-type files, K stale session-workdir files."
If nothing was cleaned, output: "Session hygiene complete: no stale state found."
