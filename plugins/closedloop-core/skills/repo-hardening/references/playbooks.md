# Playbooks

Match the task, copy the steps into the checklist verbatim, and mark any skipped step with `skip: <reason>`. Every playbook ends with a reply that states what was done, how it was verified, and what is open, with each claim labeled measured, inferred, or guess. Code playbooks end with small ordered commits whose sequence proves the work.

If no playbook fits, or the work is large, cross-cutting, or unattended, design a bespoke one: a falsifiable done predicate, quantified scope, the riskiest unknown first, a verification harness with a baseline before any change, atomic landable units, and a decision trail. Rigor is gates and artifacts, not "try harder".

## Investigation

Read-only. The deliverable is a cited answer or a recommendation with a tradeoffs table, not a code change.

1. State the question and your interpretation if it is vague.
2. Fan out read-only explorers by angle; a synthesizer reconciles by checking the code. For "why" questions, add history: blame, log, PR bodies, linked issues, incident notes.
3. Tier every claim (Direct, Supported, Inferred, Speculative, Unknown). Code is not evidence of its own intent.
4. Answer with: overview, key concepts, how it works, where things live, gotchas, what was not found. Push back if the premise is wrong.

Exit: every claim cited or downgraded. If the answer precedes a change, hand back and re-route.

## Bug fix

Be scientific. Every shipped line traces to runtime evidence. A change that "might help" is a hypothesis, not a fix; when evidence refutes it, revert it.

1. Reproduce it yourself on the matching surface (the real CLI, UI, or API). Ask the user only with a specific reason the surface is unreachable, after driving it as far as it goes. If it will not reproduce, synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. List candidate hypotheses, take the split that cuts the most space, get runtime evidence, eliminate. When state is unclear, instrument and read it running. Confirm the surviving mechanism with evidence before planning a fix.
3. Plan the smallest fix the evidence justifies. If it crosses a module boundary, sketch the shape first.
4. Verify on the same surface: the original repro now passes. Inconclusive or wrong-surface is not a pass. Unit tests show branch behavior, not bug absence.
5. Land the failing reproduction before the fix in history when a cheap local test exists. Grep for the same pattern elsewhere and fix every instance or list them.
6. Decide the prevention rung for the class (see trust ladder) and add or propose it.

Exit: failing-then-passing output pasted verbatim; root cause named; prevention named or declined with a reason.

## Perf fix

Tie every change to a measurement. Reading source is not measuring.

1. Capture a baseline on the real surface with a repeatable command: median of several alternating runs, with range, error count, and work count. Name the limiter from a profile.
2. Try the mantras in order and stop at the first that meets the target: do not do it; do it once; do it less; do it later; do it off the critical path; do it concurrently; do it cheaper.
3. One change, one measurement, keep or revert. Capture a post-change profile.
4. Before reporting a number: why is it not twice as good; was each side tuned alike; does the claim break physical limits (a piece taking 10 percent cannot save more than 10 percent); did it error; does it reproduce; does it matter end to end; did the work actually run inside the timed region.

Exit: baseline, after, delta, run count, range, limiter, artifact path. Verdict is faster, slower, no measurable difference, or inconclusive.

## Hillclimb

Sustained improvement of one metric against a target. The loop, not a one-off fix.

1. Pick a case that reproduces the complaint. Fix one metric, the direction, and a stop predicate pairing a target with a floor on attempts.
2. Build the harness, prove it separates easy from hard cases, vet it as in Perf fix step 4, then freeze it. Record the baseline and a green regression gate.
3. Open a decision log: one row per attempt with hypothesis, change, before, after, delta, tests, verdict.
4. Each hypothesis names a mechanism. Loop: one change, measure, accept only past noise with the gate green, otherwise revert in full. One commit per accepted win.
5. Push past the first plateau: pivot category, combine near-misses, reread the source. Correctness and simplicity outrank the number.
6. Stop at the predicate or when remaining ideas are marginal. Never relax the predicate.

Exit: metric and target, baseline to final, kept versus reverted counts, the log path, the best untried idea.

## Refactor

The structure changes; the behavior does not. A discovered bug or feature is split out.

