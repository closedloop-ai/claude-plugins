---
type: regex
match: contains
flags: i
pattern: 'STEPS:[\s\S]*repl\w*[^\n]{0,160}(SHA|commit)|STEPS:[\s\S]*(SHA|commit)[^\n]{0,160}repl'
---
Each review thread gets a reply naming the fixing commit.
