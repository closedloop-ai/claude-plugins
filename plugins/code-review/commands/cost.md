---
description: Attribute the token cost of code-review runs from session transcripts — total spend, main-vs-fleet split, cost by token kind, cost by depth tier, and cost per reviewer role. Establish a baseline and measure the impact of cost-reduction changes.
argument-hint: "[--session <file.jsonl>] [--project <dir>] [--scan] [--depth deep|standard|shallow] [--baseline <file.json>] [--save <file.json>] [--json]"
---

# Code-Review Cost Report

`review_result.json`'s `telemetry` block carries no token data — the Python review pipeline never sees usage. The real numbers live only in the Claude Code session transcripts (`~/.claude/projects/<encoded-cwd>/<session>.jsonl` plus the per-session `subagents/agent-*.jsonl` fleet). This command runs a bundled analyzer over those transcripts and attributes spend.

## What it reports

- **Total / mean / median / p90** cost across the matched sessions.
- **Main orchestrator vs subagent fleet** split (the walker is typically ~65% of spend).
- **Cost by token kind** — cache read, 1h/5m cache write, output, input. Cache traffic dominates a long walker loop.
- **Cost by depth tier** — `deep` / `standard` / `shallow`, each with mean/median cost, main% split, mean turns, and mean agent count. Depth is resolved from the command variant *and* `--depth` args (a bare `/code-review:start` is `standard`; `:deep`/`:shallow` bind their tier), so this is the like-for-like axis. Pooling depths together makes the headline mean meaningless when the mix of tiers shifts.
- **Cost by reviewer role** — bug_hunter, domain_critic, premise, impact_analyzer, auditor, verifier, etc., with `$/run` so you can see ROI per agent type.
- **Top sessions by cost**, with turn count and agent count.

Costs are ESTIMATES: raw transcript token counts × public Anthropic list prices, no 1M-context premium or committed-use discount applied. The value is a consistent yardstick for measuring *relative* cost and the *delta* from a change.

## Run it

The tool is a self-contained Node bundle (Node 18+, no install):

```bash
# Scan every code-review session under ~/.claude/projects and print the report
node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/cost-report.mjs --scan

# One specific session
node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/cost-report.mjs --session ~/.claude/projects/<proj>/<session>.jsonl

# Every code-review session in one project directory
node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/cost-report.mjs --project ~/.claude/projects/<proj>
```

If `$ARGUMENTS` is non-empty, pass it through verbatim. Otherwise default to `--scan`. Run the command, then summarize the report for the operator: lead with total/mean/median, the main-vs-fleet split, the top two token-kind cost drivers, and the two highest `$/run` roles. Flag any role whose `$/run` is high relative to its findings yield as a candidate for gating or removal.

## Measuring the impact of a change (baseline → compare)

This is the measurement loop for code-review cost work:

```bash
# 1. BEFORE a change: capture a baseline aggregate as JSON.
#    Scope to one tier so the comparison is like-for-like (deep changed != standard changed).
node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/cost-report.mjs --scan --depth deep --save deep-baseline.json

# 2. ...land the change, run new reviews...

# 3. AFTER: compare current spend against the saved baseline
node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/cost-report.mjs --scan --depth deep --baseline deep-baseline.json
```

The comparison block prints the mean-cost delta (with direction) and the per-run cost change for every role, so a change like "remove the premise reviewer" or "cap domain critics at 3" shows up as a concrete dollar movement rather than a guess. Always pass the SAME `--depth` to the baseline and the comparison run — a deep-tier change measured against a depth-pooled baseline would be muddied by the standard/shallow mix. For an even tighter A/B, scope the "after" run to only the sessions produced after the change (e.g. `--session` on each new review, or a `--project` that contains only post-change runs) so pre-change sessions don't dilute the delta.

`--json` emits the full machine-readable aggregate (per-session rows included) for archiving or feeding another tool.

## Maintenance

Sources live OUTSIDE the plugin at `tools/code-review-cost/src/` (vitest-tested). After editing them, rebuild the committed bundle with `npm run build` from `tools/code-review-cost/` and commit `plugins/code-review/scripts/dist/cost-report.mjs`. CI fails on a stale bundle.
