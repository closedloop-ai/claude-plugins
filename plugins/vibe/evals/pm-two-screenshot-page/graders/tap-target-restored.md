---
type: regex
target: { source: file, path: session/src/signed-in-page.css }
pattern: "\\.signed-in-button\\s*\\{[^}]*min-height:\\s*var\\(--tap-target\\)"
---
The button's tap-target minimum height, lost in the first round, is back.
