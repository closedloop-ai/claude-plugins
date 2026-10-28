# Spec Card

The Spec Card is the session's one structured statement of what the ticket
asks for, what is assumed, what is still open and the smallest change that
meets it. It merges what the requirements worker returns and what the writer
plans before code into one record, so the same facts are not restated in a
brief, a plan and a table. This file is the one canonical statement of the
card, the fork checkpoint, the file justification check, the freshness check
and the evidence matrix. The skills and workers point here. Every rule below is
enforced by a script (`scripts/spec-card.mjs`, `scripts/freshness.mjs`,
`../handoff/scripts/criteria-audit.mjs`); instructions alone changed nothing in
replay, so a rule without its script is not in force.

The card does not replace the session decision table. The table stays
mandatory, full and authored only by the SAME writer before any code, for
every request (`quality-loop.md`, "Session decision table before code"). The
card seeds the table's `## Acceptance Criteria` section and its Open
Questions; it never stands in for its rows, edge cases or alignment passes.

## Where it lives and who writes it

One JSON file per session, in the session's Git metadata beside the change
log, written only by `node scripts/spec-card.mjs save --worktree <wt> --stage
draft|locked <card>` (`spec-card.mjs path --worktree <wt>` prints where). It
is never committed and never put in `/tmp`. `save` validates the card and
refuses to change a locked one except through `superseded`.

| Stage | Author | Content |
|---|---|---|
| `draft` | `vibe-requirements-worker`, returned as JSON in its result because no session exists yet; the writer saves it | `criteria`, `assumptions`, `openQuestions` |
| `locked` | the SAME writer, after owner prep and before the first line of code | adds `plan`; seeds the decision table from the card |

After `locked`, a criterion or assumption changes only through a `superseded`
entry (`{id, source}`, the source a human statement), as the table does with
`Superseded`; the card is never silently edited to agree with the code.

## Schema

```json
{
  "version": 1,
  "source": "ISS-123",
  "criteria": [
    { "id": "AC-1", "text": "exact words", "source": "ISS-123", "evidence": "test" }
  ],
  "assumptions": [
    {
      "id": "A-1",
      "text": "what is assumed",
      "tag": "grounded",
      "basis": "file, ruling or ticket line that grounds it",
      "falsifiedBy": "the observation that would show it wrong"
    },
    {
      "id": "A-2",
      "text": "what is assumed",
      "tag": "unverified",
      "productImpacting": true,
      "falsifiedBy": "the observation that would show it wrong"
    }
  ],
  "openQuestions": [
    {
      "id": "Q-1",
      "kind": "assumption",
      "assumption": "A-2",
      "question": "the decision needed",
      "options": [
        { "label": "A", "summary": "an end-to-end option" },
        { "label": "B", "summary": "another end-to-end option" }
      ],
      "recommendation": "A",
      "answer": { "text": "the human's words", "source": "who and where" }
    }
  ],
  "plan": {
    "summary": "the smallest change that meets every criterion",
    "ownerFiles": ["path/to/owner.tsx", "path/to/directory/"],
    "notTouched": [{ "path": "path/it/leaves", "reason": "why it stays" }],
    "justifications": [
      { "path": "extra/file.ts", "cites": "AC-2" },
      { "path": "other/file.ts", "requirement": "the quoted requirement", "source": "PRD-9" }
    ]
  },
  "superseded": [{ "id": "AC-1", "source": "who and where" }]
}
```

- `criteria` are the criteria `quality-loop.md`, "Acceptance criteria before
  ready" defines: quoted exactly, never invented, narrowed or strengthened,
  with the same `AC-n` ids the table and `criteria-audit.mjs` use. `evidence`
  is the intended evidence type: `test`, `script`, `screenshot` or `api-read`.
