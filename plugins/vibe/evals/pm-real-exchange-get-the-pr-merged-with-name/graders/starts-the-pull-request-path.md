---
type: llm
criteria: |
  Grade only the REPLY line. Pass when it treats the message as a request for a pull request: it says the work will
  go to a pull request that the person takes through review and merge, and it does not treat their name as someone
  to pass the work to, ask who should pick it up, or offer to send them a branch or the ticket to merge themselves.
  Fail otherwise.
---
