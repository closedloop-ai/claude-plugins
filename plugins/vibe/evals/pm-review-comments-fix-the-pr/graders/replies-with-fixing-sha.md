---
type: regex
match: contains
flags: i
pattern: 'STEPS:[\s\S]*\b(repl|answer|respond)\w*[\s\S]{0,300}(SHA|commit)|STEPS:[\s\S]*(SHA|commit)[\s\S]{0,300}\b(repl|answer|respond)'
---
Each review thread gets a reply naming the fixing commit.
