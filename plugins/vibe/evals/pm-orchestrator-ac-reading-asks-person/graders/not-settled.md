---
type: regex
match: not_contains
flags: i
pattern: 'RECORD:[^\n]*(decision \(orchestrator|\bis met\b|accepted cost|\bsettled\b)'
---
The orchestrator does not record the acceptance-criterion reading or the accepted cost as its own decision.
