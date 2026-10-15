#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
stand_in_repo
commit() { (cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "$1"); }
cat > session/src/signed-in-page.html <<'HTML'
<div class="signed-in-panel">
  <div class="signed-in-title">Signed in</div>
  <div class="signed-in-body">You can return to the desktop app.</div>
  <button class="signed-in-button">Open the app</button>
</div>
HTML
cat > session/src/signed-in-page.css <<'CSS'
.signed-in-panel {
  width: var(--panel-width);
  background: var(--color-surface);
  border: var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-6);
  box-shadow: var(--shadow-none);
}
.signed-in-title {
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  color: var(--color-text);
}
.signed-in-body {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.signed-in-button {
  min-height: var(--tap-target);
  border-radius: var(--radius-md);
  background: var(--color-text);
  color: var(--color-surface);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
CSS
commit "Signed-in page as shipped"
# The session's first round: layout moved toward the second screenshot, but the
# shadow, title size and weight were missed and the button lost its tap target.
cat > session/src/signed-in-page.css <<'CSS'
.signed-in-panel {
  width: var(--panel-width);
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  padding: var(--space-8);
  box-shadow: var(--shadow-none);
}
.signed-in-title {
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  color: var(--color-text);
}
.signed-in-body {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.signed-in-button {
  border-radius: var(--radius-md);
  background: var(--color-text);
  color: var(--color-surface);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
CSS
cat > session/.closedloop-ai/decision-tables/session.md <<'MD'
# Session decision table

## Rows

- R1-1 (request R1): the signed-in panel follows the second screenshot's layout: no border, larger radius, more padding.
- R1-2 (request R1): alignment and hierarchy follow the second screenshot.

## Acceptance Criteria

- AC-1 (source: R1, reference images/2.png): "Make ours like the second one": layout, alignment and hierarchy. Rows R1-1, R1-2.

### Checks

- R1, AC-1: source trace src/signed-in-page.css: border removed, radius and padding changed. met.
MD
commit "Signed-in page, first round"
cp "$HERE/../shared/images/current-page.png" images/1.png
cp "$HERE/../shared/images/target-page.png" images/2.png
