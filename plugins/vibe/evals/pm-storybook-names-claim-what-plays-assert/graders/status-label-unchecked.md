---
type: regex
match: contains
flags: i
pattern: 'Branch Status From Pull Request State\s*\|\s*(narrow|complete)\s*\|[^\n]*(label|status)'
---
A status story whose play only rules out "Unknown" never checks the status each row paints, so it is completed or narrowed.
