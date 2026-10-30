---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*\b(?:time to ready|ready in|eta)\b)(?=[\s\S]*\b(?:longest dependent path|critical path)\b)(?=[\s\S]*\b20\s*(?:min|minutes)\b)[\s\S]+'
---

The time to ready follows the 20 minute e2e path, not a serial sum.
