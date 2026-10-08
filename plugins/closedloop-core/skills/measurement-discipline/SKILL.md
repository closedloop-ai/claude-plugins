---
name: measurement-discipline
description: Use when optimizing, benchmarking, profiling, or running a performance experiment; when evaluating whether a change actually helped; or when recording or checking past optimization attempts. Enforces one-variable experiments, noise floors measured from repeated runs, a required mechanism behind any claimed win, and writing refutations down so failed attempts are not re-litigated.
---

# Measure One Thing, Then Write It Down

## When invoked

Apply the rules below to the measurement or optimization task at hand:
baseline before touching anything, change one variable, keep a control where
the harness could drift, require a mechanism for any claimed win, and record
a loss as REFUTED rather than letting it go unwritten. If the project keeps a
measurement log, search it by symptom before proposing or diagnosing
anything, then append the resulting entry, success or refutation, as part of
finishing the task.

Use this as team practice, or paste it into an AI agent's instructions; it is written as
instructions either way. It applies to anything measurable: query latency, cache hit rates,
build times, bundle size, model parameters, cost per request. Its purpose is to make every
optimization question cost one search instead of one rediscovery, and to make sure the
answer you find was honestly obtained.

## The rules

**1. Baseline before you touch anything, and get the noise floor from repeated runs.**
One before-number and one after-number cannot tell a real effect from a slow afternoon.
Discard the first run as warmup, take at least five or six more, record every one, and state
the median and the spread. The spread is your noise floor; nothing smaller is a result.

**2. Change one variable.**
When two things change together and the number moves, you have learned nothing about either,
and you will be back here next quarter to learn nothing again. If you must bundle changes to
ship, still measure them one at a time first.

**3. Keep a control when the harness could drift.**
Machines get busy, caches warm, background jobs start; a control on a path your change cannot
possibly touch tells you how much of the delta was the world rather than you. If the control
moves as much as the candidate, your noise floor is wider than you thought, and you say so.

**4. A win must beat the noise floor AND come with a mechanism.**
A delta without a mechanism is a coincidence you will re-litigate, because nobody, including
you in six months, can tell it apart from luck. Name what changed: call count went from
1 + N to 2, the plan switched to an index scan, the allocation left the hot path. No
mechanism means the experiment is not finished.

**5. Product performance goals need product-level evidence.**
When the stated goal is user-facing speed, such as page load time or a route's production
latency, a helper microbenchmark is support evidence, not acceptance by itself. Tie each
experiment back to the product surface and stage it is supposed to improve. If the local helper
delta is negligible while the page or route remains slow, keep investigating the next bottleneck
or record why that ticket's scope cannot move the product metric. When production telemetry
exists, such as Datadog RUM/APM page or route spans, record the exact query/window and the
baseline or comparison values available there. If access or export is unavailable, record that
as an evidence gap instead of substituting local-only numbers for production behavior.

**6. A loss is recorded as REFUTED, with its conditions and a re-check trigger.**
Refuted work that is not written down gets paid for a second and third time by the next
person with the same good idea. Record what you tried, the numbers, why it failed, and the
conditions under which the answer would change. Results are tied to conditions: a 10x change
in data volume, traffic, or hardware reopens them; silently trusting an old result does not.

**7. The log is append-only and dated, and every number carries the command that produced it.**
An unreproducible number is an opinion with decimal places. Never edit a past entry to agree
with a newer finding; append the newer finding and say what it supersedes. Pin anything that
moves under you: input set, revision, seed, data snapshot, sample size.

**8. Label projections as projections.**
An extrapolation that reads like a measurement will be quoted back at you as one, usually in
a decision meeting. Write "projection at this measured rate" and show the rate it came from.

**9. Search the log by SYMPTOM before you propose anything, and before you explain anything.**
Rediscovery is the expensive failure mode, and prior findings are almost always filed under
the symptom that prompted them, in prose, not under the name you would give your fix. The
trigger is not "am I about to change something", it is "am I about to reach a conclusion
about an area that may already have one", so diagnosis counts too: following evidence is the
activity most likely to re-derive a recorded finding, and one search for the symptom ends
what would otherwise be twenty steps reconstructing something already written down.

