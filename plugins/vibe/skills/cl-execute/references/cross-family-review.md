# Cross-Family Review Lane

Use this reference in each coordinated `$workflow-code-review` generation from
[implementation-review-pr.md](implementation-review-pr.md). It adds one
read-only lane whose reviewer comes from the other model family, so a
generation has model diversity as well as lens diversity. The lane belongs to
the generation it runs in. It is not a generation of its own, and the
two-generation limit, the no-rerun rule, and the one fan-out per generation
stay as they are.

Adapted from the `interrogate` skill in pstack (MIT, copyright 2026 Lauren Tan).

## Reviewer Family

- Codex worker (Desktop, CLI, or App Server): the reviewer is Claude Code, run
  headless with the first command below.
- Claude Code worker: the reviewer is Codex, run through `codex exec` in its
  read-only sandbox with the second command below.

Pick the family from the harness actually running the worker, not from where
the skill files live. Record the reviewer CLI, its version, and the model it
reports.

## Packet

The lane gets the same inputs as the other lanes of its generation: the ticket
intent (ticket, acceptance criteria, applicable PRD requirement IDs), the pinned
target packet with base and head SHAs and the diff artifact, the guardrails the
worker found, and the rubric in the prompt below. Write the prompt to a
mode-0600 file under `umask 077` and record its SHA-256. The reviewer's cwd is
a detached review worktree at the pinned head SHA, created and removed under
`$workflow-code-review`'s Target Inspection Safety and Review Worktree Cleanup
rules, never the ticket worktree. It starts a fresh session with no author
transcript, which is this lane's equivalent of `fork_turns: "none"`.

In `review_generation_2` only, also copy the ticket's private decision log
(Execution step 12 in [implementation-review-pr.md](implementation-review-pr.md))
into the packet directory, record its SHA-256, and fill the prompt's decision-log
line. The lane then also flags decisions logged with weak or absent evidence
and verification claimed without proof. The worker reports those flags, with
the reviewer's model, in the `Attention` result field. This adds a question to
the existing lane; it adds no lane and no generation.

## Commands

Both commands were verified with Claude Code 2.1.283 and codex-cli 0.158.0,
including a probe in which the reviewer tried to create a file and run `touch`
and the worktree stayed clean. When a flag is rejected, re-check
`claude --help` or `codex exec --help`. Never drop a restricting flag to make a
call succeed.

Codex worker to Claude Code reviewer, run from the review worktree:

```sh
umask 077
claude -p --safe-mode --restricted \
  --tools "Read,Grep,Glob" \
  --disallowedTools "Bash,Edit,Write,NotebookEdit" \
  --permission-mode dontAsk --strict-mcp-config --disable-slash-commands \
  --no-session-persistence --output-format json \
  --add-dir "$PACKET_DIR" \
  < "$PACKET_DIR/prompt.md" > "$PACKET_DIR/claude-review.json"
```

- `--tools` leaves only the three read tools, so the reviewer has no shell,
  edit, or delegation tool. `--safe-mode` and `--restricted` skip hooks,
  plugins, user settings, and CLAUDE.md discovery; without them, plugin hooks
  write session files into the cwd. `--strict-mcp-config` with no
  `--mcp-config` loads no MCP server.
- `--restricted` confines file reads to the cwd, so `--add-dir` names the
  packet directory that holds the diff artifact.
- Success is exit 0 with `"is_error": false`. The review text is the `result`
  field; record the model from `modelUsage`.

Claude Code worker to Codex reviewer:

```sh
umask 077
codex exec --ignore-user-config --ignore-rules --ephemeral \
  --sandbox read-only \
  --disable apps --disable plugins --disable hooks --disable memories \
  --disable multi_agent --disable goals \
  --disable browser_use --disable computer_use --disable image_generation \
  -c web_search=disabled \
  -m gpt-6-sol -c model_reasoning_effort=high \
  -C "$REVIEW_WORKTREE" -o "$PACKET_DIR/codex-review.md" \
  - < "$PACKET_DIR/prompt.md" > "$PACKET_DIR/codex-review.log" 2>&1
```

