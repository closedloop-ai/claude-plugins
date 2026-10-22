---
type: regex
target: { source: file, path: session/src/return-page.css }
pattern: ":\\s*-?\\d+(?:\\.\\d+)?px|#[0-9a-fA-F]{3,8}\\b|rgba?\\("
match: not_contains
---
No pixel, hex or rgb value on the page; only tokens.
