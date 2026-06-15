---
name: verify-findings
description: Dispatch and collect the finding-verifier fleet at stage_23_verify_findings (PLN-722). Reads verify_manifest.json (written by stage_22b_verify_prepare), spawns one falsify-oriented verifier Task per to_verify[] entry, skips cache_hits[], and collects outputs without retry — missing outputs degrade to pending_verification[]. Invoke when the walker reaches stage_23_verify_findings. Do NOT use for the reviewer fleet (stage_20 — see the spawn-reviewers skill) or the PLN-725 singletons (stage_11/stage_15 — see the singleton-dispatch skill).
---

# Finding-Verifier Fleet Dispatch (stage_23_verify_findings)

This skill is the canonical finding-verifier dispatcher for `/code-review` at `stage_23_verify_findings`. It is split out of `commands/start.md` so the orchestration spine stays lean; the orchestrator invokes it when the walker reaches `stage_23_verify_findings`. The content below is relocated verbatim from `start.md`.

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

For each entry in `verify_manifest.json.to_verify[]`:

1. Spawn one background `Task` with `subagent_type: "code-review:code-review-worker"`. The agent's tool allowlist (`Read`, `Write`, `Grep`, `Glob`) is identical to the Reviewer Fleet's — no permission changes needed.
2. Prompt template:
   ```
   You are the FINDING VERIFIER. Read your prompt at:
     {VERIFIER_PROMPT_PATH}

   Your input file is at:
     {INPUT_PATH}

   Read it for the finding to verify, the canonical output path, and the
   per-output JSON shape. Write your verdict JSON to the output path the
   input file specifies. Do not write anywhere else.
   ```
   Substitute the resolved paths from the manifest entry (the verifier prompt is at `<CR_DIR>/verifier_prompt.txt`, copied by `stage_02_prep_assets`). Each input file also carries a `review_root` field (written by `stage_22b_verify_prepare` from `scope.json`); the verifier prompt tells the agent to read source under that root when it is non-empty (local PR-head worktree isolation) — no extra wiring is needed here.
3. Set `model` to the entry's `model` field (currently uniform `sonnet`; future revisions may split by original-reviewer model for cross-model independence).

### Collection contract

- Call `TaskOutput` (block: true) for every spawned verifier agent before letting the walker proceed past `stage_23`.
- A missing `agent_verifier_<finding_id>.json` is NOT a fatal error — `cmd_verify_consolidate` tags it as `pending_verification[]` so operators see what didn't get verified.
- Do NOT retry verifier agents in the walker. If a verifier fails, the finding's downstream handling already covers the gap (pending) — and verifier retries would burn tokens on a finding already flagged for human review.
- `stage_23.on_failure == "continue"`: a fleet-wide failure does NOT abort the pipeline; `verify-consolidate` and `finalize-result` produce a usable envelope even when zero verifier outputs land on disk.

### Cache hits (skip spawn)

Entries in `verify_manifest.json.cache_hits[]` are already on disk at `agent_verifier_<finding_id>.json`. Skip them. They flow into `verify-consolidate` the same way fresh fleet outputs do.

### What you do NOT do

- Do not read finding source files in the orchestrator (verifier agents read files via Read/Grep themselves).
- Do not parse `agent_verifier_*.json` in the orchestrator — `cmd_verify_consolidate` (stage_24a) reads them.
- Do not regenerate `verify_manifest.json` in the walker — `cmd_verify_prepare` (stage_22b) is the only writer.
