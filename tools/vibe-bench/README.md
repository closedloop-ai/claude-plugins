# Local Claude benchmark scaffold

This package measures the Claude Code arm of ISS-13401. Phase 0 supplies the fake symphony-alpha origin, private oracle, isolated web-only seeded stack, local MCP, and pinned `claude-sonnet-5-5` / `high` launch. Phase 1 adds authoritative collection and comparison. Its local probe creates no GitHub PR, so task-to-PR success remains false there. Phase 2 runs the full benchmark and owns the draft PR lifecycle. It never creates a ClosedLoop ticket or Vercel deployment.

Run the live path only through an owned heavy slot, for example:

```sh
heavy-slot.sh iss-13401-bench node --experimental-strip-types tools/vibe-bench/src/cli.ts run-local <symphony-alpha-checkout> <empty-sandbox> <vibe-plugin-directory> <claude-binary>
```

The CLI writes `phase1-claude-result.json` and `phase1-claude-report.md` under the run sandbox. `collect <phase0-live-result.json> <vibe-plugin-directory> <claude-binary> [otel-jsonl] [transcript-manifest]` re-collects an existing local probe. With its Phase 0 manifest present, it discovers only that run's root and subagent Claude transcripts; an explicit transcript manifest is a JSON array of `{ "path", "agentName"?, "parentToolUseId"? }` entries. OTEL is optional and, when supplied, must be run-owned JSONL `claude_code.api_request` records with request IDs, effort and token fields. Missing or irreconcilable records fail.

The full Phase 2 baseline snapshots `vibe` and `closedloop-core` from one exact claude-plugins `origin/main` SHA. It verifies a clean symphony-alpha worktree at the current live `origin/main` before starting, then pins that source commit for all ten runs. One isolated web stack and local MCP serve five balanced `AB` waves: each wave runs one vibe and one fleet-orchestrator writer session concurrently. Every run gets a fresh fake-origin checkout, the plugin's real version check and private local session record, a restricted Claude Code conversation, a hidden oracle, and a harness-owned GitHub draft PR. The PR title includes `DO NOT MERGE`; its body identifies the vibe benchmark. The harness records a provisional result, closes the PR, then removes both run-owned proof refs. The two refs represent the deliberately broken fixture base and its repaired head; the repaired tree equals healthy main, so a PR directly against main would have no diff.

From a clean, bootstrapped symphony-alpha worktree and an empty run root, invoke the batch through the owned heavy slot:

```sh
heavy-slot.sh iss-13401-baseline node --experimental-strip-types tools/vibe-bench/src/cli.ts baseline <symphony-checkout> <claude-plugins-checkout> <full-main-plugin-sha> <empty-run-root> <output-dir> <claude-binary> <gh-binary>
```

The dated JSON and Markdown in the output directory are immutable. `measurement-log.md` is append-only. The baseline records five results per shape, full batch wall, one setup/teardown allocation, per-run Claude final totals and cost, version check, model and effort, CLI version, plugin/source/task hashes, PR closure, and component/skill/worker/phase attribution where observable. Concurrent run durations overlap, so the report shows wave maxima and aggregate process-time drivers separately. Cached input is informational. The fixed full-batch target is 600 seconds; a miss stays a miss, with measured drivers reported.

Compare five valid main results to three valid PR results with:

```sh
node --experimental-strip-types tools/vibe-bench/src/cli.ts compare <five-results.json> <three-results.json> <main-instruction-words> <pr-instruction-words> <output-dir> [explanations.json]
```

The arrays must cover the same task, fixture, Claude CLI version, shape, model and effort. Yellow and red signals require an explanation entry keyed by signal with `component`, `phase`, and `why`. Red remains blocked pending the benchmark approver's explicit acceptance. Cached input is reported but never gated. Phase 3's model-driven evals run on both runtimes.

Phase 3 runs the shared model-driven case corpus locally on Claude Code and Codex from one committed plugin snapshot. A full run keeps Codex wording grading; deterministic mode skips only that paid wording grader and records every skip. Both modes keep every route, file, tool, and behavior check.

```sh
heavy-slot.sh iss-13401-evals node --experimental-strip-types tools/vibe-bench/src/cli.ts eval-local <claude-plugins-checkout> <full-branch-sha> <empty-run-root> <output-dir> <claude-binary> <codex-binary> <python-binary> <full-or-deterministic> [case ...]
```

Omit case names to select every native prompt manifest in the snapshot. The command writes the two native result trees plus one hashed JSON and Markdown summary. It reports failure when either runtime is partial, malformed, identity-mismatched, missing a selected case, or red. Native Claude eval output does not expose token counts, so the combined result records those tokens as unavailable instead of zero.

Phase 6 exposes the complete developer workflow as the repo-local `vibe-bench` skill. It lists the authenticated developer's open claude-plugins pull requests before paid work and asks which one to update. The selected PR must be open against main, and its branch and full head SHA must equal the clean checkout. The symphony-alpha checkout must be clean at the baseline's exact fixture SHA, with its fetched `origin/main` containing that fixture. This keeps a developer run comparable when symphony-alpha main advances after the baseline. The benchmark then uses the Phase 2 batch implementation for exactly three balanced `AB` waves on one seeded stack. This gives three candidate samples per shape while preserving the fixed under-ten-minute wall target.

```sh
node --experimental-strip-types tools/vibe-bench/src/cli.ts pr-list <claude-plugins-checkout> <gh-binary>
node --experimental-strip-types tools/vibe-bench/src/cli.ts pr-run <claude-plugins-checkout> <pr-number> <baseline-json> <symphony-checkout> <empty-run-root> <output-dir> <claude-binary> <gh-binary>
```

After the benchmark stack is down, run the full Phase 3 eval command without case selectors against the same head. Publishing requires both immutable artifacts, the full corpus, and explanations keyed by `shape:signal` for every yellow or red signal.

```sh
node --experimental-strip-types tools/vibe-bench/src/cli.ts pr-publish <claude-plugins-checkout> <pr-number> <benchmark-json> <eval-json> <section-output> <gh-binary> [explanations-json]
```

Publication rechecks the live full head, replaces exactly one rendered `## Benchmark` body section, confirms the live body, and attaches compact evidence in a PR comment without changing labels. A red result publishes the disclosure and remains blocked pending the benchmark approver's explicit acceptance.
