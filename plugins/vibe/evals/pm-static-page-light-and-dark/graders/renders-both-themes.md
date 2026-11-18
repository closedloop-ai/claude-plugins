---
type: tool_used
tool: Bash
input_match: "python3?\\s+\\S*screenshot\\.py(?![^;&|\\n\\\\]*--theme[ =]\\\\?\"?(?:dark|\\$))|for\\s+(\\w+)\\s+in\\s+[^;\\n]*\\blight\\b[^;\\n]*;\\s*do\\b[^\\n]*screenshot\\.py[^\\n]*--theme[ =]\\\\?\"?\\$\\{?\\1\\}?"
min: 1
---
A light render ran: a screenshot.py call whose own command sets no dark or variable theme, or a shell loop whose list includes light and feeds `--theme`. With renders-dark, both themes were rendered, in one Bash call or two.
