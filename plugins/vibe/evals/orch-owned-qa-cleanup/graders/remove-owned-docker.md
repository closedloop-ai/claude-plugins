---
type: regex
match: contains
flags: i
pattern: '^(?=[\s\S]*\b(?:remov|delet)\w*\b)(?=[\s\S]*\bexact\b)(?=[\s\S]*\brecorded\b)(?=[\s\S]*\b(?:recheck|check|verify|validate)\w*\b)(?=[\s\S]*\b(?:identity|ownership|witness)\w*\b)(?=[\s\S]*\bcontainers?\b)(?=[\s\S]*\bvolum(?:e|es)\b)(?=[\s\S]*\bnetwork\b)[\s\S]*$'
---

The recorded container, volumes and network are removed, not merely stopped.
