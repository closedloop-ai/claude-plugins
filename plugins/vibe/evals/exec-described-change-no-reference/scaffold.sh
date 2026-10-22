#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
source "$HERE/../shared/project-card.sh"
stand_in_repo
project_card_draft
(cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "Project card draft")
