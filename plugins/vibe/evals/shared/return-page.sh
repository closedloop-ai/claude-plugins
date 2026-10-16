#!/bin/bash
# The static Desktop sign-in return page's first draft: a generated page that
# loads the design tokens itself, with no shadow and a body-size regular title.
return_page_draft() {
  cat > session/src/return-page.html <<'HTML'
<div class="return-page">
  <div class="return-page-title">You're signed in</div>
  <div class="return-page-body">You can go back to the desktop app now.</div>
  <button class="return-page-button">Return to Desktop</button>
</div>
HTML
  cat > session/src/return-page.css <<'CSS'
@import "../design-system/tokens.css";
.return-page {
  width: var(--panel-width);
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  padding: var(--space-8);
  box-shadow: var(--shadow-none);
  text-align: center;
}
.return-page-title {
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  color: var(--color-text);
}
.return-page-body {
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
}
.return-page-button {
  min-height: var(--tap-target);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  background: var(--color-accent);
  color: var(--color-surface);
  border-radius: var(--radius-md);
}
CSS
}
