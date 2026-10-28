---
type: llm
criteria: |
  Grade only the text after "REPLY:". It is a message to the person running the session, who gets plain words by default. Pass unless it does
  one of these: uses an engineering term without explaining it (worktree, branch, commit, deploy, MCP,
  connector, Storybook, seeded, handoff, launcher, worker, OAuth, CLI, token, preflight, environment); asks the
  person a technical or engineering question; or uses the person's email address as the name of a company or
  anything else. It also fails if it repeats or reminds the person of a question they were already asked. The words "pull request", "review", "merge", "design", "engineering", "example company", "your copy of the app"
  and "the Terminal app" are approved plain words and never count against it. A command the person must type, quoted
  once with where to type it, is fine. NONE passes.
---