- `--sandbox read-only` makes both shell writes and patch writes fail.
  `--ignore-user-config` is required: the user config sets a full-access
  sandbox and pre-approves ClosedLoop MCP write tools. Disabling `apps` removes
  the account connectors (GitHub, Slack, documents), which load even without
  the user config.
- `-` reads the prompt from stdin and `-o` writes the final message.
- `gpt-6-sol` at `high` is the correctness-sensitive review role from
  [support-lanes-and-sweeps.md](support-lanes-and-sweeps.md).

Keep the full review in the result file, hash it, and report only compact
status, result path, SHA-256, and byte count to the generation, like any other
lane.

## Sandbox Limits And Fallback

The other-family CLI needs network access and its own stored login. Codex App
Server ticket workers run with full access, so the Claude Code call works
there. From a Codex shell under a `workspace-write` or `read-only` sandbox it
does not: the verified result is exit 1 with `"is_error": true` and the result
text `Not logged in`. A Claude Code worker whose shell sandbox blocks network
hits the same wall when it calls `codex exec`.

The lane is unavailable when the CLI is missing or not logged in, network is
blocked, a restricting flag is rejected, the call exits non-zero or reports
`is_error: true`, or no result arrives within a bounded timeout the worker sets
and records. Then:

1. Rerun it once where the harness grants network for that single command
   through an approved escalation, if one exists. Do not loosen any read-only
   flag.
2. Otherwise run the same packet through a same-family read-only lane (on
   Codex, a `spawn_agent` support lane with `fork_turns: "none"` and
   `gpt-6-sol` at `high`; on Claude Code, the harness's own read-only review
   lane). Record `Cross-family review: unavailable` with the exact command,
   exit code, and error, plus the fallback lane id.

Never skip the lane silently, never report a same-family fallback as
cross-family, and never let the fallback add a generation.

## Reviewer Prompt

Fill in this shape:

```text
You are an adversarial code reviewer from a different model family than the
author. You did not write this change. Find real problems; do not praise it.
Take the stated intent as correct and attack the execution.

Intent: <ticket, acceptance criteria, PRD requirement IDs>
Target: <repo, base SHA, head SHA, diff artifact path and SHA-256>
Guardrails: <AGENTS.md and repo rules the worker found>

Apply the review lenses that fit the change: approach and ownership,
correctness and regressions, guardrails and validation, contracts and
compatibility, database and migrations, security, and user-flow tests. Trace a
suspected bug through its call chain instead of asserting it. Ask whether the
change fixes the root cause or hides a symptom, whether the tests would fail if
the change were reverted, and what happens on error, retry, and partial
failure. Ask what happens if this runs twice or crashes halfway, whether shared
state is serialized by structure (locks, ownership, ordering) or by a
convention someone must remember, and whether the code and tests check the
real artifact or a proxy such as a cached value, a file mtime, or a
self-report.

Decision log (review_generation_2 only): <packet path and SHA-256, or none>.
When present, also flag rows whose decision rests on weak or absent evidence,
verification claimed without proof, and forks that look risky in hindsight,
citing each row's timestamp.

You are read-only. Do not edit files, run mutating commands, delegate, or
contact anyone. For each finding give severity (critical, warning, or nit),
location (file:line), the problem, the evidence, and an optional fix. Zero
findings is a valid answer.
```

## Triage

The ticket worker triages this lane's findings with the rest of the generation
under Required Review step 6 in
[implementation-review-pr.md](implementation-review-pr.md). Its four
categories correspond to the Act on, Consider, Noted, and Dismissed buckets of
the source skill; use the cl-execute names, not a second label set. The
reviewer never edits code; every fix is the ticket worker's.
