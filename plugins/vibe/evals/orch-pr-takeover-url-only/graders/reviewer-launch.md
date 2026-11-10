---
type: regex
match: contains
flags: i
pattern: 'STEPS:(?=[\s\S]*\bsessionless\b)(?=[\s\S]*\btakeover\b)(?=[\s\S]*\bhead(?:Sha| SHA| commit)\b)(?=[\s\S]*review-receipts)'
---
The reviewers launch through the launcher's sessionless takeover route bound to the PR head, and their results become review receipts.
