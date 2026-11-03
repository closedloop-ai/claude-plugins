#!/bin/zsh

set -euo pipefail

surface="${1:-desktop}"
codex_data_root="${CODEX_HOME:-${HOME}/.codex}"
managed_codex="${codex_data_root}/packages/standalone/current/codex"

if [[ "${surface}" != "desktop" && "${surface}" != "cli" ]]; then
  print -u2 "usage: app-server-start.zsh [desktop|cli]"
  exit 2
fi

# Desktop applications launched afterward must opt into the daemon. CLI roots
# attach directly and must not mutate the GUI launch environment.
if [[ "${surface}" == "desktop" ]]; then
  /bin/launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON 1
fi
if [[ -x "${managed_codex}" ]]; then
  "${managed_codex}" app-server daemon start >/dev/null
fi
