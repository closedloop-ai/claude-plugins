#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
source "$HERE/../shared/return-page.sh"
stand_in_repo
return_page_draft
commit() { (cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "$1"); }
commit "Return page draft"
(cd session && git tag session-base)
# The session's change, as the person's pull request had it: a page-local
# shadow with raw values and its own dark override, beside a bundled token.
python3 - <<'PY'
from pathlib import Path
css = Path("session/src/return-page.css")
text = css.read_text()
text = text.replace(
    "  text-align: center;\n}\n",
    "  text-align: center;\n"
    "  --button-shadow: inset 0 1px 0 rgb(255 255 255 / 0.4), 0 1px 2px rgb(15 23 42 / 0.2);\n"
    "}\n"
    "@media (prefers-color-scheme: dark) {\n"
    "  .return-page {\n"
    "    --button-shadow: inset 0 1px 0 rgb(255 255 255 / 0.08), 0 1px 2px rgb(0 0 0 / 0.5);\n"
    "  }\n"
    "}\n",
    1,
)
text = text.replace("  border-radius: var(--radius-md);\n}\n", "  border-radius: var(--radius-md);\n  box-shadow: var(--button-shadow);\n}\n", 1)
css.write_text(text)
PY
commit "ISS-4321: Give the return button a pressed-in shadow"
cat > "session/.git/vibe-changes.md" <<'MD'
# Change log

## R-1: "give the Return to Desktop button a subtle pressed-in shadow, and make sure it looks right in dark mode too"
- Owner: src/return-page.css (the static return page). Rule: page styles stay with the page.
- Files: src/return-page.css
- Engineering needed (tokens not bundled): sign-in return page; no bundled elevation token exists, so the button defines its own shadow for light and dark.
MD
cat > session/.closedloop-ai/decision-tables/session.md <<'MD'
# Session decision table

## Rows

- R1: The Return to Desktop button looks pressed in, in light and dark. Source: R-1.

## Acceptance Criteria

- AC-1 (source: R-1): "give the Return to Desktop button a subtle pressed-in shadow"
- AC-2 (source: R-1): "make sure it looks right in dark mode too"

### Checks

- R-1, AC-1: source trace src/return-page.css box-shadow: var(--button-shadow); met
- R-1, AC-2: source trace src/return-page.css prefers-color-scheme dark override; met
MD
