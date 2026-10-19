---
type: regex
match: contains
flags: i
pattern: '(?:^|\n)\s*\d+\.\s*`?(?:mcp__[a-z_-]+__)?create[-_]artifact[-_]link(?=[^\n]*sourceId\W{0,4}(?:PRD-718|11111111-2222-4333-8444-555555555555))(?=[^\n]*targetId\W{0,4}ISS-12640)(?=[^\n]*PRODUCES)'
---
The PRD the session started from produces the live ticket.
