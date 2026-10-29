---
type: regex
match: contains
flags: i
pattern: 'MISSING:(?![^\n]*(?:\bdo\s+not\b|\bnever\b|\bkeep\b[^\n]*\bunpublished\b|\bno\b[^\n]*(?:PLN|implementation plan)|\brefuses?\s+to\s+(?:publish|create|upload)|\brefuses?\b[^\n]*\badd\b[^\n]*\blinks?\b))(?=[^\n]*vibe(?:-| )ticket(?:-| )worker[^\n]*plan mode)(?=[^\n]*(?:publish|create|upload))(?=[^\n]*(?:PLN|implementation plan))(?=[^\n]*ISS-14001)(?=[^\n]*(?:PRODUCES|links?))[^\n]*'
---
