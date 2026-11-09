# Related tickets become one unit

Related tickets go to one writer, on one branch, as one PR (operator ruling, 2026-11-09: "that is THE reason why fleet-orchestrator was so effective at finishing work"). The unit rules follow cl-sweep's [Feature Unit Execution](../../cl-sweep/references/feature-units.md): one owner, branch, plan and PR, and every ticket stays its own record with its own criteria and status.

## When

Run the check before you start any writer, in a new chat's resume steps, on every merge event, and whenever new tickets arrive. Each run re-checks the units already in flight for folds.

## 1. Gather candidates

Candidates are the open tickets in the operator's queue and in the current week's project, plus any ticket the operator named. For the ticket you are about to start, and for each in-flight unit's tickets:

- Map the code with the [cl-find-related-tickets](../../cl-find-related-tickets/SKILL.md) code pass, and search with `fts_search` on its nouns.
- `ticket_detail` gives each candidate's repository, lineage and BLOCKS links. A blocker is met once it merged or is DONE.
- `query_collisions` gives collision pairs; keep each one's reason.
- Expected files come from the ticket's plan, its requirements brief (`likelyFiles`) or its open PR's diff. Files `blast_radius_tickets` reports only from past changes are `historyFiles`.
- Screen map ids come from the repo's screen map (for example `pnpm control feature show <id>`).

Write them to `<orchDir>/evidence/candidates-<date>.json` in the shape `scripts/ticket-units.mjs` documents, the ticket you are about to start first.

## 2. Group

`node scripts/ticket-units.mjs group --candidates <file> --board <orchDir>`. Send its lines to the operator as they are: one line per unit with every join and its evidence, every ticket kept apart and why, every `BLOCKED` ticket, every `FOLD`. A join labelled `(history)` rests on past changes only; you may keep that pair apart with an `apart` entry and a one-line reason, then rerun. No other pair is kept apart. On `OVERLAP`, two running writers are related: give one owner or a merge order (SKILL.md, Research with closedloop-graph).

## 3. Record and start

- New unit: `board.mjs <orchDir> unit <name> --tickets <a,b> --writer <writer> --repo <owner/repo>`, then the writer's row as usual. The board page and the resume log now list the unit and its tickets.
- The writer is one vibe session on the first ticket. Its brief lists every ticket in the unit and tells the writer to run `vibe-sessions.mjs touch --worktree <wt> --member-ticket <slug>` for each other one. Its plan's numbered criteria list covers every criterion of every ticket (`<slug>:AC-n` for the members); handoff's criteria audit, ticket check and scope checks then cover every member.
- Fold: `board.mjs <orchDir> unit <name> --tickets <new>`, then `deliver <id> --kind scope --to <writer> --text <the ticket, its criteria and the touch command>`. Never start a second writer for it.

## 4. Statuses

Each ticket moves on its own, through `update-document`:

- In Progress when the unit's writer starts, and when a ticket folds in.
- In Review when the unit's PR opens; vibe's ticket worker moves members through its child evidence, and you move any it missed.
- Done when the PR merges and that ticket's own criteria are checked against the merged code.

At every assignment and merge, run `status-audit.mjs --snapshot <file> --board <orchDir>`; every member gets the unit's PR and writer as evidence, so a ticket left behind prints `MISMATCH`.

## 5. The PR

Before the PR opens, `node scripts/ticket-units.mjs pr-check --board <orchDir> --unit <name> --title <title> --body-file <file>` must pass: the title and body name every ticket in the unit. Reviews and QA plans take every member's criteria.
