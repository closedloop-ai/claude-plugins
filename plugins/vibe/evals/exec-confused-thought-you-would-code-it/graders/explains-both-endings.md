---
type: llm
criteria: |
  Grade only the REPLY line. Pass when it explains, in plain words, that the code is already built and that the
  session can end one of two ways (a pull request the person takes through review and merge, or passing it to
  someone, usually design and then engineering, to finish), and then lets the person choose. Fail when it asks for a
  name or email before they chose, or explains only one of the two options.
---
