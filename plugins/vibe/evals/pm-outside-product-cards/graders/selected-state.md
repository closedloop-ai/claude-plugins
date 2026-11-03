---
type: regex
target: { source: file, path: session/src/meeting-card.css }
pattern: "\\.meeting-card(\\[aria-selected=\"true\"\\]|\\.is-selected)\\s*(,[^{}]*)?\\{[^}]*var\\(--border-selected\\)"
---
The selected card uses the selected border token.
