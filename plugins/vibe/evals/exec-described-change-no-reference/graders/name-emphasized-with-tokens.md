---
type: regex
target: { source: file, path: session/src/project-card.css }
pattern: "\\.project-card-title\\s*\\{[^}]*(font-weight:\\s*var\\(--weight-(bold|medium)\\)|font-size:\\s*var\\(--text-(lg|xl)\\))"
---
The project name is emphasized with design tokens.
