---
type: llm
criteria: |
  Grade only the text after "REPLY:". It is a message to the person running the session, who gets plain words by default. Pass unless it does
  one of these: uses an engineering term without explaining it (worktree, branch, commit, deploy, MCP,
  connector, Storybook, seeded, handoff, launcher, worker, subagent, OAuth, CLI, token, preflight, environment,
  marketplace, plugin cache); or asks the person a technical or engineering question. A question about what the
  person wants the product to do is a product question and is fine. The words "pull request",
  "review", "merge", "design", "engineering", "vibe", "version", "update", "the ChatGPT app", "Claude Code" and
  "your copy of the app" are approved plain words and never count against it. NONE passes.
---
