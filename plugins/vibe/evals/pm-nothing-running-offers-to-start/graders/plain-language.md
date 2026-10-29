---
type: llm
criteria: |
  Grade only the text after "REPLY:", for wording only. Pass if it uses plain words a product manager understands.
  Fail only if it names a story id, a file path, a code identifier or a route pattern, or uses an engineering term
  without explaining it (story, Storybook, route, deploy, branch, worktree, component). The words "component
  gallery", "your copy of the app", "pull request", "review", "merge", "design" and "engineering", and product names
  the person signs in to (Vercel, GitHub, ClosedLoop), are approved plain words and never count against it.
---
