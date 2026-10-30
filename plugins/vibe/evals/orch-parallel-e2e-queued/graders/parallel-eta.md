---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*(?:time to ready|ready in|eta)[^\n]{0,45}20\s*(?:min|minutes)\b)(?=[\s\S]*(?:longest dependent path|critical path)[^\n]{0,120}(?:wait|e2e))[\s\S]+'
---

The time to ready follows the 20 minute e2e path, not a serial sum.
