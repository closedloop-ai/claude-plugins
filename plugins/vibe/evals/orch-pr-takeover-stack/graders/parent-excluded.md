---
type: regex
match: contains
flags: i
pattern: 'REVIEW:.*(?:don.t review.*parent|exclude.*parent|parent.*not reviewed|parent.*not include|instead of.*origin/main)'
---
The child review leaves the parent's own changes out.
