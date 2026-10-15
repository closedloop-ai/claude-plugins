---
type: llm
criteria: |
  Grade only the REPLY line. Pass when it treats the message as a request for a pull request: it says the work will
  go to a pull request that the person takes through review and merge, and it does not treat their name as someone
  to pass the work to or ask who should pick it up. Saying it will send the pull request link together with the
  ticket and app links is fine. Fail when it offers a branch, or the ticket, for the person to merge instead of a
  pull request.
---
