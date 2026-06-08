---
name: singleton-dispatch
description: PLN-725 single-agent dispatch for stage_11_extract_signals and stage_15_coverage_critic. After each prepare stage writes its manifest, this skill reads the status field (cache_hit / skipped / needs_agent) and, only on needs_agent, spawns one synchronous singleton Task that writes the by-convention pln725_*.json output the sibling consolidate stage consumes. Invoke from walker-contract step 6 immediately after stage_11_extract_signals or stage_15_coverage_critic finishes. Do NOT use for the reviewer fleet (stage_20 — see the spawn-reviewers skill) or the verifier fleet (stage_23 — see the verify-findings skill).
---

# PLN-725 Single-Agent Dispatch (stage_11 / stage_15)

This skill is the canonical PLN-725 single-agent dispatcher for `/code-review`. It is split out of `commands/start.md` so the orchestration spine stays lean; the orchestrator invokes it from walker-contract step 6 immediately after `stage_11_extract_signals` or `stage_15_coverage_critic` finishes. The content below is relocated verbatim from `start.md`.

---

## PLN-725 Single-Agent Dispatch

Walker contract step 6 points here. Two stages (`stage_11_extract_signals`, `stage_15_coverage_critic`) emit a manifest whose `status` field decides whether a singleton LLM agent must be spawned. This section codifies the dispatch — the same protocol applies to both stages with different paths.

### When to dispatch

After the prepare stage finishes, read its manifest:

| Stage | Manifest location |
|---|---|
| `stage_11_extract_signals` | `<CR_DIR>/extract_signals_manifest.json` |
| `stage_15_coverage_critic` | `<CR_DIR>/coverage.json` (`critic` section) |

Parse `status`:

| `status` | Action |
|---|---|
| `"cache_hit"` | **Skip dispatch.** Prepare already wrote the canonical output (`extract_signals.json` for stage_11; `coverage.json.final` for stage_15). The downstream sibling consolidate stage will no-op. |
| `"skipped"` | **Skip dispatch.** Emitted by `coverage-critic-prepare` for any of three reasons (carried in the manifest's `reason` field): `no-critic` (operator passed `--no-critic`), `no-roster` (loaded `available_reviewers.json` is empty — no project agents configured), or `no-candidates` (roster is non-empty but every reviewer is already in the initial plan — nothing left for the critic to propose). In all three, prepare wrote `coverage.json.final` with `critic_status: "skipped"`. The downstream sibling consolidate stage will no-op. |
| `"needs_agent"` | **Spawn the singleton agent below.** |

### Spawn contract

For `status: "needs_agent"`, the manifest carries the inputs the agent needs:

| Field | Use |
|---|---|
| `prompt_path` | The agent's system prompt path — pass as `{PROMPT_PATH}` below; the agent reads it itself. |
| `input_path` | The bounded input bundle (taxonomy + diff summary + AVAILABLE list / etc.) — pass as `{INPUT_PATH}`; the agent reads it itself. |
| `model` | Model tier for the dispatch (`haiku` for signal-extraction, `sonnet` for coverage-critic). |

The manifest's `output_path` / `coverage_state` field is the **canonical sibling consolidate output** (`extract_signals.json` for stage_11; `<CR_DIR>/coverage.json` — the `final` section — for stage_15), NOT where the agent writes. The agent's write target is fixed by convention:

| Stage | Agent writes to |
|---|---|
| `stage_11_extract_signals` | `<CR_DIR>/pln725_extract_signals.json` |
| `stage_15_coverage_critic` | `<CR_DIR>/pln725_coverage_critic.json` |

These paths match the `--agent-output` arg the sibling stage's `args` declare, so the consolidate cmd finds the file with no walker substitution.

Spawn one synchronous `Task` (do **not** set `run_in_background: true`). Unlike the reviewer / verifier fleets — which spawn many background tasks and collect them with `TaskOutput` — the PLN-725 dispatch is a singleton that the walker waits on inline. A synchronous Task returns after the agent finishes; there is no task handle to pass to `TaskOutput` and no wait step needed:

1. `subagent_type: "code-review:code-review-worker"` (same allowlist as the verifier fleet — Read, Write, Grep, Glob).
2. `model` set to the manifest's `model` field.
3. Prompt template:
   ```
   You are the PLN-725 SINGLE-AGENT DISPATCH ({STAGE_LABEL}). Your system
   prompt is at:
     {PROMPT_PATH}

   Read it. Your input bundle is at:
     {INPUT_PATH}

   Read the bundle for the contract you are validating against. Write
   your output JSON to:
     {OUTPUT_PATH}

   Do not write anywhere else. Do not read source files in the
   repository unless the system prompt explicitly says so.
   ```
   Placeholder substitution map (do NOT substitute every placeholder from the manifest — `output_path` in the manifest is the consolidate target, not the agent target):

   | Placeholder | Source |
   |---|---|
   | `{PROMPT_PATH}` | `manifest.prompt_path` |
   | `{INPUT_PATH}` | `manifest.input_path` |
   | `{OUTPUT_PATH}` | The by-convention agent write target from the table above — `<CR_DIR>/pln725_extract_signals.json` (stage_11) or `<CR_DIR>/pln725_coverage_critic.json` (stage_15). **NOT** `manifest.output_path`. |
   | `{STAGE_LABEL}` | `"signal-extraction"` for stage_11, `"coverage-critic"` for stage_15. |
4. After the Task returns, advance the walker to the sibling consolidate stage. No `TaskOutput` call — that's for background tasks; synchronous Tasks complete before control returns to the walker.

### Failure semantics

- A missing `pln725_*.json` output after the Task returns is NOT a fatal error. The sibling consolidate stage detects the missing file and fails closed — extract-signals emits the fail-closed default signal set + a `signal-extraction-failed` finding; coverage-critic leaves the initial plan as final + a `coverage-critic-failed` finding.
- Do not retry the singleton agent in the walker. The fail-closed downstream handling is the canonical recovery path — retrying would burn tokens on a request that already failed.
- Do not parse the agent output in the orchestrator. The sibling consolidate stage is the only reader; orchestrator parsing would duplicate the validation contract.

### Cache hits and the skip reasons

Both `"cache_hit"` and `"skipped"` (any of `no-critic` / `no-roster` / `no-candidates`) mean prepare wrote the canonical output file itself. The walker advances to the sibling consolidate stage as normal; the sibling stage's `cmd` detects the manifest status, writes a one-line no-op JSON to stdout, and returns 0. No orchestrator-side branching needed.