1. Pin the contract first: a characterization test, snapshot, or equivalence harness capturing current behavior. Type check and lint are not a pin.
2. Name the structure the code is missing and the target shape as if built today. The reshape must delete branches or invalid states, not add indirection.
3. Subtract first: dead code, one-caller wrappers, redundant validators, orphan references.
4. Move in small steps that keep the pin green. Migrate every caller and delete the old API in the same wave; no shims. Spot-check renames in strings and prose.
5. Prove behavior unchanged on the real artifact: an equivalence diff, a replayed baseline, or a smoke run.
6. If the diff does not lower reader load somewhere, revert it.

Exit: the pin held against, the equivalence proof, the reader-load delta, what was reverted. No new behavior.

## Feature

1. Learn the subsystem before touching it. Name the data shape and its organizing structure (state machine over booleans, registry over branching, typed model over loose parameters) before writing logic.
2. If the change crosses a boundary or has several plausible shapes, sketch two structurally distinct designs from the caller's view (usage first, then types) and pick on interface depth and maintainability. Screen for red flags: shallow modules, leaked wire types, pass-through methods, split ownership, two ways to do one task, importable internals, hand-synced lists.
3. Write the throughput checkpoint: blocking first steps, independent workstreams, shared mutable state (split it), smallest safe decomposition.
4. Implement in small verifiable units. Delegate with specific scope and keep the lead role.
5. Verify on the matching surface with evidence. Run an adversarial review if the design was contested.

Exit: what changed for the user and the next maintainer, evidence, alternatives considered.

## Adversarial review

The deliverable is a verdict. Apply nothing automatically.

1. Scope the diff and state the intent in one paragraph. Reviewers challenge the execution, not the intent.
2. Give the same prompt to two or more independent reviewers (see delegation). Lenses: correctness with traced paths, idempotency and concurrency; root cause versus symptom (guards masking invariants, retries hiding broken contracts, casts silencing modeling errors, instructions where structure belongs); structural fit (boundary validation once, bolted-on versus integrated, legacy dual paths); verification (behavior tests, a test for the bug, the real thing not a proxy); complexity budget (one-caller abstractions, speculative config, dead paths); security (input to sink traced).
3. Reconcile as a pragmatic senior engineer, not an aggregator: consensus is strong; hypotheticals without a call site are weak; "I would have done it differently" is dismissed; single-model security or correctness findings get extra care before dismissal.

Exit: Act on, Consider, Noted, Dismissed with reasons, and an agreement map.

## Blast radius

Listing the callers is not the job. A writeup that sounds right is worthless.

1. Read the change, including what the diff does not spell out.
2. Find the single fact the change is safe because of. Spend the time there.
3. Look where grep stops: library source at the pinned version, timing and teardown, serialized formats and other languages, feature flags, consumers three hops out.
4. Give each risk a likelihood and cost. Keep confirmed and cleared lists. Never invent callers.
5. Prove the safety fact with a script or test; paste the output. Report where it stopped on the evidence ladder.

Exit: what it does, the safety fact with its ladder step and proof, risks with checks, cleared items, the cheapest test to add before merge.

## Unattended run

For "run until done" work.

1. Write the exit condition as a checkable predicate. A duration is not a finish condition.
2. Each iteration: check the predicate, make the smallest evidence-justified change, verify on the real artifact, commit if it advanced, discard otherwise, log one decision row.
3. Mid-run discoveries are yours: fix a broken check or a related bug in its own unit, then return to the predicate. Do not park reversible work or ask.
4. Pause only at the human's named gates and for irreversible actions. Stop only at the predicate; a plateau is not a stop; never relax the predicate.

Exit: predicate status, the log path, what landed, what is open.

## Landing

Green is not safe.

1. One fresh verifier per change, not batched, drives the real surface against base and head and posts VERIFIED, VERIFIED with notes, or NOT VERIFIED. The verifier never wrote the code.
2. Bind the verdict to the exact commit. A rebase that changes the patch voids it; re-verify.
3. Land only the contiguous verified run from the bottom of a stack, one at a time, recomputing after each merge.
4. Triage automated review comments skeptically: fix real correctness, security, data, and migration issues; dismiss documented noise with a concrete reason; never churn code to quiet a bot; never auto-dismiss security, auth, billing, data, or schema findings.
5. Stop at the ceiling and say what verifying the next change would take.

Exit: what landed with verdicts, what stopped and why.
