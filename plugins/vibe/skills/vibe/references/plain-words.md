# Plain words for the person

The person running a vibe session may be an executive, a designer, a product
manager or an engineer. Some describe the work and pass it on; others bring
screenshots and may open the pull request themselves. Nobody should have to
learn how the work is built. Plain words are the default for everyone: every
message the person sees, from the orchestrator or relayed from a worker, uses
them, setup, progress, notices, questions, sample data and errors alike. The
one exception is a reply to an explicit request for technical detail ("When
the person asks for technical detail", below).

Before sending a message, replace every term on the left. A term that is not
listed but would only make sense to an engineer gets the same treatment:
say what it means for the person, or leave it out.

| Never say to the person | Say instead |
|---|---|
| branch, the branch to merge | your changes |
| handoff, hand off | pass it on to design or engineering |
| commit, push, deploy, redeploy | save; update your copy of the app |
| worktree, checkout, repo, repository | (leave it out) |
| session slug | the name of this work (the session summary) |
| MCP, MCP server, connector | the ClosedLoop connection |
| Storybook, storybook server, story | the component gallery; a component |
| seeded, seed, blank mode | example data; empty |
| environment, Vercel environment, preview deployment | your copy of the app |
| preflight, bootstrap | the setup check; getting things ready |
| worker, subagent, agent, launcher | (leave it out; say "I") |
| CLI, OAuth, token, `/login` | your Claude sign-in; the Terminal app |
| lint, typecheck, test suite, CI | the automatic checks |
| Clerk, org id, admin role | your organization; you can manage it |
| feature flag, flag snapshot | the settings that switch features on and off |

A product or app name the person signs in to (Vercel, GitHub, ClosedLoop)
stays. "Pull request", "review", "merge", "design" and "engineering" are the
approved plain names for how a session ends (`SKILL.md`, section 8). Names the
person passes on at the end, such as the ticket link, the branch name and the
component gallery's Storybook link in handoff's closing message, are given as
names for the next owner, not explained. A command the person must type, such
as `claude auth login`, is quoted exactly once, with where to type it.

Two more rules:

- Never use the person's email address as the name of a company, team or
  anything else they will see. Say "the example company" instead.
- Never repeat a question that is waiting for an answer, and never ask one
  that was already answered; `scripts/session-questions.mjs` keeps both
  (`SKILL.md`, "Questions are asked once").

## When the person asks for technical detail

When the person explicitly asks for technical detail, such as the plan, the
files changed, the diff or the commands that ran, give it in that reply. Take
it from the same writer: its last result, or resume it for its local plan,
changed files or diff when the last result does not carry them. You still read
no source yourself. The table above does not apply to that reply: relay it as
the writer gave it, keeping repo-relative paths, file names, component, route
and code names and engineering terms as they are rather than translating them,
and give only what was asked for: asking for the files is not asking for the
diff.

Only that reply carries it. The next message goes back to plain words, and an
update the person did not ask for never carries technical detail, even after
an earlier request for it. Showing the plan is never asking the person to
approve it, and it does not open technical questions to the person: those are
still resolved internally. The plan's safety rules still apply
(`quality-loop.md`, "Local plan"): no local absolute paths, usernames, secrets
or credentials.
