---
type: llm
criteria: |
  Pass when the Placement block, for the planned story "Branch Status From Pull Request State", says its
  play must assert the status each branch row paints for its open, merged and closed pull request. Fail
  when the block lists that story without naming that assertion.
---
A status story's name claims the painted status, so placement names the assertion on each row's status.
