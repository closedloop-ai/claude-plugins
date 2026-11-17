#!/usr/bin/env bash
# Publish one complete staged plugin generation and atomically switch its pointer.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: fleet-atomic-install.sh <stage> <target>" >&2; exit 2; }
stage=$1 target=$2 lock=$2.ship-lock pointer=$2.current generations=$2.generations
[ -f "$stage/files" ] || { echo "fleet atomic install: staged files manifest is missing" >&2; exit 2; }
[ ! -L "$stage" ] && [ -d "$stage" ] || { echo "fleet atomic install: stage must be a real directory" >&2; exit 2; }
[ -z "$(find "$stage" -type l -print -quit)" ] || { echo "fleet atomic install: staged symlinks are not allowed" >&2; exit 2; }
while IFS= read -r relative; do
  case "$relative" in ''|/*|../*|*/../*|*/..) echo "fleet atomic install: invalid staged path: $relative" >&2; exit 2;; esac
  [ -f "$stage/$relative" ] || { echo "fleet atomic install: staged file is missing: $relative" >&2; exit 2; }
done < "$stage/files"
mkdir -p "$generations"
candidate=$lock.candidate.$$
cleanup() {
  if [ -f "$lock" ] && [ "$(cat "$lock" 2>/dev/null)" = "$$" ]; then rm -f "$lock"; fi
  rm -f "$candidate"
  rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" > "$candidate"
acquired=
for _ in $(seq 1 600); do
  if ln "$candidate" "$lock" 2>/dev/null; then
    acquired=1
    break
  fi
  if [ -f "$lock" ] && ! kill -0 "$(cat "$lock")" 2>/dev/null; then rm -f "$lock"; fi
  sleep 0.05
done
[ -n "$acquired" ] || { echo "fleet atomic install: host-wide ship lock stayed held" >&2; exit 75; }

current=
if [ -L "$pointer" ]; then
  current=$(readlink "$pointer")
  [ -d "$current" ] || { echo "fleet atomic install: current generation is missing" >&2; exit 2; }
elif [ -e "$pointer" ]; then
  echo "fleet atomic install: current pointer is not a symlink" >&2
  exit 2
fi

trees_equal() {
  [ -n "$current" ] || return 1
  local source_file relative stage_count=0 current_count
  while IFS= read -r -d '' source_file; do
    relative=${source_file#"$stage"/}
    [ -f "$current/$relative" ] && cmp -s "$source_file" "$current/$relative" || return 1
    stage_count=$((stage_count + 1))
  done < <(find "$stage" -type f ! -path "$stage/files" -print0)
  current_count=$(find "$current" -type f ! -path "$current/files" | wc -l | tr -d ' ')
  [ "$stage_count" -eq "$current_count" ]
}

if trees_equal; then
  printf '%s\n' "$current"
  exit 0
fi

generation=$generations/generation-$(date +%s)-$$
mv "$stage" "$generation"
temporary=$pointer.ship.$$
ln -s "$generation" "$temporary"
if mv -fT "$temporary" "$pointer" 2>/dev/null; then
  : # GNU mv replaces the symlink itself with -T.
elif mv -fh "$temporary" "$pointer" 2>/dev/null; then
  : # BSD mv replaces the symlink itself with -h.
else
  rm -f "$temporary"
  echo "fleet atomic install: could not switch the generation pointer" >&2
  exit 1
fi
printf '%s\n' "$generation"
