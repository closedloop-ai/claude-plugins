# Judgment patterns

Habits that kept a multi-PR program on track. They apply the two principles in SKILL.md and do not restate them.

- Verifying a worker claim (principle 2) means re-reading the PR body, the live head SHA and the check names. Workers repeat stale facts, such as a flag still "pending" after its key exists, "CI will run e2e" when PR CI skips it, or a request naming an unpushed SHA.
- Stale work is waste. Stop a run only when its source changes while it is still executing. After it finishes, use handoff's `qa-impact.mjs`; a later commit preserves its evidence unless the classifier names lanes or rendered screens the commit can affect.
- One owner per behavior across PRs. When two PRs implement the same rule differently, rule once, put it in the owning PR and make the other inherit it. When two PRs create the same file, name which merges first and tell the second to fold into it. Being on main is not evidence of being the final design: ask the owner which side is scaffold before recommending which side to drop.
- Ask "what failed, and what exactly changed" of every test or fixture change before it is pushed. Setup fixes that use the repo's documented helpers pass; weakened assertions do not.
- Check parity at several widths and in both flag states. A single desktop width hid regressions more than once.
- When you accept a worker's alternative to your instruction, tell that worker at once, as a scope change, that its version stands and your instruction is withdrawn; a late-arriving instruction otherwise makes it redo the work.
