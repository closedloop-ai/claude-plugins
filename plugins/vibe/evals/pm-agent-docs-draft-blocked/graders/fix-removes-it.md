---
type: regex
match: contains
flags: i
pattern: 'blocking\s*\|[^\n]*documents\.mdx[^\n]*(remov|revert|delet|drop|undo)'
---
The fix removes the drafted paragraph rather than keeping it behind markers.
