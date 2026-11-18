---
type: regex
match: contains
flags: i
pattern: 'A_PROOF:(?=(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:clean|unchanged)(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:before|preceding|pre-check|pre-command)|(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:before|preceding|pre-check|pre-command)(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:clean|unchanged))(?=(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:own|session|check)(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:install|command|receipt)|(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:install|command|receipt)(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:own|session|check))(?:[^\n]|\n(?=[ \t]*[-*]\s))*'
---
