# ISS-13401 measurement log

## 2026-10-29T18:51:24Z: stopped harness attempt

Pinned claude-plugins main `6746cd6c0a498610e42d00df544134dc47e10f96`; symphony-alpha main `cf89e228f9e43aef61a6b67fad5f6dfb013396fe`; Claude Code `2.1.311`, `claude-sonnet-5-5` at `high`. One isolated web stack and local MCP started and seeded. Shape A run 1 requested exactly one `vibe-change-worker`, but the main plugin's version and session guards denied it. The hidden oracle stayed failing. The owned stack and MCP were stopped; no PR or proof ref was created. This is a harness failure, excluded from all baseline samples. Run-owned evidence label: `phase2-baseline-20261029-1350/run-01-vibe`.

## 2026-10-29: restricted hook and collector probes

The real main-plugin version check returned `outdated`; the pinned-main opening instruction recorded `proceed` without installing or updating any plugin. The plugin's session-record helper admitted the local benchmark session. A restricted Claude Code shape A probe repaired the hidden oracle with one writer and no external writes. Its final `result.usage` was last-turn only while `result.modelUsage` carried cumulative totals; the collector now uses and validates the cumulative final totals. These probes are excluded from baseline samples. Probe evidence label: `iss-13401-phase2-hook-probe-NUxi6W`.

## 2026-10-29T19:09:30Z: REFUTED serial schedule screen

Pinned symphony-alpha source `7286694490be0216c9d4d7989b2ede3fdb126112` and claude-plugins main `6746cd6c0a498610e42d00df544134dc47e10f96`, Claude Code `2.1.311`, `claude-sonnet-5-5/high`. Heavy slot 2. One isolated web stack and MCP were reused. Completed samples: A run 1, 116626 ms, $0.2979883, 7 calls, draft PR #9381; B run 2, 107565 ms, $0.1964816, 7 calls, draft PR #9382; B run 3, 113558 ms, $0.1894545, 6 calls, draft PR #9383. Total Claude cost $0.6839244. All PRs were recorded, closed and verified as CLOSED/draft; both proof refs for each were removed. A deliberate run-4 sentinel stopped the serial scheduler at the run-3 boundary, and its `finally` closed the exact owned stack and MCP. The key was removed and heavy slot released by 2026-10-29T19:17:44Z. Three-run mean 112583 ms projects roughly 1126 seconds for ten serial runs before shared setup and teardown, exceeding the fixed 600-second target. These are screening samples, excluded from the final baseline medians and MAD. Evidence label: `phase2-baseline-20261029-1410`.

Four-way resource preflight at 14:19 CDT: 51.5 GB physical RAM with 71% free, 1.0 TiB disk free, 18 CPUs, load averages 19.7/36.9/37.1, and an unrelated Biome process above 800% CPU. Four-way launch was unsafe under that contention. The final schedule is five comparable concurrent `AB` waves, max concurrency two; task and all pinned inputs stay fixed.

## 2026-10-29T19:28:38Z: stopped paired telemetry attempt

Heavy slot 1, one isolated stack, source `e5a03580a185a27212427411c92cefa9958a782b`, plugin `6746cd6c0a498610e42d00df544134dc47e10f96`, Claude Code `2.1.311`, Sonnet 5.5/high. Launch preflight: 74% of 51.5 GB memory free, 18 CPUs, load 35.77/39.01/38.28, 986 GiB disk free. Wave 1 A: 124424 ms, $0.3020607, 7 calls, draft PR #9386 recorded/closed/refs removed. Wave 1 B: 122274 ms, $0.2556242, 9 calls, draft PR #9385 recorded/closed/refs removed. Wave 2 A: Claude $0.2641209, 8 calls after correction; no PR. Wave 2 B: Claude $0.2045797, 7 calls after correction; no PR. Total incurred Claude cost $1.0263855. Both wave-2 streams contained a valid interim `result_index:0` followed by a task-notification completion `result_index:1`; the collector had rejected the second result as duplicate. Both results have the same final cumulative `modelUsage`, and both hidden oracles passed. The scheduler waited for both children, then `finally` stopped its exact owned stack and MCP. Key removal and PR #9385/#9386 CLOSED/draft state were verified by 2026-10-29T19:36:47Z; no matching proof refs remain. This is an incomplete telemetry attempt, excluded from the baseline sample. Evidence label: `phase2-baseline-paired-20261029-1428`.

