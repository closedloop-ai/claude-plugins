# Judgment patterns

Habits that kept a multi-PR program on track, beyond the rules in SKILL.md.

- Verify every worker claim that matters before relaying it: re-read the PR body, the live head SHA, the check names. Workers repeat stale facts, such as a flag still "pending" after its key exists, "CI will run e2e" when PR CI skips it, or a request naming an unpushed SHA.
- Stale work is waste. When a PR head moves, stop runs pinned to the old head (they also hold shared slots) and rerun at the final head.
- One owner per behavior across PRs. When two PRs implement the same rule differently, rule once, put it in the owning PR and make the other inherit it. When two PRs create the same file, name which merges first and tell the second to fold into it.
- Ask "what failed, and what exactly changed" of every test or fixture change before it is pushed. Setup fixes that use the repo's documented helpers pass; weakened assertions do not.
- Check parity at several widths and in both flag states. A single desktop width hid regressions more than once.
