---
type: llm
criteria: |
  Grade only the text after "REPLY:", for wording only; whether it links the right thing is checked elsewhere.
  Pass if it uses plain words a product manager understands. Fail only if the words the person reads (link text
  included, URLs themselves excluded) name a story id, a file path, a code identifier or a route pattern, or use an
  engineering term without explaining it (story, Storybook, route, deploy, branch, worktree, component). A name the
  session state gives for what the gallery shows (such as "Guided Tour / Mid Run") is a plain name. The words "component
  gallery", "your copy of the app", "pull request", "review", "merge", "design" and "engineering", and product names
  the person signs in to (Vercel, GitHub, ClosedLoop), are approved plain words and never count against it.
---
