# Orchestration state

<!-- provider-rule -->
Lines that start `> Provider` follow `../../vibe/references/provider-text.md`.
<!-- end provider-rule -->

## Layout

One fleet home per machine holds everything (default `~/fleet-orchestrator`; `FLEET_HOME` overrides it); `scripts/fleet-home.mjs` documents it. Each orchestrator chat is bound to its own program: `fleet-home.mjs start` and `resume` record the binding for the chat that runs them (one file per chat under `~/.vibe-hook-scope/fleet-binding/`), and every vibe hook and script in that chat resolves that program, in its home, with no environment variable. Two orchestrator chats can run two programs in one home at once and share its reusable files. A script given the home path works in the calling chat's program, or in `current` when the chat has none; once a program other than `current` is bound to a chat, it refuses a caller with no program of its own (`AMBIGUOUS-HOME`). Give workers the program dir.

```
<fleetHome>/
  config.env  standing-rulings.md  lessons.md  handover.md   reused by every program
  context-guard.json                                         compaction limits
  current                                                    the program of a chat or command with none bound
  programs/<slug>/
    sessions.txt  prs.txt  board.md  watcher and monitor files (codex-fleet-monitor)
    usage-readings.json         bounded latest, last-good and recent Codex and Claude reads
    sessions/<name>.json        written by fleet.sh; a remote session leaves <name>.remote.json
    prompts/<name>-<nn>-<slug>.md   every prompt sent to any worker, written before sending
    requests/  findings/  evidence/
    resume-log.md  rulings.md  attention.md  review.md
    program.json   the program's shape (no-writer, one-writer or fleet)
    plugin-version.json   the plugin version check, the operator's answer and any update
```

`fleet-home.mjs start <slug> --shape <shape>` creates a program and binds this chat to it; it reads nothing of an earlier one, and it is refused while this chat's own program is open (`close` it first). It becomes `current` only when the home has none, so another chat's program stays put. `close` unbinds the chat. A remote machine keeps its sessions under `REMOTE_FLEET_HOME` the same way, and `fleet.sh` copies each prompt there when it sends it. `fleet-home.mjs migrate` moves a flat work dir in; it refuses, in the dry run and the real run, any path collision (two sources for one target, a target that already exists), merges `lessons.md` and `standing-rulings.md` into an existing home, and undoes every step if it fails partway.

## A new chat

1. `fleet-home.mjs resume` (or `resume <slug>` for a named program): read each `READ` file in order and note its `SHAPE`. It binds this chat to the program it prints after `ACTIVE`. On `NO-ACTIVE-PROGRAM`, `start` a fresh one. On `UNBOUND`, the home's current program is bound to another chat, named with when it bound: if that chat has finished (this chat replaces it), `resume <slug> --takeover`; otherwise `start` your own. `HELD` refuses a program another chat holds and names that chat and when it bound; add `--takeover` only when that chat has finished (`TAKEOVER` names it; that chat's scripts given the home path are then refused with `TAKEN-OVER`).
2. Run the plugin version check its `PLUGIN-VERSION` line names (SKILL.md, Setup) before anything else.
   Then show the setup check block (SKILL.md, Setup) once.
3. `WATCHER-LIVE <pid>`: the previous chat still holds the watch lock; stop its watcher there (or close that chat), then arm yours.
4. Relaunch each `RELAUNCH <writer> <prompt>` Claude worker from that saved prompt; resume Codex writers through `fleet.sh`.
5. Run `fleet-home.mjs check` and fix every line before acting.
<!-- generic: units-resume -->
6. Keep the writers the board lists (`board.md`) and the open work they own.
<!-- end generic: units-resume -->
> Provider `tickets` (block `units-resume` of `fleet/state.md`)
7. Before any writer start, record each ticket's placement with `board.mjs placement` (SKILL.md, Cloud workers); the check lives in vibe-core, `lib/fleet-orchestrator/scripts/cloud-placement.mjs`, not in this plugin.

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

## Rulings

`standing-rulings.md` holds operator rulings for every program (models, review rounds, test lanes); the program's `rulings.md` holds the rest, separate from the resume log. Each entry is `- Ruling YYYY-MM-DD (operator message|AskUserQuestion|ticket: <source>): <decision>`. `fleet.sh` mirrors both to every worker host; point every worker and QA-prep prompt at them. Per-ticket rulings still go through handoff's `rulings-check.mjs`. A sequencing ruling is written only by that checker's `--record-sequencing` operation after it verifies the live blocker-to-blocked `BLOCKS` receipt; unresolved references and missing links refuse the write, and the status sweep flags later drift. Orchestrator-authored directions remain `(orchestrator)` operational notes, not entries in this file.

## Lessons ledger

`lessons.md`, one line per finding routed to a writer, added when you route it:

```
2026-10-20 | repeat | #102 | duplicated date formatter instead of the shared one | w2 | reuse the shared helper | gate: proposed lint rule
```

Fields: date, `new` or `repeat`, PR, the finding, owner, the fix, and for a repeat the gate that will stop it next time.
