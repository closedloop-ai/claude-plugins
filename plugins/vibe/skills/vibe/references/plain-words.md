# Plain words for the person

The person running a vibe session is not an engineer. Some describe the work
and pass it on; others bring screenshots and may open the pull request
themselves. Neither should have to learn how the work is built. Every message the person sees, from the orchestrator or
relayed from a worker, uses plain words: setup, progress, notices, questions,
sample data and errors alike.

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
