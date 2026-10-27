# Orchestration state

## Layout

One fleet home per machine holds everything (`FLEET_HOME`, default `~/fleet-orchestrator`); `scripts/fleet-home.mjs` documents it, and every script given the home works in its active program.

```
<fleetHome>/
  config.env  standing-rulings.md  lessons.md  handover.md   reused by every program
  current                                                    the active program's slug
  programs/<slug>/
    sessions.txt  prs.txt  board.md  watcher and monitor files (codex-fleet-monitor)
    sessions/<name>.json        written by fleet.sh; a remote session leaves <name>.remote.json
    prompts/<name>-<nn>-<slug>.md   every prompt sent to any worker, written before sending
    requests/  findings/  evidence/
    resume-log.md  rulings.md  attention.md  review.md
    program.json   the program's shape (no-writer, one-writer or fleet)
    plugin-version.json   the plugin version check, the operator's answer and any update
```

`fleet-home.mjs start <slug> --shape <shape>` makes a program current; it reads nothing of an earlier one. A remote machine keeps its sessions under `REMOTE_FLEET_HOME` the same way, and `fleet.sh` copies each prompt there when it sends it. `fleet-home.mjs migrate` moves a flat work dir in.

## A new chat

1. `fleet-home.mjs resume`: read each `READ` file in order and note its `SHAPE`. On `NO-ACTIVE-PROGRAM`, `start` a fresh one.
2. Run the plugin version check its `PLUGIN-VERSION` line names (SKILL.md, Setup) before anything else.
3. `WATCHER-LIVE <pid>`: the previous chat still holds the watch lock; stop its watcher there (or close that chat), then arm yours.
4. Relaunch each `RELAUNCH <writer> <prompt>` Claude worker from that saved prompt; resume Codex writers through `fleet.sh`.
5. Run `fleet-home.mjs check` and fix every line before acting.

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

## Rulings

`standing-rulings.md` holds operator rulings for every program (models, review rounds, test lanes); the program's `rulings.md` holds the rest, separate from the resume log. Each entry is `- Ruling YYYY-MM-DD (operator message|AskUserQuestion|ticket: <source>): <decision>`. `fleet.sh` mirrors both to every worker host; point every worker and QA-prep prompt at them. Per-ticket rulings still go through handoff's `rulings-check.mjs`.

## Lessons ledger

`lessons.md`, one line per finding routed to a writer, added when you route it:

```
2026-10-20 | repeat | #102 | duplicated date formatter instead of the shared one | w2 | reuse the shared helper | gate: proposed lint rule
```

Fields: date, `new` or `repeat`, PR, the finding, owner, the fix, and for a repeat the gate that will stop it next time.
