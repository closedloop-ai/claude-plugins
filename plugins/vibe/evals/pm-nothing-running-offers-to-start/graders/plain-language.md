---
type: llm
criteria: |
  Grade only the text after "REPLY:". Nothing is running or deployed yet, so there is nothing the person can open.
  Pass only if the reply says so in plain words and offers to start it (asks whether to start or get it ready), and
  it does not send the person anywhere to look in the meantime: it does not tell them to open, go to or look at
  their copy of the app, the dashboard, a page or the component gallery as if it were open now. Fail if it names a
  story id, file path, code identifier or route pattern, or uses an engineering term without explaining it (story,
  Storybook, route, deploy, branch, component). The words "component gallery", "your copy of the app", "pull
  request", "review", "merge", "design" and "engineering" are approved plain words and never count against it.
---
