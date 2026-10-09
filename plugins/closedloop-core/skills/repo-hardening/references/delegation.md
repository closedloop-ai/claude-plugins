# Delegation and verification patterns

## You own every subagent's work

Review the diff or the notes and write your own summary. Never pass a subagent's report through. Judge progress by side effects (files written, commits, outputs), never by an agent's say-so.

## The brief is the product

A vague brief fails quietly because a worker cannot ask you a question. Every brief carries: GOAL, SCOPE (including what to leave alone), CONTEXT as file pointers rather than inlined content, ACCEPTANCE (a falsifiable done check), VERIFY (how the worker proves it), TIMEBOX, FORBIDDEN, and REPORT (the exact shape of the reply). A spawn with a missing field is not sent.

Fresh subagent by default, with consolidated scope: the original brief, every later directive, and any prior report. Resume an existing agent only when it holds state that is costly to move (a checkout with uncommitted changes, a running process). Resuming through interrupts silently drops directives.

## Context-window discipline

Bulk goes to subagents: long files, logs, traces, transcripts, wide searches. The main thread receives pointers, counts, and short findings. Cap files per phase and set turn budgets. Keep content needed on every run inline; keep rarely needed content in references.

## Independent verification

The agent that judges a change is never the one that wrote it. For anything that lands unattended, or any claim you want to trust, hand the artifact to a fresh subagent with no authoring history, or to a second model family if the harness offers one, with the acceptance check and nothing else. Verdicts are one of VERIFIED, NOT VERIFIED, INCONCLUSIVE. Inconclusive is not a pass. A green CI run and an approving bot review are inputs to a verdict, not verdicts. Bind a verdict to the exact commit it judged; a rebase voids it.

## Panels and arenas

Adversarial review: give the same diff and the same prompt to two or more independent reviewers (different model families when available, otherwise fresh contexts). Signal comes from independence, not personas. A finding two reviewers raise independently is high confidence. The lead categorizes every finding into Act on, Consider, Noted, Dismissed, each with a one-line reason, and shows the dismissed list. More than five items under Act on usually means weak filtering. Reviewers trace execution paths; "could be nil" without a call chain is not a finding.

Design or implementation bakeoff: give N workers the same task and a withheld rubric of three to six gradeable criteria. Separate output paths per worker. One read-only judge scores per criterion by label. The lead reads every candidate, scores per criterion, picks a base, grafts the best parts of the others by hand, and verifies. Convergence is agreement; wild divergence means the task was under-specified, so reframe and rerun rather than average.

Exploration: cheap, parallel read-only explorers partition the search and return pointers; one synthesizer resolves contradictions by checking the code. Point adversarial review at code, not abstract plans; reviewers of a plan with no code invent risks.

## Evidence tiers

For investigations, label every claim: Direct (the author wrote why, cited), Supported (independent evidence converges), Inferred (hedged), Speculative (competing hypotheses listed), Unknown (what was searched). Plans and replies compress these to measured (Direct or Supported), inferred, and guess. Code is not evidence of its own intent. A contradiction among sources is the most interesting finding, not noise to smooth over.

Blast-radius ladder for a safety claim: 1 you said so; 2 pointed at `file:line`; 3 walked the failure path and showed it cannot reach; 4 ran a script or test against real code that fails loud; 5 reproduced in the running app. Report where each fact stopped.

## Autonomy

Proceed on reversible work. Pause for irreversible writes: force-pushes to shared branches, deploys, data deletion, messages to people outside the session. If a fork could be settled by running something, run it. Reserve questions for product or preference calls. Say no when a request does not earn its place.

## Decision trail for long runs

For unattended or multi-hour work keep an append-only log, one row per decision: time, phase, decision, why, evidence pointer, result. Wrong calls are superseded by new rows, never edited. At the end, audit the log against what happened and correct the log, not the story. Keep it local unless the reviewer needs it committed.