- `tag` is `grounded` only with a `basis` that traces to a human statement or
  to code read in this checkout (`quality-loop.md`, "Communication and product
  questions": text the session wrote is never a source). Anything else is
  `unverified`. Every assumption names what would falsify it.
- `productImpacting` is required on an unverified assumption: true when being
  wrong changes what a user sees, can do or is told; false when it only
  changes how the code is built.
- `kind` of a question is `assumption` (it names the unverified
  product-impacting assumption it settles in `assumption`), `product-fork` or
  `technical-fork`. `answer` is present only once a human has answered; it
  needs a `source`.
- `ownerFiles` entries ending in `/` cover every file under that directory.
- A value not known is `null` or absent; the card never carries a guessed one.

## Fork checkpoint

The card names two things that a pre-code question may stop code for, and
nothing else:

1. an unverified assumption with `productImpacting: true`, and
2. a material product fork (`product-fork`): two or three end-to-end ways to
   meet the same criteria that a user would see differently.

Each is an `openQuestions` entry with 2 to 3 options and a `recommendation`
that names one of them. An answered entry (`answer.source` present) no longer
counts. An unverified assumption that is not product-impacting never counts:
the writer proceeds, and it appears in the handoff assumptions
("Assumptions at handoff"). A `technical-fork` is not asked of the person: the
writer proceeds on its recommendation and records it as an `Engineering
decision` (`ticket-template.md`, "Engineering decisions"), with the options.

**The checkpoint is off by default (open decision, not ruled).** Whether the
pre-code question blocks code by default, or only for product-impacting
unverified items, is the owner's call (the plan's S2 decision). Until it is
made nothing changes: with the checkpoint off, `spec-card.mjs check` lists the
unanswered entries as `wouldBlock`, exits 0 for them, and the writer builds as
it does today, recording each as an assumption in the handoff. The checkpoint
switches on with `--checkpoint` or `VIBE_FORK_CHECKPOINT=1`; then `check` fills
`blocking` with the unanswered entries and exits 1, and the writer returns
`NEEDS_PERSON` for each before code. The checkpoint does not widen who may be
asked: a blocking entry goes through the six-step research order and the
necessity gate in `quality-loop.md`, "Communication and product questions"
first, and is asked once, one at a time, in `plain-words.md` terms. Under fleet
orchestration the writer returns `NEEDS_PERSON` to the orchestrator, which
finishes the research before asking. Work that does not depend on the open
entry continues while it waits.

## File justification check (diff budget)

The `locked` plan lists the files the change owns (`plan.ownerFiles`) and the
files it deliberately leaves alone (`plan.notTouched`). Requirements come
first: every criterion is met before the diff is judged small. There is no cap
on files or lines: replay of caps showed they save about one percent of lines
and every cap tested blocked required work. The check is a justification, and
it never blocks.

Every changed file outside `ownerFiles` needs a `plan.justifications` entry
that cites an acceptance criterion on the card (`cites: "AC-n"`) or a product
requirement with the source it came from (`requirement` and `source`). A file
that cites one is in scope whatever the count. A file with no citation is
reported, not removed: the writer adds the citation if a criterion or
requirement drives it, or narrows the diff if none does. The check never
removes a requirement-driven addition and never fails the change.

`node scripts/spec-card.mjs budget --card <card> --worktree <wt> --base <sha>`
prints `{blocks: false, planned, outsidePlan, cited, uncited}` and always
exits 0. The writer runs it before `DONE`, and the uncited files go to the
writer and into the handoff Assumptions field. Session artifacts under
`.closedloop-ai/` are not counted.

## Freshness

Before any claim about the current state of the code (what `main` does, that a
file is unchanged, that a failure also happens on main), run
`node scripts/freshness.mjs --worktree <wt> --expect-path <wt>`. It prints the
checkout path, `HEAD`, the freshly fetched `origin/main` SHA, and how far HEAD
is ahead of and behind it. It runs the fetch itself: a cached `origin/main` is
never evidence. A fetch that fails leaves `originMain` null and exits 1, and
the claim is then stated as unverified against current main, naming the
checkout and HEAD it was made on. Quote the path and both SHAs beside the claim.

## Assumptions at handoff

The handoff's Assumptions field on the live ticket is generated from the card,
never written freehand: `node scripts/spec-card.mjs assumptions <card>
--worktree <wt> --base <sha>` prints the grounded and unverified assumptions,
what would falsify each, the questions answered and their sources, the files
deliberately not changed, and the files changed outside the plan with and
without a citation. An unverified assumption stays visibly unverified in the
ticket; handoff never upgrades it to grounded. `live-ticket-check.mjs` refuses
a Handoff section with no Assumptions line.

## Evidence matrix

Before the session is called done, each criterion maps to evidence in the file
`criteria-audit.mjs` requires as `--evidence`:
`{"rows": [{"criterion", "type", "ref", "verdict"}]}`.
`spec-card.mjs evidence-skeleton <card>` prints it with one row per criterion,
the intended `type`, and `ref` and `verdict` null for the fresh-context
reviewer to fill in. `type` is `test`, `script`, `screenshot` or `api-read`;
`ref` names the test file, the script run, the capture or the read; `verdict`
is the audit's `MET`, `PARTIAL` or `MISSED` (no other status words). A criterion
with no `MET` row of a known type and a `ref`, or with any `PARTIAL` or `MISSED`
row, blocks done. A `test` ref must name a file that exists at HEAD: a planned
test is not evidence, and the session writes tests only when the person asked
for a pull request, so a criterion whose intended test does not exist is met by
a script, screenshot or API read, or stays unmet and blocks.
