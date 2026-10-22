---
type: regex
match: not_contains
flags: i
pattern: 'IN_REVIEW:[^\n]*(ISS-9001|ISS-9003)'
---
A child with a pending item or unproven activity never moves to In Review.
