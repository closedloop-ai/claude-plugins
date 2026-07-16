---
name: verify-findings
description: Dispatch and collect the finding-verifier fleet at stage_23_verify_findings (PLN-722). Reads verify_manifest.json (written by stage_22b_verify_prepare), spawns one falsify-oriented verifier Task per to_verify[] entry with mode-specific Task scheduling (GitHub mode dispatches verifiers synchronously; local mode uses parallel background + blocking TaskOutput), skips cache_hits[], and collects outputs without retry — missing outputs degrade to pending_verification[] (and, in GitHub mode, a missing BLOCKING/HIGH verifier raises a coverage-gap signal). Invoke when the walker reaches stage_23_verify_findings. Do NOT use for the reviewer fleet (stage_20 — see the spawn-reviewers skill) or the PLN-725 singletons (stage_11/stage_15 — see the singleton-dispatch skill).
---

# Finding-Verifier Fleet Dispatch (stage_23_verify_findings)

This skill is the canonical finding-verifier dispatcher for `/code-review` at `stage_23_verify_findings`. It is split out of `commands/start.md` so the orchestration spine stays lean; the orchestrator invokes it when the walker reaches `stage_23_verify_findings`. The content below is authoritative for both `MODE=local` and `MODE=github`, with mode-specific Task scheduling: GitHub mode dispatches verifiers synchronously, while local mode preserves parallel background dispatch plus blocking `TaskOutput` collection.

---

## Verifier Fleet (stage_23_verify_findings)

This stage runs when the walker reaches `stage_23`. It implements PLN-722's finding-verification pass: each eligible finding gets an independent second opinion from a verifier agent prompted to *falsify* (not confirm) the original claim. Findings that survive land in `verified[]`; findings rejected with positive evidence land in `rejected[]` and surface in the "Dismissed Findings" section so humans can falsify the dismissal.

### Inputs

`stage_22b_verify_prepare` already wrote `<CR_DIR>/verify_manifest.json` and one input file per eligible finding at `<CR_DIR>/verifier_inputs/<finding_id>.json`. Read the manifest:

```
{
  "to_verify": [{"finding_id", "model", "input_path", "output_path", ...}, ...],
  "skipped_no_verification": [...],
  "deferred_budget": [...],
  "cache_hits": [...]
}
```

`cache_hits[]` entries have already been materialized at their `output_path`; do NOT respawn them. Only entries in `to_verify[]` need fleet dispatch.

### Spawn contract

**First branch on `MODE`.** GitHub and local runs intentionally use different Task scheduling because GitHub headless mode cannot survive outstanding background verifiers after the assistant turn ends.

**GitHub mode (`MODE=github`): dispatch synchronously.** Spawn exactly one verifier at a time and wait for its Task response before spawning the next `to_verify[]` entry. Omit `run_in_background` or set `run_in_background: false`; never set it to `true` for GitHub verifiers. Do not use `TaskOutput`, watcher files, sleep loops, polling loops, or "wait for background task" turns in GitHub verifier dispatch. Each verifier must finish, write its verdict JSON to the manifest entry's `output_path` (`<CR_DIR>/agent_verifier_<finding_id>.json`), and return before the walker dispatches the next `to_verify[]` entry. When `stage_23` completes in GitHub mode there must be no verifier task still running.

**Local mode (`MODE=local`): spawn ALL verifiers at once.** Use `run_in_background: true` on every verifier `Task`. You can spawn all agents in a single message or across a few messages.

Each spawned verifier — in either mode — uses `subagent_type: "code-review:code-review-worker"` (tool allowlist `Read`, `Write`, `Grep`, `Glob` — identical to the Reviewer Fleet's, so no permission changes are needed) and this prompt template:
```
You are the FINDING VERIFIER. Read your prompt at:
  {VERIFIER_PROMPT_PATH}

Your input file is at:
  {INPUT_PATH}

Read it for the finding to verify, the canonical output path, and the
per-output JSON shape. Write your verdict JSON to the output path the
input file specifies. Do not write anywhere else.
```
Substitute the resolved paths from the manifest entry (the verifier prompt is at `<CR_DIR>/verifier_prompt.txt`, copied by `stage_02_prep_assets`). Each input file also carries a `review_root` field (written by `stage_22b_verify_prepare` from `scope.json`); the verifier prompt tells the agent to read source under that root when it is non-empty (local PR-head worktree isolation) — no extra wiring is needed here. Set `model` to the entry's `model` field (currently uniform `sonnet`; future revisions may split by original-reviewer model for cross-model independence).

### Collection contract

- **Local collection (MANDATORY for `MODE=local`):** Call `TaskOutput` (block: true) for every spawned local background verifier before letting the walker proceed past `stage_23`. You MUST collect ALL verifiers before consolidation. In headless GitHub mode there is no asynchronous completion notification, so GitHub verifier dispatch uses the synchronous branch above instead of backgrounding and collecting with `TaskOutput`.
- A missing `agent_verifier_<finding_id>.json` is NOT a fatal error — `cmd_verify_consolidate` tags it as `pending_verification[]` so operators see what didn't get verified. In `MODE=github`, a missing verifier output for a **BLOCKING/HIGH** finding additionally raises a durable coverage-gap signal (see `cmd_verify_consolidate` / `stage_24a_verify_consolidate`) so an unverified high-severity finding cannot pass silently to an approved verdict.
- Do NOT retry verifier agents in the walker. If a verifier fails, the finding's downstream handling already covers the gap (pending) — and verifier retries would burn tokens on a finding already flagged for human review. If a verifier is re-dispatched at all, it uses the same mode branch — GitHub verifier retries are synchronous; local retries may use the local background-plus-`TaskOutput` collection contract.
- `stage_23.on_failure == "continue"`: a fleet-wide failure does NOT abort the pipeline; `verify-consolidate` and `finalize-result` produce a usable envelope even when zero verifier outputs land on disk.

### Cache hits (skip spawn)

Entries in `verify_manifest.json.cache_hits[]` are already on disk at `agent_verifier_<finding_id>.json`. Skip them. They flow into `verify-consolidate` the same way fresh fleet outputs do.

### What you do NOT do

- Do not read finding source files in the orchestrator (verifier agents read files via Read/Grep themselves).
- Do not parse `agent_verifier_*.json` in the orchestrator — `cmd_verify_consolidate` (stage_24a) reads them.
- Do not regenerate `verify_manifest.json` in the walker — `cmd_verify_prepare` (stage_22b) is the only writer.

**Headless mode warning.** In GitHub mode the review runs under headless `claude -p`, where there is NO asynchronous subagent-completion notification: when the orchestrator's assistant turn ends with no pending synchronous tool call, the process terminates immediately (`terminal_reason: "completed"`). If you background a verifier and then end your turn to "wait" for it, the run dies before `stage_24a_verify_consolidate` through `stage_30_footer` execute, so the verifier verdicts never land and any BLOCKING/HIGH finding whose verifier was outstanding ships unverified. The GitHub verifier synchronous Task calls and local-mode blocking `TaskOutput` collection are the only supported ways to keep the turn alive until verifiers finish; never substitute either with watcher files, sleep loops, polling loops, or "I'll continue when notified."
