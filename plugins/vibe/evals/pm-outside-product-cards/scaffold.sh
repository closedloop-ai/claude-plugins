#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
stand_in_repo
cat > session/src/meeting-card.html <<'HTML'
<div class="meeting-card" aria-selected="false">
  <div class="meeting-card-title">Planning</div>
  <div class="meeting-card-time">Tue 14:00</div>
</div>
HTML
cat > session/src/meeting-card.css <<'CSS'
.meeting-card {
  width: var(--card-width);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  box-shadow: var(--shadow-none);
  border: var(--border-subtle);
}
.meeting-card-title {
  font-size: var(--text-md);
  font-weight: var(--weight-regular);
  color: var(--color-text);
}
.meeting-card-time {
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
}
CSS
cp "$HERE/../shared/images/outside-cards.png" images/1.png
(cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "Meeting card")
