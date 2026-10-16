# Plan Review Prompt

The single independent plan reviewer (Planning Workflow step 20 in
[planning-and-gates.md](planning-and-gates.md)) receives the text in the fence
below verbatim. After it, append the plan's path, the ticket slug and URL, the
applicable PRD slugs, and the private path for the review file. Do not
shorten, paraphrase, or add to the prompt.

```text
Review the plan linked at the bottom.

SOURCES
- Read the plan, its parent issue, and any PRD above it. Use closedloop-graph
  for lineage, adjacent tickets, and collisions.
- Run `git fetch origin` first and reason against `origin/main`, not the local
  ref. Check whether anything that landed since the plan was written already
  did, obsoleted, or collided with part of it.
- Check the plan against the repo's AGENTS.md guardrails, especially
  cross-surface web+desktop, version-skewed contracts, the closed-by-default
  UI flag policy, and capability removal.
- Think through edge cases and unexpected behavior changes.
- Code is evidence; a comment describing code is a claim. Read the code.

DEPTH
- A plan needs to be correct at a high level, not fully detailed. Do not ask
  for detail it did not include; that review happens post-implementation.
  Detail it does include must be correct.
- The exception is coverage: a missing step is fine, a missing outcome is a
  finding.

SCOPE EXCLUSIONS (check this as hard as mechanisms)
For every item the plan puts out of scope, classify it as:
  (a) genuinely out of scope,
  (b) covered by another live ticket, cite the slug, or
  (c) a gap, nothing covers it.
Only (c) is a finding. Agents cut scope to make a plan look clean, so treat an
exclusion as unjustified until you have found the ticket that covers it.
Understand the prior history on this area of work before deciding.

MECHANISMS (check this as hard as scope exclusions)
- The requirement is the outcome the ticket asks for. A mechanism the ticket
  names is a proposal, held to the same test as one the plan invented.
- For every new mechanism (API route, table or column, cursor, poller or
  background lane, cross-process channel, writes into files another tool
  owns), name the existing mechanism that already does that job, or could,
  and why the plan does not use it. New is unjustified until existing is
  ruled out with evidence; reuse a connection before opening one.
- Cost: fleet size is unknown and growing, so never argue from a device
  count. Judge by what steady-state cost scales with (idle installs,
  connected clients, active sessions, events) at 10x and 100x, and by
  per-device idle cost (timer wakeups, network, disk while nothing is
  active; laptops on battery). Zero idle cost is the baseline; cost that
  scales with idle clients is blocking unless no activity-scaled design
  meets the outcome.
- One-way doors (a new data direction between surfaces, a contract installed
  clients will depend on, a write into another tool's data) need a cited
  human decision; without one, list a human decision item.

DECISIONS
- A "Decisions" section in a ticket or plan is a record, not a ruling. For
  each, find who made it, where, and which question it answered; no
  traceable human statement means unratified.
- A newer ticket does not supersede an earlier explicit ruling by naming a
  different mechanism; only a statement addressing that ruling does. When
  records disagree, report the conflict; never resolve it by recency.
- A human decision item about a mechanism, consent, or an unratified or
  conflicting decision is neither instruction inflation nor manufactured
  ambiguity: those rules protect settled rulings, and this is not settled.
  If the plan cites either rule to avoid a question, say so.

SUBAGENTS
- Use workers from your own harness, and give every worker a name, or keep
  its id, so you can reach it again later.
  - Claude Code: use general-purpose or Explore workers and set model sonnet
    or opus explicitly. The specialist reviewer agents cannot call MCP tools,
    so route anything needing closedloop-graph to a worker that has them, and
    tell workers to load the tools with ToolSearch first.
  - Codex: use same-family `spawn_agent` workers with `fork_turns: "none"`
    and `model: "gpt-6-sol"` at `high` or `xhigh`. They inherit no
    conversation, so give each one the plan path, these sources, and its
    question.
  - When you run as a support lane, which never delegates, do the workers'
    reads yourself.
- You own the conclusions. Verify load-bearing worker claims against primary
  sources (files, git history, ticket records) before repeating them.
- When a claim does not hold up, message that worker by name or id (Claude
  Code: SendMessage; Codex: `send_input`) with the specific objection and
  what would settle it, instead of spawning a fresh agent. A named worker
  resumes with its context, so a correction costs one follow-up turn rather
  than a whole re-exploration. Repeat until the claim is proven or withdrawn.
- Workers: if you find something that changes what the rest of the review
  should look at (the plan's premise already landed on main, the ticket it
  defers to is closed, the file it targets no longer exists), tell the
  reviewer immediately (Claude Code: SendMessage "main"; Codex: end your turn
  with it first). Otherwise report once, at the end.
- No progress chatter, no "are you done" messages, no polling ListAgents or
  worker status.

CERTAINTY
- Resolve every question you can from the repo, the history, and
  closedloop-graph. If one is genuinely unanswerable there (a product decision,
  an unstated intent), state it as an open question with what you checked and
  what would settle it. Do not turn an unresolved question into a confident
  claim, and do not decide a product question yourself.
- A blocking finding cites the file and line, commit, or ticket record you
  read yourself; a worker summary or code comment is not that.

OUTPUT
- Write the review to <plan-slug>-review.md, mode 0600, in the private
  directory named at the bottom (never the repository or a shared temp
  directory), print the path, and summarize the blocking findings in your
  reply.
- The review has these sections in this order, each present ("none" if empty):
  1. Mechanism inventory, one row per new mechanism: what it does | cost
     scales with | per-device idle cost | at 10x / 100x | existing mechanism
     considered, why rejected | verdict.
  2. Decision provenance, one row per recorded decision: decision | who |
     where | question answered | conflicts with | ratified / unratified /
     conflicting.
  3. Scope exclusions, one row each: (a), (b) with slug, or (c).
  4. Blocking findings, each with what it was verified against.
  5. Should-fix findings.
  6. HUMAN DECISIONS, numbered H1, H2, ...: the question, what you checked,
     what would settle it. The planner may not resolve, downgrade, or absorb
     these; proceeding before an answer means naming the assumption built on.
- End with a verdict: approve as-is, approve with the listed changes, or
  needs rework, then the count of open HUMAN DECISIONS. An open one rules
  out approve as-is.
- Read-only. Do not edit the plan, the issue, or any source file.
```
