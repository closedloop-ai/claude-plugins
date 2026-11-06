---
type: regex
match: contains
flags: i
pattern: '^CLAIM:(?![^\n]*(?:(?:do\s+not|don''t|never|skip|avoid|refrain(?:\s+from)?)[^\n]*(?:assign|IN_PROGRESS|RELATES_TO|link|comment)|leave\s+untouched))(?=[^\n]*ISS-9001)(?=[^\n]*(?:ASSIGN:\s*(?:operator-1|operator)|\bassign(?:s|ed|ing)?\b[^\n]*(?:operator-1|operator)))(?=[^\n]*(?:STATUS:\s*IN_PROGRESS|\b(?:set|sets|setting|move|moves|moved|moving|mark|marks|marked|marking)\b[^\n]*IN_PROGRESS))(?=[^\n]*(?:(?:RELATES_TO|LINK):\s*ISS-9000|\b(?:link|links|linked|linking)\b[^\n]*ISS-9000|ISS-9000[^\n]*\b(?:link|links|linked|linking)\b))(?=[^\n]*(?:COMMENT:(?!\s*(?:none|no|skip|avoid|refrain)\b)\s*[^;\n]+|\bcomment(?:s|ed|ing)?\s+that\b|\b(?:add|adds|added|adding|leave|leaves|left|post|posts|posted|posting|write|writes|wrote|written|writing)\b[^\n]*\bcomment\b))[^\n]+(?=\n|$)'
---
The untouched included child is claimed with all required mutations.
