#!/bin/bash
# command-telemetry-parse-workdir.sh - extract workdir from $ARGUMENTS.
#
# Reads the user's slash-command arguments from the $ARGUMENTS env var and
# prints the resolved workdir to stdout. Supports two argument forms:
#
#   --workdir <path>       (e.g. /code:amend-plan --workdir foo --message ...)
#   --workdir=<path>       (e.g. /code:amend-plan --workdir=foo)
#   <first positional>     (e.g. /self-learning:process-learnings <workdir>)
#
# Returns an empty string when no workdir argument is present; init.sh's own
# precedence chain ($CLOSEDLOOP_WORKDIR env > .closedloop-ai/work default)
# then takes over.
#
# Uses Python's shlex for argv splitting so paths containing spaces survive
# quoting. Does NOT use `eval` (which would let shell metacharacters in
# untrusted arguments execute).
#
# Fail-open contract: prints empty string on any error and exits 0 so a
# missing python3 or unexpected $ARGUMENTS shape never blocks the caller.

trap 'exit 0' ERR

ARGS="${ARGUMENTS:-}"
if [[ -z "$ARGS" ]]; then
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  # No python3 — fall back to space-splitting. Paths with spaces are not
  # preserved, but this only fires when python3 is unavailable (rare on
  # developer machines). The alternative (eval-based parsing) is unsafe.
  echo "[command-telemetry-parse-workdir] warning: python3 unavailable, falling back to whitespace split" >&2
  # shellcheck disable=SC2086
  set -- $ARGS
  # Pass 1: scan for --workdir or --workdir= anywhere in the args.
  for ((i = 1; i <= $#; i++)); do
    case "${!i}" in
      --workdir)
        next_i=$((i + 1))
        if [[ $next_i -le $# ]]; then
          printf '%s' "${!next_i}"
          exit 0
        fi
        ;;
      --workdir=*)
        printf '%s' "${!i#--workdir=}"
        exit 0
        ;;
    esac
  done
  # Pass 2: position-0 positional fallback. We intentionally do NOT consider
  # later positions as candidates — they're typically the value of a
  # preceding flag (e.g. --message <value>).
  if [[ $# -ge 1 && "$1" != --* ]]; then
    printf '%s' "$1"
  fi
  exit 0
fi

python3 -c "
import os, shlex, sys
src = os.environ.get('ARGUMENTS', '')
try:
    args = shlex.split(src)
except ValueError:
    # Mismatched quotes — fall back to naive split rather than erroring.
    args = src.split()
# Pass 1: --workdir <val> or --workdir=<val>, anywhere in the args.
for i, a in enumerate(args):
    if a == '--workdir' and i + 1 < len(args):
        sys.stdout.write(args[i + 1])
        sys.exit()
    if a.startswith('--workdir='):
        sys.stdout.write(a[len('--workdir='):])
        sys.exit()
# Pass 2: position-0 positional fallback. We intentionally do NOT consider
# later positions as candidates — they're typically the value of a preceding
# flag (e.g. --message <value>).
if args and not args[0].startswith('--'):
    sys.stdout.write(args[0])
" 2>/dev/null
