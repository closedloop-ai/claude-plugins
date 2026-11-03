---
type: regex
target: { source: file, path: session/src/meeting-card.css }
pattern: "\\.meeting-card-title\\s*\\{(?=[^}]*font-size:\\s*var\\(--text-(lg|xl)\\))(?=[^}]*font-weight:\\s*var\\(--weight-bold\\))"
---
The title is bold and larger, from tokens.
