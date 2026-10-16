---
type: regex
match: contains
flags: i
pattern: 'STEPS:[\s\S]*(writer|vibe-change-worker)[\s\S]*vibe-guardrails-reviewer[\s\S]*push[\s\S]*(body|description)[\s\S]*\b(repl|answer|respond)'
---
The writer fixes first, then the guardrails review, then the push, then the body and the replies.
