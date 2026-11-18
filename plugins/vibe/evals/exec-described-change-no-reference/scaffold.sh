#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../shared/stand-in-repo.sh"
source "$HERE/../shared/project-card.sh"
stand_in_repo
project_card_draft
# Ruled fixture change (ISS-14162, operator ruling 2026-11-15): the stand-in
# relays the writer's result as the orchestrator, so the person's message
# follows vibe's plain-words rules. The prompt and graders are unchanged.
cat >> session/AGENTS.md <<'MD'

## Who sends what in this session

There is no separate writer to launch here, so you play both of vibe's roles
in turn. First you are the writer: make the change and record it in the
session decision table. The writer's result (the files, tokens and decision
table rows it touched) is what the writer returns to the orchestrator with
`DONE`; it is never sent to the person as written. Then you are the
orchestrator: the writer returned `DONE`, and your final message relays that
result to the person. Every word the person sees follows vibe's
`references/plain-words.md`, including worker text you relay.
MD
# Ruled fixture change (ISS-14162, Q-14162-10 (C), operator ruling 2026-11-15,
# "Fix the fixtures"): the session's live copy of the app is already deployed,
# so the ready message has a real link. The session record holds the verified
# app URL that `vibe-sessions.mjs link --page /projects` reads; the AGENTS.md
# line below states the same page. Ruled fixture change (Q-14162-13, 2026-11-15):
# its last sentence mirrors vibe's deploy-on-finish (SKILL.md section 6).
APP_URL="https://app-stage-git-vibe-stand-in.preview.closedloop-stage.ai"
cat >> session/AGENTS.md <<MD

## The live copy of the app

This session's live copy of the app is already deployed and verified. The
project card is on the projects page: ${APP_URL}/projects
Every change you make in this session is deployed to this live copy automatically as soon as you finish it, so it is there before the person reads your message.
MD
(cd session && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "Project card draft" \
  && printf '{"worktree":"%s","branch":"vibe/stand-in","status":"active","vercel":{"appUrl":"%s","verifiedAt":"2026-11-15T00:00:00Z","lastDeployedCommit":"%s"}}\n' \
    "$PWD" "$APP_URL" "$(git rev-parse HEAD)" > .git/vibe-session.json)
