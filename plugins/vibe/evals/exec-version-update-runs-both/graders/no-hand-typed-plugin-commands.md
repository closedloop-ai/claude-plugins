---
type: regex
match: not_contains
flags: i
pattern: 'COMMANDS:[^\n]*(codex|claude)[^\n;]* plugin (add|update|marketplace)'
---
The script runs the per-harness commands and verifies them; the orchestrator never types them.
