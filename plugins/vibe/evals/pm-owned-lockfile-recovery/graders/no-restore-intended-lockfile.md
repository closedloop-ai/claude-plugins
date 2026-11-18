---
type: regex
match: not_contains
flags: i
pattern: 'C_(?:NEXT|REPLY):[^\n]*(?<!\bno )(?<!\bnot )(?<!\bnever )(?<!n[\x27’]t )(?:restore|revert|discard|reset)(?!\w*\s+nothing\b)[^\n]*(?:lockfile|pnpm-lock)'
---
