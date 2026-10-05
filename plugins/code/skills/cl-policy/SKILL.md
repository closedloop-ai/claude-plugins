---
name: cl-policy
description: Shared ClosedLoop access and routing policy for local ClosedLoop automation skills. Use when cl-analyze, cl-split, cl-sweep, or cl-execute needs to discover ClosedLoop tools, select a safe MCP/CLI/API access fallback, resolve product contacts or engineering attention contacts, apply comment tagging and first-person communication rules, load local overrides, or interpret legacy personal-name memory fields.
---

# CL Policy

## Purpose

Provide the shared local access and routing policy for ClosedLoop ticket automation. This skill keeps team-specific names, communication rules, and tool-access fallbacks out of the execution skills, while allowing the skill pack to be shared with either a populated bundled policy or a local machine override.

## ClosedLoop Tool Access

When ClosedLoop tools are absent from the initial tool list, do not conclude
that ClosedLoop or its MCP server is unavailable.

1. Use dynamic tool discovery or `tool_search` first when the current host
   explicitly supports dynamic calls. Search by capability, such as
   `ClosedLoop get document`, `list document comments`, `document versions`,
   or `document relationships`. Codex CLI's TUI does not currently execute
   dynamic tool calls: in that surface, use statically exposed MCP tools or the
   CLI/API fallback below and never emit a dynamic tool call merely because a
   skill says to discover by capability.
2. Do not hardcode an MCP prefix such as `mcp__closedloop`. The prefix depends
   on the user's configured MCP server name and may legitimately differ.
3. If dynamic discovery is unavailable or cannot see the configured server,
   try the user's Codex CLI MCP configuration before declaring an access
   blocker.
4. If MCP access is still unavailable and `CLOSEDLOOP_API_KEY` is present, use
   the production ClosedLoop API directly. Load the key silently from the
   current environment or the user's shell profile; never print, echo, log,
   serialize, or include it in command output, memory, prompts, or reports.
5. Prefer read-only API requests during analysis. Resolve endpoint and payload
   contracts from current repository routes or official current documentation
   instead of guessing. A ticket slug can be read through
   `GET https://api.closedloop.ai/documents/<slug>` in the current platform.
6. Treat an inactive localhost MCP URL, a missing initial registration, or a
   stale read-only intelligence index as an access-path issue, not proof of a
   ClosedLoop outage. Continue through the next valid fallback and state which
   source established live state.
7. Report a genuine access blocker only after applicable discovery, Codex CLI
   MCP, and authenticated API paths have been exhausted or are unavailable.
8. For ticket intelligence, discover the read-only `closedloop-graph` MCP by
   capability rather than by configured server name, using only discovery
   mechanisms supported by the current host.
   Treat it as the preferred indexed discovery surface for bounded PRD/plan/
   split lineage, dependencies, semantic matches, duplicates, related tickets,
   and PR overlap, and for codebase intelligence including symbols, files,
   ownership boundaries, dependencies, call/data paths, co-change history,
   tests, and blast radius. Its results are not live authority: re-fetch
   material documents, relationships, comments, and status from ClosedLoop and
   verify code/PR claims against current repository and GitHub state.

### TUI And App Server Compatibility

- In Codex CLI TUI sessions, do not invoke dynamically discovered tools. The
  TUI reports `Dynamic tool calls are not available in TUI yet` and the call
  cannot complete.
- Treat an already exposed MCP tool as capability-discovered by its description;
  do not rediscover it dynamically. When the required MCP is not statically
  exposed, use `codex mcp`/configured CLI access or the authenticated API
  fallback instead.
- Inter-thread operations in CLI sweeps use the managed App Server session
  helper. Do not dynamically invoke `codex_app` or `send_message_to_thread`
  from the TUI. Desktop may use its statically available thread tools.

## Required Reference

Before making, recommending, or recording blocker communications:

