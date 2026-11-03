#!/bin/bash
# The project card's first draft: no shadow, a body-size regular title.
project_card_draft() {
  cat > session/src/project-card.html <<'HTML'
<div class="project-card">
  <div class="project-card-title">Quarterly roadmap</div>
  <div class="project-card-body">Twelve items planned, four in progress. Updated two days ago.</div>
</div>
HTML
  cat > session/src/project-card.css <<'CSS'
.project-card {
  width: var(--card-width);
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  box-shadow: var(--shadow-none);
}
.project-card-title {
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  color: var(--color-text);
}
.project-card-body {
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
}
CSS
}
