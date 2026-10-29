---
name: vibe-bench
description: Run and publish the local ISS-13401 vibe benchmark for one open claude-plugins pull request.
---

# Vibe benchmark

Use this skill only on a developer machine. The benchmark itself runs under Claude Code with `claude-sonnet-5-5` at effort `high`. Model-driven evals run locally on both Claude Code and Codex after the benchmark stack is down. Never run either workload in CI.

1. From the clean claude-plugins PR checkout, run `pnpm -C tools/vibe-bench bench -- pr-list <repo> <gh>` and show the open PR choices. Ask the developer which PR to update. Do not start paid work before the answer.
2. Run `pr-run` for that PR using the accepted baseline JSON, a clean symphony-alpha checkout at the baseline's exact fixture SHA, one empty run root, one output directory, and explicit Claude and GitHub executables. Fetch symphony-alpha `origin/main` first; the fixture commit must still be on live main. This preflight refuses a branch or full-head mismatch. It runs three paired waves, each containing one vibe and one fleet sample, on one isolated seeded web stack plus local MCP. Do not change the pinned model, effort, task, concurrency, or run count.
3. Confirm the artifact reports six valid runs, all proof PRs closed, all owned proof refs removed, teardown complete, wall time, cost, tokens, calls, and component, skill, worker and phase evidence. Stop on an invalid artifact or cleanup failure.
4. After teardown, run `eval-local` in `full` mode against the same full PR head. Use a fresh empty eval root. Do not select a subset of cases and do not use deterministic mode for publication.
5. If either comparison is yellow or red, show every non-green `shape:signal` and ask the developer for a concise explanation naming the component, phase and reason. Store the answers in the JSON map accepted by `pr-publish`. Do not invent explanations.
6. Run `pr-publish`. It rechecks the open PR's branch and full head, verifies the immutable benchmark and complete dual-runtime eval artifacts, replaces exactly one rendered `## Benchmark` section, attaches compact current-head evidence in a PR comment, and confirms the live body. It applies no label.
7. If the result is red, publish the disclosure and attached evidence, then report that the authorized benchmark approver must explicitly accept the current-head regression. Never apply `benchmark-not-needed` or `benchmark-regression-accepted`.

Use `node --experimental-strip-types tools/vibe-bench/src/cli.ts` instead of `pnpm` when the parent repository has no workspace command available. Keep run artifacts out of the repository. Always report per-run wall time and dollar cost, full batch wall and cost, and cleanup state.
