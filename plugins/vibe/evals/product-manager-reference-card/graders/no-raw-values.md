---
type: regex
target: { source: file, path: session/src/project-card.css }
pattern: ":\\s*-?\\d+(?:\\.\\d+)?px|#[0-9a-fA-F]{3,8}\\b|rgba?\\("
match: not_contains
---
No pixel, hex or rgba value was copied from the reference; only tokens.
