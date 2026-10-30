---
name: vibe-bench
description: Run the repository's on-demand local Claude Code benchmark or operate its local nightly eval baseline.
---

# Vibe benchmark

Use this skill only on a developer machine. Never start a paid eval or benchmark for a pull request, never add one to CI, and never publish paid evidence into a pull request body.

## On-demand start-to-PR benchmark

1. Confirm the request is explicitly for the on-demand benchmark. It is a local diagnostic, not a pull request gate.
2. Resolve the latest accepted nightly eval baseline. Use its claude-plugins SHA as the benchmark baseline. Refuse when no accepted nightly exists.
3. Run the benchmark only under Claude Code with `claude-sonnet-5-5` at effort `high`. Agent frontmatter may select another model for that agent, and the result must record it. The harness rejects any root or subagent model mismatch and keeps the normal Claude credential store available while isolating settings.
4. Use one isolated seeded web stack and one local MCP server for all six samples: three vibe and three fleet-orchestrator in three balanced paired waves. Keep setup outside the model execution budget, record setup separately, and target less than ten minutes for the full measured batch.
5. Every proof pull request is a draft with `DO NOT MERGE` in its title and a body that says it is benchmark evidence. The harness closes every proof pull request and deletes every owned proof ref on success, failure, timeout, or interrupt.
6. Report wall time, cost, tokens, calls, model and effort, cleanup, and component, skill, worker, and phase breakdowns. Yellow and red signals require a concrete local explanation. Never apply a bypass or acceptance label.

## Nightly eval baseline

The nightly is the only routine model-driven eval. It runs from a dedicated clean `main` checkout on the scheduled local host, never from a worker worktree and never in CI.

1. Fetch and fast-forward to `origin/main`, then require a clean `main` checkout at that exact commit.
2. Compare paths since the latest accepted baseline with the shared behavior classifier. Skip without a model call when only README, changelog, unreferenced docs, eval, test, benchmark-infrastructure, or version-only manifest files changed. A semantic manifest change or runtime-referenced document is behavior. An unknown new path in `plugins/vibe` fails closed and triggers.
3. On a change-day, run the full corpus once on Claude Code and Codex. Claude uses `claude-sonnet-5-5` as the agent and `claude-opus-5-5` as the judge. Codex uses the full agent and judge IDs in source policy. Rerun only failing cases, at most twice. Cases added or changed are recorded and are not compared with older content.
4. Advance the accepted baseline only through this nightly. Baseline lineages are keyed by all agent and judge model IDs. A model change starts a new lineage without comparison or Slack delivery that night. Reliability history, must-pass status, quarantine owner, and quarantine deadline remain in the stored artifact. Three successful observations are required, so the first regression alert in a new lineage can occur on its fourth change-day nightly.
5. When a reliable unchanged case still fails after its retries, write the regression report and post exactly one message to `#vibe`. Name the cases, runtimes, merged pull requests since the last green nightly with their authors, any direct commits with their authors, the quarantine owner, and the durable result artifact. An expired quarantine entry does not stop the run: its case becomes gating and the same Slack alert names the entry and owner. Send nothing on a clean or skipped night with no expiry.
6. Record Claude agent cost, Claude judge cost, and their total separately. Read `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` only from the scheduler's private environment file. Never commit, print, copy, or pass either credential to a model or grader process. Missing credentials, binaries, incomplete attribution, and failed Slack posts must produce a clear job-log line and one infrastructure Slack post when delivery is possible. Retry a pending delivery before any later paid work.

The start-to-PR benchmark baseline is tied to the latest accepted nightly, not to plugin versions. There is no release mode, promotion command, per-PR eval, per-PR benchmark, PR body section, approver label, or bypass flow.

Use `node --experimental-strip-types tools/vibe-bench/src/cli.ts` when the parent repository has no workspace command. Keep all run roots and result stores outside the repository, acquire the machine's heavy slot, and report exact cleanup state.
