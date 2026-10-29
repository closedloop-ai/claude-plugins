---
type: regex
match: contains
flags: i
pattern: 'C_RECORD:(?:(?=[^\n]*(?:stop|blocked|referral))(?=[^\n]*(?:clear|correct|reopen|supersed|replace|update|remove))|(?=[^\n]*record[^\n]*pending check)(?=[^\n]*stop[^\n]*referral[^\n]*premature))[^\n]*'
---
