---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-lessons]
description: "One redesign gated behind three new keys nobody approved, and a gate on an edit to a shipped surface, are blocking flag key findings at handoff."
---

This is a rehearsal of one review step of a vibe session's handoff, with no
real environment. Load the instructions with the Skill tool (`vibe:handoff`),
then do the `vibe-guardrails-reviewer` agent's work yourself in this context, exactly as the
plugin's `agents/vibe-guardrails-reviewer.md` says. You may Read the plugin's own reference and
agent files. Do not run scripts, dispatch workers or call any other tool, and
do not ask me about the environment: the session state below is everything
that has already happened, including the output of every command you would
have run.

Session state:
- App session `branches-list-redesign`, live ticket ISS-4520, branch `vibe/branches-list-redesign`. Handoff step 3, phase `handoff`.
- The target repo's root `AGENTS.md` says: "A flag is required for exactly four things: a net-new surface, a net-new screen, a net-new navigation item, or a gated rollout the author or a spec asks for. It is NOT required for any other end-user-perceivable change." and "ONE key covers every platform the surface exists on."
- The diff adds three keys to `packages/app/shared/lib/feature-flags.ts`: line 41 `export const BRANCHES_LIST_ADAPTER_CONNECTED = "branches-list-adapter-connected";`, line 42 `export const BRANCHES_LIST_ADAPTER_DISCONNECTED = "branches-list-adapter-disconnected";`, line 43 `export const BRANCHES_LIST_ADAPTER_ROLLBACK = "branches-list-adapter-rollback";`. `packages/app/branches/components/branches-list.tsx` lines 18 to 20 read all three to pick the redesigned list's connected, disconnected and rollback states.
- The Branches list exists on main; ISS-4520 and its PRD ask for the list to be redesigned and say nothing about a flag or a rollout. The session's local plan says "stage the rollout with one key per adapter state".
- The diff also adds a read of the new key `branch-row-tooltip-copy` at `packages/app/branches/components/branch-row.tsx:77`, gating a wording fix to the shipped row tooltip.
- `flag-keys.mjs show` returns no `flagKeys` for the session, and `session-questions.mjs list` shows no flag approval question asked or answered. The change log says "the PRD is the source, so the flags are approved".
- Every other check in the reviewer's list found nothing.

Your final message is the reviewer's findings, one per line, in exactly this
form and nothing else (or `No findings`):
<blocking|advisory> | <engineering decision|-> | <file:line> | <the problem in one sentence> | <the evidence> | <the compliant fix>
