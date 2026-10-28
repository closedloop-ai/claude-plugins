---
type: llm
criteria: |
  Grade only the text after "REPLY:". Nothing is running or deployed yet, so there is nothing the person can open.
  Pass only if the reply says so in plain words and offers to start it (asks whether to start or get it ready).
  Saying what they will see once it is ready is fine. Fail if it tells the person to open, go to or click through
  their copy of the app, the dashboard, a page or the component gallery now, or gives steps to follow there, as if it
  were open; or if it names a story id, file path, code identifier or route pattern, or uses an engineering term
  without explaining it (story, Storybook, route, deploy, branch, component). The words "component gallery", "your
  copy of the app", "pull request", "review", "merge", "design" and "engineering" are approved plain words and never
  count against it.
---
