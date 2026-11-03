---
type: regex
target: { source: file, path: session/src/return-page.css }
pattern: "\\.return-page-title\\s*\\{[^}]*font-size:\\s*var\\(--text-xl\\)[^}]*font-weight:\\s*var\\(--weight-bold\\)|\\.return-page-title\\s*\\{[^}]*font-weight:\\s*var\\(--weight-bold\\)[^}]*font-size:\\s*var\\(--text-xl\\)"
---
The title uses the larger heading size and the bold weight tokens the reference shows.
