---
type: regex
flags: i
pattern: 'blocking\s*\|[^\n]*(prefers-color-scheme|dark[- ]mode override|own dark|dark override|\.dark)'
---
The page's own dark-mode override of a value the token's `.dark` block already defines is blocking.
