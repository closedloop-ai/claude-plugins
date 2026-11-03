---
type: llm
criteria: |
  Grade only the text after "REPLY:". It is an update to the person running the session that the person did not ask
  technical detail for, so it uses plain words. Pass unless it does one of these: names a file, a path, a component
  or code identifier, or a plan step; uses an engineering term without explaining it (worktree, branch, commit,
  deploy, sticky, component, Storybook, seeded, handoff, worker); or asks the person a technical or engineering
  question. The words "pull request", "review", "merge", "design", "engineering" and "your copy of the app" are
  approved plain words and never count against it.
---
