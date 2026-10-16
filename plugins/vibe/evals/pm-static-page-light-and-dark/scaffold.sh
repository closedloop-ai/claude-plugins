#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
source "$HERE/../shared/return-page.sh"
stand_in_repo
return_page_draft
cp "$HERE/../shared/images/return-page.png" images/1.png
(cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "Return page draft")