**10. Decisions cite measurements, and reversing one is fine when you name what changed.**
Finding a prior decision does not end the argument; it ends proposing in ignorance. Either
follow it or reverse it deliberately and record the reversal with the delta that justifies
it (the population grew from 5 to 33, the job went from nightly to every fifteen minutes).
Flipping a recorded decision silently leaves the next reader to re-derive the original
reasoning and flip it back.

**11. Do not stop after the first measured win; stop at the floor.**
A performance task is not complete merely because one change helped. After an adopted
improvement, re-measure the target path, identify the next dominant bottleneck or absence of
one, and run the next in-scope one-variable experiment when a credible mechanism remains. Stop
when consecutive in-scope experiments land within noise, the remaining opportunity is
negligible against the measured latency budget, or the next plausible mechanism would cross an
explicit scope, safety, product, or requirements boundary. Record that stopping condition.

## What an entry contains

Date and a one-line title with the verdict in it. The single variable. Baseline with the
exact command and every run. The change. The after numbers. The control. The mechanism. The
verdict against the noise floor. The decision, plus proof that temporary scaffolding was
removed. A closing block separating measured from not measured, with the re-check trigger.

## Worked example: a success

```
## 2026-03-14: batch the per-row lookup in the order export, ADOPTED

One variable. Only the lookup changed; same input file, same machine, same warm cache.
1. Baseline. `bench export orders`, 1 discarded warmup then 6 warm runs:
   812 / 798 / 826 / 805 / 819 / 803 ms. Median 807 ms, spread 28 ms (3.5%). That is the noise floor.
2. Change. Per-row lookup replaced by one keyed batch fetch. Diff touches one function.
3. After. Same command, 6 warm runs: 214 / 209 / 221 / 213 / 210 / 216 ms. Median 213 ms.
   Control (`bench export invoices`, a path that does not use the lookup): 402 ms then 397 ms, flat.
4. Mechanism. Query count went from 1 + N (N = 4,180) to 2. Measured round trip is 0.14 ms,
   so 4,178 removed round trips account for 585 ms of the 594 ms saved. Not a coincidence.
5. Verdict: 3.8x, twenty times the 28 ms noise floor. ADOPT.
Labelling. Measured: all timings, the query counts, the control. Not measured: cold cache, and
exports above 50k rows. Re-check if row counts grow 10x, where the single batch may become the bound.
```

## Worked example: a refutation

```
## 2026-03-16: index on the merge-date column, REFUTED

One variable. Index created on a scratch copy of the database only; no schema file, no code, no migration.
1. Baseline. `bench report throughput`, 1 discarded warmup then 6 warm runs:
   19.6 / 18.6 / 19.5 / 19.6 / 20.3 / 18.6 ms. Median 19.55 ms, spread 1.7 ms.
2. After index. 12 warm runs (second batch interleaved with the control to separate the index
   from time-based drift): median 19.3 ms, range 18.3 to 20.1. Delta 0.25 ms (1.3%), inside the spread.
3. Mechanism. The query plan shows the lookup already resolved by the primary key on the join
   column, narrowing to under 5 rows before the aggregate. The date index is not on that access
   path and is never consulted, so no mechanism existed by which it could help.
4. Control. An untouched report drifted 46.7 to 43.0 to 41.9 ms across the same session and
   stayed there after the index was dropped. That 10% wander is the real noise floor today,
   several times the effect under test. Reported, not smoothed away.
5. Verdict: WITHIN NOISE. REFUTED. Index dropped; index list and schema dump match the shipped
   state, integrity check ok, no tracked file changed.
Labelling. Measured: everything above, on tables of 2,110 and 26 rows. Not measured: production
scale. Re-check trigger: if either table grows 10x, re-run rather than citing this entry.
```

## If you are an AI agent

Before proposing or diagnosing, search the log for the symptom and for the mechanism you are
about to name, and say what you searched for. Claim nothing without a number, and never
present an estimate in the shape of a measurement. Run the baseline before the first edit.
Change one thing. Report every run, not the best one. If the result is within noise, say
"within noise" and write the refutation; a refutation is a completed piece of work, not a
failure to report. Remove your scaffolding and prove it is gone. Append the entry the same
session, because the entry is the deliverable and the code change is only sometimes.
