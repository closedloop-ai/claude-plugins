---
type: regex
match: contains
flags: i
pattern: '^(?=[\s\S]*\b(?:time to ready|ready in|readiness|eta)\b)(?=[\s\S]*\b20\b[^\n]{0,30}\b(?:min|minutes)\b)(?=[\s\S]*(?:\blongest(?: dependent)? path\b|\bcritical path\b|\be2e(?: path)?\b[^.\n]{0,100}\b(?:set(?:s)?|determine(?:s)?)\b[^.\n]{0,80}\b(?:time|ready|readiness)\b|\b(?:set(?:s)?|determine(?:s)?)\b[^.\n]{0,80}\be2e(?: path)?\b))[\s\S]*$'
---

The time to ready follows the 20 minute e2e path, not a serial sum.
