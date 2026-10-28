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
| a story id, file path, component name or route pattern to look at | a link to that exact thing ("Links to what the person should look at") |

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

## Links to what the person should look at

Whenever a message points the person at something to look at or open (a
component in the component gallery, a page or screen of their copy of the
app, a preview, a pull request, a ticket), it gives a link that opens that
exact thing in one click. The link text is the plain name the person sees in
the product: the page's or screen's name, or the component and its state as
the gallery names it, such as [Guided tour, mid run](<link>). A story id, file
path, component name or route pattern is never the thing the person is told
to open; one may appear only beside a working link to it. Never link the
app's front page and give directions from there ("go to the dashboard, start
the tour, step to step 2"): link the page itself, or, for one state of a
component (a step partway through, an error, an empty list), its entry in the
component gallery, which opens on that state. This section is the
rule's one canonical statement, for every skill and worker whose words reach
the person.

- A component in the gallery or a page of the app: run
  `node scripts/vibe-sessions.mjs link --worktree "<wt>" --story <story id>`
  or `--page <path>` and give the `url` it prints. It builds the link from
  the session record: a story on the deployed environment's Storybook once
  the environment is verified, otherwise on the local Storybook the session
  started (`--local` for a story built since the last redeploy, which only
  the local Storybook has yet), in the full Storybook UI form
  (`environment.md`, "Storybook links"); a page as the verified app URL plus
  the page's real path for the example data, with the organization's real
  slug and the record's real id (read from the open app tab's address bar or
  the API). It refuses a route pattern (`[id]`, `:id`, `<id>`), so look up
  the real path first.
- A preview, pull request or ticket: the URL its tool returned (the
  prototype's recorded preview URL, the pull request's URL, the ticket's
  `webUrl`).
- When `link` prints `url: null`, nothing is running or deployed to open yet.
  Where the step you are on already starts it (a new component's gallery
  link, `SKILL.md` section 5), start it and run `link` again. Otherwise say so in plain words and offer to start it, such as "Your copy of the app
  isn't ready to open yet; want me to start it?" or "The component gallery
  isn't running; want me to start it so you can see this?", asked once like
  every question (`SKILL.md`, "Questions are asked once"). On yes, start it
  (`vibe-setup-worker` starts the local gallery; `SKILL.md` section 6 deploys
  the app), then send the link. Never send the id or path in its place.

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
