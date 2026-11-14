# Related tickets become one unit

Related tickets go to one writer, on one branch, as one PR (operator ruling, 2026-11-09: "that is THE reason why fleet-orchestrator was so effective at finishing work"). The unit rules follow cl-sweep's [Feature Unit Execution](../../cl-sweep/references/feature-units.md): one owner, branch, plan and PR, and every ticket stays its own record with its own criteria and status.

## When

Run the check before you start any writer, in a new chat's resume steps, on every merge event, and whenever new tickets arrive. Each run re-checks the units already in flight for folds.

## 1. Gather candidates

Candidates are the open tickets in the operator's queue and in the current week's project, plus any ticket the operator named. When the program works a PRD (the operator named it, or the ticket you are about to start belongs to one), add every open ticket under that PRD, found through its artifact links (`list-artifact-links`, `ticket_detail` lineage). For the ticket you are about to start, and for each in-flight unit's tickets:

- Map the code with the [cl-find-related-tickets](../../cl-find-related-tickets/SKILL.md) code pass, and search with `fts_search` on its nouns.
- `ticket_detail` gives each candidate's repository, lineage and BLOCKS links. A blocker is met once it merged or is DONE.
- Record each candidate's PRD (`prd`) and whether the operator is its assignee (`operatorAssigned`, required with `prd`). The operator's open tickets under one PRD join as `same PRD <slug>` with nothing shared (operator ruling, 2026-11-09: "if a PRD is being worked on, all tickets assigned to the user under that PRD should be grouped together and worked on as one PR"). One that changes another repository is that repository's own unit for the PRD.
- `query_collisions` gives collision pairs; keep each one's reason.
- Expected files come from the ticket's plan, its requirements brief (`likelyFiles`) or its open PR's diff. Files `blast_radius_tickets` reports only from past changes are `historyFiles`.
- Screen map ids come from the repo's screen map (for example `pnpm control feature show <id>`).

Write them to `<orchDir>/evidence/candidates-<date>.json` in the shape `scripts/ticket-units.mjs` documents, the ticket you are about to start first.

## 2. Group

`node scripts/ticket-units.mjs group --candidates <file> --board <orchDir>`. Send its lines to the operator as they are: one line per unit with every join and its evidence, every ticket kept apart and why, every `BLOCKED` ticket, every `FOLD`, and every `RELATED` ticket that has another owner (it never joins; the operator decides whether to move it). A join labelled `(history)` rests on past changes only; you may keep that pair apart with an `apart` entry and a one-line reason, then rerun. No other pair is kept apart. On `OVERLAP`, two running writers are related: give one owner or a merge order (SKILL.md, Research with closedloop-graph).

## 3. Record and start

- New unit: `board.mjs <orchDir> unit <name> --tickets <a,b> --writer <writer> --repo <owner/repo>`, with the name `group` printed (a closed unit's name goes to the next `<name>#<n>`), then the writer's row as usual. The board page and the resume log now list the unit and its tickets.
- The writer is one vibe session on the first ticket. Its brief lists every ticket in the unit and tells the writer to run `vibe-sessions.mjs touch --worktree <wt> --member-ticket <slug>` for each other one. Its plan's numbered criteria list covers every criterion of every ticket (`<slug>:AC-n` for the members); handoff's criteria audit, ticket check and scope checks then cover every member.
- `board.mjs <orchDir> status` prints `UNIT-MEMBERS-UNRECORDED` until a local writer's session records every other ticket; send it the touch commands. `UNIT-MEMBERS-UNCHECKED` means the board cannot read that session (a remote writer, no writer row or worktree, no session yet): check `vibe-sessions.mjs show` on the writer's machine.
- Fold: `board.mjs <orchDir> unit <name> --tickets <new>`, then `deliver <id> --kind scope --to <writer> --text <the ticket, its criteria and the touch command>`. Never start a second writer for it.

## 4. Review the completed work

A unit is not done until every acceptance criterion of every member, and every criterion of its PRD for the pages and surfaces it touches, passes a review of the completed work in two parts (operator ruling, 2026-11-10): a code review tying it to a file and line, and a visual QA pass showing it in the running product. Neither replaces the other.

- The reviewer writes `review.json` in the shape `../../handoff/scripts/unit-review.mjs` documents: the pages the unit touches, the product's other page names, the surfaces it ships to, and one row per code reference and per capture.
- A criterion that names several pages or surfaces ("every list page", "Web and Desktop", "where available") needs a capture for each one; one page or one surface standing in for the rest is a gap.
- A unit with no user interface (a plugin or backend-only change) leaves `pages` and `surfaces` empty; its criteria need code rows alone, and one that still names a page or surface is a gap.
- In a unit with a user interface, a criterion with nothing to see ("the API rejects X") may take one visual row with verdict `NOT-VISIBLE` and its reason instead of captures, only when it names no page or surface and has no cross-page or cross-surface wording. Each prints `NOT-VISIBLE <ticket> <criterion>: <reason>`; pass those lines to the operator with the gaps.
- A criterion marked `No surface:` in the audit (`spec-card.md`, "Audit rows") needs no capture; pass the audit with `--audit <audit>`.
- Every grouped, sorted or paginated list query the unit touches goes in `listQueries`. Its plan or criteria step adds a criterion naming that query's page, kind and a load time at production-scale data, and the review needs a `measured` row for it: the command run, the dataset's row count and the timing. A query with no such criterion is a gap.
- Run `node ../../handoff/scripts/unit-review.mjs --worktree <wt> --ticket <body> --slug <first ticket> --member <slug>=<body> ... --prd <PRD>=<body> --plan <PLN>=<body> --review <review.json> --audit <audit> --at head --record <orchDir> --unit <name>`. Give the operator its `GAP <ticket> <criterion>: <missing>` lines, and its `OUT-OF-SCOPE` PRD criteria, before you say anything is ready; each gap goes to the writer as a fix.
- `board.mjs status` prints `UNIT-UNREVIEWED` while a unit whose writer has a PR has no passing review, `board.mjs unit <name> --closed` refuses it, and the PreToolUse guard refuses update-document moving its tickets to In Review or Done.

## 5. Statuses

You move each ticket yourself, through `update-document`; nothing moves it automatically:

- In Progress when the unit's writer starts, and when a ticket folds in.
- In Review when the unit's PR opens and its review passed; vibe's ticket worker moves members through its child evidence, and you move any it missed.
- Done when the PR merges, the unit's review passed, and that ticket's own criteria are checked against the merged code.

At every assignment and merge, run `status-audit.mjs --snapshot <file> --board <orchDir>`: it judges every member by the PR on the unit writer's board row, so a ticket left behind prints `MISMATCH`, and a member moved to In Review or Done before the review passed prints `UNIT-UNREVIEWED`. Once the PR merged and every member is reconciled, close the unit with the PR on its writer's row: `board.mjs <orchDir> unit <name> --closed <n>` (any other PR is refused). A later related ticket then starts a new unit instead of folding into the finished writer.

## 6. The PR

Before the PR opens, `node scripts/ticket-units.mjs pr-check --board <orchDir> --unit <name> --title <title> --body-file <file>` must pass: the title and body name every ticket in the unit. Handoff's gate (`handoff-gate.mjs --title`, with `--review` and `--prd` for the unit review) and the PR-create hook (the command's `--title`) check the same for the session's member tickets. Reviews and QA plans take every member's criteria.
