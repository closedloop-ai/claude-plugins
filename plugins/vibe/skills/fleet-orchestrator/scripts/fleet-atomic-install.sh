#!/usr/bin/env bash
# Install one staged plugin tree without exposing partial files or rewriting identical files.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: fleet-atomic-install.sh <stage> <target>" >&2; exit 2; }
stage=$1 target=$2 lock=$2.ship-lock
[ -f "$stage/files" ] || { echo "fleet atomic install: staged files manifest is missing" >&2; exit 2; }
mkdir -p "$target"
acquired=
for _ in $(seq 1 600); do
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock/pid"
    acquired=1
    break
  fi
  if [ -f "$lock/pid" ] && ! kill -0 "$(cat "$lock/pid")" 2>/dev/null; then rm -rf "$lock"; fi
  sleep 0.05
done
[ -n "$acquired" ] || { echo "fleet atomic install: host-wide ship lock stayed held" >&2; exit 75; }
cleanup() { rm -rf "$lock" "$stage"; }
trap cleanup EXIT HUP INT TERM
while IFS= read -r -d '' source_file; do
  relative=${source_file#"$stage"/}
  target_file=$target/$relative
  [ -f "$source_file" ] || { echo "fleet atomic install: staged file is missing: $relative" >&2; exit 2; }
  if [ -f "$target_file" ] && cmp -s "$source_file" "$target_file"; then continue; fi
  mkdir -p "$(dirname "$target_file")"
  temporary=$(mktemp "${target_file}.ship.XXXXXX")
  cp -p "$source_file" "$temporary"
  mv -f "$temporary" "$target_file"
done < <(find "$stage" -type f ! -path "$stage/files" -print0)
