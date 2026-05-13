#!/bin/bash
# sync-shared-telemetry.sh
#
# Copies shared telemetry scripts from plugins/code/scripts/ into the
# scripts/ directories of plugins that consume them (bootstrap, code-review,
# self-learning). Each copy is prepended with an auto-generated header so
# readers know not to edit the copy directly.
#
# Usage: bash scripts/sync-shared-telemetry.sh
# Run from the repository root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/plugins/code/scripts"

SOURCE_FILES=(
  "command-telemetry-init.sh"
  "command-telemetry-complete.sh"
  "record_run.sh"
  "telemetry-helpers.sh"
)

TARGET_PLUGIN_DIRS=(
  "${REPO_ROOT}/plugins/bootstrap/scripts"
  "${REPO_ROOT}/plugins/code-review/scripts"
  "${REPO_ROOT}/plugins/self-learning/scripts"
)

main() {
  for target_dir in "${TARGET_PLUGIN_DIRS[@]}"; do
    mkdir -p "${target_dir}"
    for filename in "${SOURCE_FILES[@]}"; do
      src="${SOURCE_DIR}/${filename}"
      dst="${target_dir}/${filename}"

      if [[ ! -f "${src}" ]]; then
        echo "WARNING: source file not found, skipping: ${src}" >&2
        continue
      fi

      # Determine the relative source path for the header comment
      rel_src="plugins/code/scripts/${filename}"

      # Build header — inserted after the shebang line (if present) so the
      # file remains executable and the shebang stays on line 1.
      header="# AUTO-GENERATED — DO NOT EDIT.
# Source: ${rel_src}
# Run scripts/sync-shared-telemetry.sh to update."

      # Check whether the first line is a shebang
      first_line="$(head -n 1 "${src}")"
      if [[ "${first_line}" == "#!"* ]]; then
        # Write: shebang, blank line, header, blank line, rest of file
        {
          echo "${first_line}"
          echo ""
          echo "${header}"
          echo ""
          tail -n +2 "${src}"
        } > "${dst}"
      else
        # No shebang — prepend header then the full file
        {
          echo "${header}"
          echo ""
          cat "${src}"
        } > "${dst}"
      fi

      # Preserve executable permission from source
      if [[ -x "${src}" ]]; then
        chmod +x "${dst}"
      fi

      echo "Synced: ${rel_src} -> ${dst#"${REPO_ROOT}/"}"
    done
  done

  echo "Done."
}

main "$@"