A failing regression now covers the indexed two-result stream; the collector accepts the terminal result, requires ordered indexes and monotonic cumulative totals, and rejects truncation. Both real wave-2 streams re-collect as valid at their exact Claude costs and token totals. This correction changes collection only; task, schedule and pinned inputs remain fixed for the next complete batch.

## 2026-10-29T19:37:49Z: four-way schedule preflight

The 18-CPU host load fell to 7.48/20.09/29.94 and 83% of 51.5 GB memory was free. The unrelated CPU contention had subsided and no other heavy-slot owner was present. The final batch therefore uses balanced `AABB`, `AABB`, `AB` waves, with two samples of each shape in every four-way wave and one each in the final wave. This is a schedule decision before the final batch; the prior serial screen and incomplete paired attempt remain excluded from baseline statistics.

## 2026-10-29T19:43:49Z: immediate launch resource reversal

At 14:41 CDT load rose to 42.33 on 18 CPUs (62% memory free), then 67.05 at 14:42 (52% free), and remained 59.20 at 14:43 (62% free). Another ticket's test and dependency scan were active with VM pressure. Four-way launch is unsafe. The tested paired `AB` schedule is selected for the final batch, with every shape sharing equivalent concurrency and contention. No baseline sample, PR or owned stack had started under the superseded four-way schedule.

## 2026-10-29T19:53:26.178Z: 2026-10-29-main-6746cd6c0a49-f7fd8ef6

Command: phase2 baseline CLI with source e5a03580a185a27212427411c92cefa9958a782b, plugin 6746cd6c0a498610e42d00df544134dc47e10f96, Claude 2.1.311 (Claude Code), order A B A B A B A B A B, waves 2/2/2/2/2, concurrency 2.
Every run (ms): 1:vibe:72647; 2:fleet-one-writer:81030; 3:vibe:89102; 4:fleet-one-writer:77997; 5:vibe:72174; 6:fleet-one-writer:68179; 7:vibe:66773; 8:fleet-one-writer:70168; 9:vibe:78642; 10:fleet-one-writer:73557.
Full wall 500082 ms; A median/MAD 72647/5874 ms; B median/MAD 73557/4440 ms.
Verdict: BASELINE ACCEPTED. Immutable artifact: 2026-10-29-main-6746cd6c0a49-f7fd8ef6.json (SHA-256 496c8809c21a811f94c9fecfaef98e2e9f498b39f844d4e1c104ec9dabd0c56a).
Measured: ten task-to-closed-PR runs and shared setup/teardown. Not measured: Phase 3 model-driven evals. Re-check if task, source, plugin, model, effort, CLI or machine conditions change.

## 2026-10-29T19:57:03Z: post-batch ownership and integrity audit

All ten PRs #9387 through #9396 were independently queried from GitHub: state CLOSED, still marked draft, title includes `DO NOT MERGE`, body identifies a vibe benchmark and includes a result digest, and no body contains machine-specific or localhost wording. GitHub's remote has zero matching `proof/e5a03580a185-iss13401-f7fd8ef6-*` refs. Control session `iss13401-f7370188` reports `running:false`; port 3010 has no listener; its seed API key file is absent; the owned heavy slot lock was released. The immutable baseline hash revalidated against the JSON. Post-run owning-package tests passed 34/34, TypeScript noEmit passed, and `git diff --check` passed; a first shell one-liner for the hash check had a quoting error and was rerun alone successfully. No compose E2E, Dagger, browser UI or Desktop was started.

Excluded Claude cost: the initial hook-guard failure's final Claude result cost $0.3196519; the serial schedule screen cost $0.6839244; the incomplete paired attempt cost $1.0263855, including its two terminal streams. These total $2.0299618 and are not in the $2.3659315 accepted baseline cost. Restricted implementation probes are also excluded from baseline statistics. Earlier PRs #9381–#9383 and #9385–#9386 were rechecked as CLOSED/draft with result digests, and no `proof/*-iss13401-*` remote refs remain.
