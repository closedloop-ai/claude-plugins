---
type: regex
target: { source: file, path: session/src/meeting-card.css }
pattern: "\\.meeting-card:hover\\s*(,[^{}]*)?\\{[^}]*var\\(--shadow-raised\\)"
---
Hovering raises the card with the raised elevation token.
