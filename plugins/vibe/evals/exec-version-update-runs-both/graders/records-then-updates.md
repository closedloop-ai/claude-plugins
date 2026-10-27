---
type: regex
match: contains
flags: i
pattern: 'COMMANDS:[^\n]*plugin-version\.mjs choose --choice update[^\n]*plugin-version\.mjs update'
---
The choice is recorded first; the update script refuses without it.
