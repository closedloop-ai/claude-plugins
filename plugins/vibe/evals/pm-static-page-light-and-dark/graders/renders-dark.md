---
type: tool_used
tool: Bash
input_match: "screenshot\\.py[^\\n]*--theme[ =]dark|for\\s+(\\w+)\\s+in\\s+[^;\\n]*\\bdark\\b[^;\\n]*;\\s*do\\b[^\\n]*screenshot\\.py[^\\n]*--theme[ =]\\\\?\"?\\$\\{?\\1\\}?"
min: 1
---
The page was rendered in the dark theme: `--theme dark` or `--theme=dark`, or a shell loop whose list includes dark and feeds `--theme`.