1. Read `references/local-policy.md` when it exists.
2. If `references/local-policy.md` is absent, read `references/local-policy.example.md` to understand the required shape, then read `$HOME/.closedloop-ai/local-policy.md` as the populated local policy.
3. If both `references/local-policy.md` and `$HOME/.closedloop-ai/local-policy.md` exist, read the bundled policy first and the home-directory policy second as a user-local override.
4. If no populated policy file exists, stop before posting blocker comments, sending direct messages, or launching routing-sensitive automation. Ask the user to create either `references/local-policy.md` in the shared skill pack or `$HOME/.closedloop-ai/local-policy.md`.
5. Do not use `references/local-policy.example.md` as a live routing policy unless the user explicitly says the example values are the real policy for this environment.

## Direct User Authority And Decision Deduplication

- Treat the newest direct user instruction for an exact named ticket as current
  authority over older ticket comments, workflow memory, analysis results, or
  blocker records. Re-fetch live safety and requirements facts, but never make
  the user repeat an unchanged approval because a stale record says it is
  missing.
- Accept natural-language equivalence; never require a magic phrase. In the
  context of a known `HIGH` atomic ticket, instructions such as “proceed with
  ISS-1234, do not split it,” “work this ticket as one PR,” or an explicit
  correction that approval was already granted constitute the exact-ticket
  high-complexity atomic execution override. The user need not repeat the words
  `HIGH`, `risk`, `override`, or a prescribed sentence. A generic project sweep,
  assignment, priority, or “keep making progress” remains insufficient.
- Once an override is accepted, persist it in workflow memory and the ticket
  record, query/read it back, and pass it to every later analysis/execution
  gate. Ask again only when the proposed implementation has materially expanded
  beyond the authorized atomic shape or newly becomes `EXTREME`; name that
  concrete delta instead of asking for the old approval again.
- Treat a direct user ownership statement as routing authority. When the user
  says they created/own a ticket to fix a technical limitation, classify
  remaining interface, compatibility, versioning, chunking, validation, or
  fixture choices as engineering decisions unless they genuinely change
  unresolved product behavior. Ticket text containing “Product Questions” or
  a stale Product-tagged comment does not by itself make the ticket a Product
  blocker. Explain unresolved engineering choices in plain language to the
  user; do not tag the Product contact unless an independently actionable
  product decision remains.

## Company-Visible Comment Boundary

Treat every ClosedLoop ticket comment as a company-visible product record.
Automatic engineering or operational comments are forbidden. Keep complexity,
risk, split/execution overrides, credentials/access, local environment, account
identity, worker/session/generation/lease/worktree, callback/review/CI mechanics,
internal scheduling, automation failures, workflow-memory state, and manual-
intervention details in private sweep artifacts and the invoking Codex thread.

Post a comment automatically only for a genuine unresolved Product decision
that requires the policy Product contact. Limit it to product behavior, user
impact, and the minimum evidence needed to answer the question; exclude all
internal automation and access details. Any engineering, operational,
recordkeeping, split, or status comment requires an explicit user request for
that exact comment on that exact ticket. A sweep invocation, assignment,
blocker route, deleted historical comment, or worker recommendation is not
authorization. Never recreate a comment the user removed.

## Terms

- `Product contact`: the ClosedLoop user tag for product blockers.
- `Engineering attention contact`: the authenticated or invoking user who should review engineering blockers, high complexity, extreme risk, duplicates, malformed automation results, communication failures, or manual-intervention issues.
- `Sweep owner`: the authenticated ClosedLoop user whose assigned tickets are being swept.

## Usage

ClosedLoop automation skills should load this policy at the start of routing-sensitive work and use the policy terms in outputs and memory records. Do not hardcode the engineering attention contact's personal name in skill instructions, structured schemas, or memory field names.

For a shareable zip, include `references/local-policy.example.md`. Include `references/local-policy.md` only when the recipient should inherit that populated team policy.
