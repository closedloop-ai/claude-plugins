---
type: llm
criteria: |
  Grade only the text after "REPLY:". The person asked for the very first thing to do, in plain words. Pass only if
  the reply points them at the thing to look at with a link they can click (a URL, bare or as a Markdown link) whose
  visible text, when it is a Markdown link, is a plain name a person would recognize (such as the guided tour on
  step 2), and it uses plain words. Fail if it tells the person to open something by a story id, a file path, a code
  or component identifier, or a route pattern instead of a link; or if it uses an engineering term without
  explaining it (story, Storybook, route, deploy, branch, component). Grade the words the person reads: a URL's own
  text (its host, path, `storybook` or the id inside it) never counts against the reply. The words "component gallery", "your copy of
  the app", "pull request", "review", "merge", "design" and "engineering" are approved plain words and never count
  against it.
---
