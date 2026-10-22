# Orchestration state

## Layout

One directory per program on each machine, in a path that survives a reboot. The orchestrating machine's dir is also the codex-fleet-monitor work dir.

```
<orchDir>/
  config.env  sessions.txt  prs.txt   monitor inputs (see codex-fleet-monitor)
  last-snapshot.txt  item-history.txt  checks-*.txt   monitor-owned; leave alone
  sessions/<name>.json   session state written by fleet.sh: threadId, cwd, model, effort, sandbox, turns
  prompts/<name>-<nn>-<slug>.md   every prompt sent to any worker, written before sending
  requests/                       REQUESTS_DIR: visual-work request files from Codex sessions
  findings/                       review, verification, QA and visual results, one file per task
  rulings.md                      program rulings, dated and sourced; mirrored to every worker host
  attention.md                    operator decisions needed, recommendations and blocked work
  review.md                       one operator review page with stable finding IDs
  resume-log.md
  lessons.md
```

A remote machine keeps `sessions/` and `requests/` under its own persistent dir (`REMOTE_STATE_DIR` and `REMOTE_REQUESTS_DIR`). Prompts stay in this machine's `prompts/`; `fleet.sh` copies each one over when it sends it.

## Resume log

`resume-log.md`, newest entry last, one entry per event worth keeping:

```
## 2026-10-20 14:05
- Ruling (operator): <decision, quoted or cited>
- Merge order: #101 then #102 (102 stacks on 101)
- Owners: w1 (codex, laptop-b) writes #101; review-101 (claude) reviewing head <sha>
- Restarted: watcher re-armed; review-102 relaunched from prompts/review-102-01-initial.md
- Pending: #102 QA checkpoint 3 with the operator; flag key approval for <key>
```

Read it top to bottom after any restart or compaction before acting.

## Program rulings

`rulings.md` is the program-wide index, separate from the status-oriented
resume log. Each entry records the ruling, date and source: a quoted operator
message, an AskUserQuestion answer or a ticket, as `- Ruling YYYY-MM-DD
(operator message|AskUserQuestion|ticket: <source>): <decision>`. Mirror it to every worker host
after each edit and point every worker and QA-prep prompt at it. Per-ticket
rulings still go through handoff's `rulings-check.mjs`. The pre-audit
reconciliation is in SKILL.md, Quality gates and QA.

## Lessons ledger

`lessons.md`, one line per finding routed to a writer, added when you route it:

```
2026-10-20 | repeat | #102 | duplicated date formatter instead of the shared one | w2 | reuse the shared helper | gate: proposed lint rule
```

Fields: date, `new` or `repeat`, PR, the finding, owner, the fix, and for a repeat the gate that will stop it next time.
