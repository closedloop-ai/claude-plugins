---
type: regex
match: contains
flags: i
pattern: 'BACKOFF:[^\n]*(exponentialBackoffMs|exponential-backoff)'
---
The retry delay uses the shared backoff ladder.
