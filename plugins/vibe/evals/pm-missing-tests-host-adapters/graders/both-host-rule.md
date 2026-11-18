---
type: regex
match: contains
flags: i
pattern: '(?![^\n]*(?:\b(?:web|Desktop)\b[^\n]*(?:\b(?:exempt|excluded|optional)\b|(?:\b(?:does\s+not|doesn''t)\s+(?:need|require)|\bneed\s+not\b)[^\n]*\b(?:adapters?|coverage|rule)\b)|\b(?:rule|coverage)\b[^\n]*(?:does\s+not|need\s+not|doesn''t)[^\n]*\b(?:apply|include|cover)\b|\bonly\s+(?:web|Desktop)\b[^\n]*(?:needs?|requires?)))(?=[^\n]*\bweb\b)(?=[^\n]*\bDesktop\b)(?=[^\n]*\badapters?\b)[^\n]+'
---
The explanation applies the two-host coverage rule.
