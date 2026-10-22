# Trust ladder

Work down the ladder and stop at the first rung that can catch the mistake class. Higher rungs enforce without cooperation; lower rungs only advise. Human review is not on the ladder: a reviewer who must catch the same mistake on every PR is the problem being fixed.

| Rung | Mechanism | Fits when |
|---|---|---|
| 1 | Architecture or types | The bad state is an invalid combination, a missing case, a raw value where a typed one belongs, or an API that can be reshaped so the safe path is the only path. One owner per piece of state, one supported way per task, internals hidden so the wrong import fails, one source of truth instead of hand-synced lists. |
| 2 | Static check or source gate | The mistake has a syntactic shape: a call, import, literal, file location, or required pairing visible in one file. The failure message names the fix. If the pattern is already common, ratchet: fail only when a change adds more, with an allowlist that can only shrink. |
| 3 | Guard test | No syntactic shape, but a test can observe it at a real surface: an output, a contract, an invariant over every registered item, parity between twins. Prefer a test that enumerates all instances over one that pins the fixed case. |
| 4 | Rule in the owning instruction file | Avoiding it takes judgment no check can encode. One or two lines: the rule, why, how to check. Put it in the instruction file nearest the code, not the root by default. Pair it with an example of the failure. |
| 5 | Advisory note or memory | Environment pitfalls and external-system behavior. Never the only prevention for a correctness mistake. |

## Choosing the rung

Ask in order:

1. Could the code be shaped so the mistake cannot compile or cannot be constructed?
2. Could a check find every instance from text alone with few false positives? The grep you used to find the instances is often the start of the check.
3. Can a test observe it at a public surface without mocking the thing that went wrong?
4. Does it need judgment? Then a rule, placed next to the code it governs.
5. Otherwise a note, paired with a rule or a proposal for a higher rung.

If the fitting rung needs a large change, plan the highest rung that fits now and list the higher one as a follow-up unit. A lower rung may accompany a higher one (a one-line rule pointing at the new check). Do not stack rungs without a reason.

## A rule already existed

If an instruction-file rule covered the mistake and it happened anyway, do not propose another rule. Move up a rung. If it truly cannot be mechanized, fix why it was missed: wrong file, too far from the code, buried in prose.

## Where it goes in this repo

Name the location for every proposed mechanism, from the audit notes:

- Rung 1: the module or type file that owns the state; the helper that becomes the only path.
- Rung 2: the existing lint config, custom rule directory, or source-gate script. Extend an existing mechanism before creating one. No new toolchain for one mistake class; propose it as its own unit.
- Rung 3: the existing guard or contract test location and naming convention.
- Rung 4: the nearest existing instruction file. A new nested file only if the repo already uses them.
- Rung 5: the documented lessons or pitfalls file, if one exists. Do not invent one.

Also name the rule-to-enforcer table: the plan should propose keeping one in the root instruction file, pairing every rule with what enforces it, so an unenforced rule is visible as a repeat waiting to happen.

## Proof

A check that never failed has not been shown to catch anything. Each rung 1 to 3 unit in the plan states how it will be proven: reintroduce the past mistake (or run the check against the pre-fix commit) and show the failure, then restore. Rungs 4 and 5 cannot fail; say so.

Never loosen an existing check to make a change pass: no disabled rules, new suppressions, widened thresholds, or skipped tests. Exceptions go on the offending line with a reason, an expiry, and a human's approval.
