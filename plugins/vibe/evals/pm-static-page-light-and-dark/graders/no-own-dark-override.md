---
type: regex
target: { source: file, path: session/src/return-page.css }
pattern: "prefers-color-scheme|\\.dark\\b"
match: not_contains
---
Dark mode comes from the bundled tokens' `.dark` values, never a page-local dark override.
