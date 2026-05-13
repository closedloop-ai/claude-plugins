#!/bin/bash
# test_command_telemetry_init.sh - Unit tests for command-telemetry-init.sh
#
# Tests:
#   1. Workdir resolution precedence: arg > CLOSEDLOOP_WORKDIR env > default
#   2. .cmd-state.env creation with correct fields
#   3. Run ID generation (uuidgen path and fallback path)
#   4. Fail-open behavior on errors
#
# Usage:
#   bash plugins/code/scripts/tests/test_command_telemetry_init.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT_SCRIPT="${SCRIPT_DIR}/../command-telemetry-init.sh"

# ── Helpers ─────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
_errors=()

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); _errors+=("$1"); }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$desc"
  else
    fail "$desc (expected='$expected', actual='$actual')"
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$desc"
  else
    fail "$desc (file not found: $path)"
  fi
}

assert_file_contains() {
  local desc="$1" path="$2" pattern="$3"
  if grep -q "$pattern" "$path" 2>/dev/null; then
    pass "$desc"
  else
    fail "$desc (pattern '$pattern' not found in $path)"
  fi
}

assert_nonempty() {
  local desc="$1" value="$2"
  if [[ -n "$value" ]]; then
    pass "$desc"
  else
    fail "$desc (value was empty)"
  fi
}

# ── Test Suite ───────────────────────────────────────────────────────────────

echo ""
echo "=== command-telemetry-init.sh unit tests ==="
echo ""

# ── 1. Workdir resolution: arg takes precedence over env and default ─────────

echo "--- 1. Workdir resolution precedence ---"

# 1a. Explicit arg wins over env
T1A=$(mktemp -d)
T1A_ENV=$(mktemp -d)
T1A_DEFAULT=$(mktemp -d)

T1A_OUT=$(mktemp)
(
  set +euo pipefail
  export CLOSEDLOOP_WORKDIR="$T1A_ENV"
  unset CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID
  cd "$T1A_DEFAULT"

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand" "$T1A"
  # Verify state file was written to the arg workdir, not the env one
  if [[ -f "${T1A}/.cmd-state.env" ]]; then
    echo "ARG_WINS=yes"
  else
    echo "ARG_WINS=no"
  fi
  rm -rf "$STUB_DIR"
) > "$T1A_OUT" 2>/dev/null

ARG_WINS=$(grep "ARG_WINS=" "$T1A_OUT" | cut -d= -f2 || echo "no")
assert_eq "1a: arg workdir takes precedence over CLOSEDLOOP_WORKDIR env" "yes" "$ARG_WINS"
rm -rf "$T1A" "$T1A_ENV" "$T1A_DEFAULT" "$T1A_OUT" 2>/dev/null || true

# 1b. CLOSEDLOOP_WORKDIR env wins over default (no arg)
T1B_ENV=$(mktemp -d)
T1B_DEFAULT=$(mktemp -d)

T1B_OUT=$(mktemp)
(
  set +euo pipefail
  export CLOSEDLOOP_WORKDIR="$T1B_ENV"
  unset CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  cd "$T1B_DEFAULT"
  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand"
  if [[ -f "${T1B_ENV}/.cmd-state.env" ]]; then
    echo "ENV_WINS=yes"
  else
    echo "ENV_WINS=no"
  fi
  rm -rf "$STUB_DIR"
) > "$T1B_OUT" 2>/dev/null

ENV_WINS=$(grep "ENV_WINS=" "$T1B_OUT" | cut -d= -f2 || echo "no")
assert_eq "1b: CLOSEDLOOP_WORKDIR env wins when no arg provided" "yes" "$ENV_WINS"
rm -rf "$T1B_ENV" "$T1B_DEFAULT" "$T1B_OUT" 2>/dev/null || true

# 1c. Default (PWD/.closedloop-ai/telemetry) used when no arg and no env
T1C_DEFAULT=$(mktemp -d)

T1C_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  cd "$T1C_DEFAULT"
  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand"
  EXPECTED_DEFAULT="${T1C_DEFAULT}/.closedloop-ai/telemetry/.cmd-state.env"
  if [[ -f "$EXPECTED_DEFAULT" ]]; then
    echo "DEFAULT_WINS=yes"
  else
    echo "DEFAULT_WINS=no"
  fi
  rm -rf "$STUB_DIR"
) > "$T1C_OUT" 2>/dev/null

DEFAULT_WINS=$(grep "DEFAULT_WINS=" "$T1C_OUT" | cut -d= -f2 || echo "no")
assert_eq "1c: default workdir (PWD/.closedloop-ai/telemetry) used as fallback" "yes" "$DEFAULT_WINS"
rm -rf "$T1C_DEFAULT" "$T1C_OUT" 2>/dev/null || true

echo ""

# ── 2. .cmd-state.env creation: all four fields present ─────────────────────

echo "--- 2. .cmd-state.env field verification ---"

T2=$(mktemp -d)

(
  set +euo pipefail 2>/dev/null
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "my_command" "$T2"
  rm -rf "$STUB_DIR"
) >/dev/null 2>&1

STATE_FILE="${T2}/.cmd-state.env"

assert_file_exists "2a: .cmd-state.env was created" "$STATE_FILE"

if [[ -f "$STATE_FILE" ]]; then
  assert_file_contains "2b: .cmd-state.env contains CLOSEDLOOP_WORKDIR" "$STATE_FILE" "^CLOSEDLOOP_WORKDIR="
  assert_file_contains "2c: .cmd-state.env contains CLOSEDLOOP_CMD_START" "$STATE_FILE" "^CLOSEDLOOP_CMD_START="
  assert_file_contains "2d: .cmd-state.env contains CLOSEDLOOP_RUN_ID" "$STATE_FILE" "^CLOSEDLOOP_RUN_ID="
  assert_file_contains "2e: .cmd-state.env contains CLOSEDLOOP_COMMAND" "$STATE_FILE" "^CLOSEDLOOP_COMMAND="
  # CLOSEDLOOP_COMMAND value should match what was passed in
  assert_file_contains "2f: .cmd-state.env CLOSEDLOOP_COMMAND has correct value" "$STATE_FILE" "^CLOSEDLOOP_COMMAND=my_command$"
  # CLOSEDLOOP_WORKDIR value should match the resolved workdir
  assert_file_contains "2g: .cmd-state.env CLOSEDLOOP_WORKDIR has correct value" "$STATE_FILE" "^CLOSEDLOOP_WORKDIR=${T2}$"
fi

rm -rf "$T2"
echo ""

# ── 3. Run ID generation ─────────────────────────────────────────────────────

echo "--- 3. Run ID generation ---"

T3=$(mktemp -d)

T3_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand" "$T3"
  echo "CLOSEDLOOP_RUN_ID=${CLOSEDLOOP_RUN_ID:-}"
  rm -rf "$STUB_DIR"
) > "$T3_OUT" 2>/dev/null

RUN_ID_VAL=$(grep "^CLOSEDLOOP_RUN_ID=" "$T3_OUT" | cut -d= -f2- || echo "")
assert_nonempty "3a: CLOSEDLOOP_RUN_ID is non-empty after sourcing" "$RUN_ID_VAL"

if [[ -n "$RUN_ID_VAL" ]]; then
  # A UUID (from uuidgen) looks like 8-4-4-4-12 hex chars (lowercased)
  # The fallback looks like YYYYMMDD-HHMMSS-<hex>
  # Either way it should be at least 10 chars and contain only hex, hyphens, colons
  if echo "$RUN_ID_VAL" | grep -qE '^[0-9a-f-]{10,}$'; then
    pass "3b: run ID matches expected format (UUID or timestamp-fallback)"
  else
    fail "3b: run ID format unexpected: '$RUN_ID_VAL'"
  fi
fi

# 3c: Fallback run ID when uuidgen is unavailable
T3C=$(mktemp -d)
T3C_OUT=$(mktemp)

(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  # Patch the init script: replace `command -v uuidgen` with a failing check
  sed 's/command -v uuidgen/command -v __no_such_cmd_uuidgen__/g' \
    "$INIT_SCRIPT" > "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand" "$T3C"
  echo "FALLBACK_RUN_ID=${CLOSEDLOOP_RUN_ID:-}"
  rm -rf "$STUB_DIR"
) > "$T3C_OUT" 2>/dev/null

FALLBACK_RUN_ID=$(grep "^FALLBACK_RUN_ID=" "$T3C_OUT" | cut -d= -f2- || echo "")
assert_nonempty "3c: fallback run ID is non-empty when uuidgen unavailable" "$FALLBACK_RUN_ID"
rm -rf "$T3" "$T3C" "$T3_OUT" "$T3C_OUT" 2>/dev/null || true
echo ""

# ── 4. Fail-open behavior ────────────────────────────────────────────────────

echo "--- 4. Fail-open behavior ---"

# 4a: Missing command name does not abort caller (script sources cleanly)
T4A=$(mktemp -d)

T4A_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  # Source with no arguments — should not abort the subshell
  source "${STUB_DIR}/command-telemetry-init.sh"
  echo "AFTER_SOURCE=reached"
  rm -rf "$STUB_DIR"
) > "$T4A_OUT" 2>/dev/null

AFTER_SOURCE=$(grep "AFTER_SOURCE=" "$T4A_OUT" | cut -d= -f2 || echo "")
assert_eq "4a: sourcing with no command name does not abort caller (returns 0)" "reached" "$AFTER_SOURCE"
rm -rf "$T4A" "$T4A_OUT" 2>/dev/null || true

# 4b: Unwritable workdir does not abort caller
T4B_PARENT=$(mktemp -d)
T4B_UNWRITABLE="${T4B_PARENT}/no_write_dir"
mkdir -p "$T4B_UNWRITABLE"
chmod 000 "$T4B_UNWRITABLE" 2>/dev/null || true

T4B_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  cat > "${STUB_DIR}/record_run.sh" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_DIR}/record_run.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand" "${T4B_UNWRITABLE}/subdir"
  echo "UNWRITABLE_AFTER=reached"
  rm -rf "$STUB_DIR"
) > "$T4B_OUT" 2>/dev/null

UNWRITABLE_AFTER=$(grep "UNWRITABLE_AFTER=" "$T4B_OUT" | cut -d= -f2 || echo "")
assert_eq "4b: unwritable workdir path does not abort caller" "reached" "$UNWRITABLE_AFTER"
chmod 755 "$T4B_UNWRITABLE" 2>/dev/null || true
rm -rf "$T4B_PARENT" "$T4B_OUT" 2>/dev/null || true

# 4c: Missing record_run.sh does not abort caller
T4C=$(mktemp -d)

T4C_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  # Copy init script to a temp dir with no record_run.sh beside it
  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"
  # Deliberately do NOT create record_run.sh

  source "${STUB_DIR}/command-telemetry-init.sh" "mycommand" "$T4C"
  echo "NO_RECORD_RUN_AFTER=reached"
  rm -rf "$STUB_DIR"
) > "$T4C_OUT" 2>/dev/null

NO_RECORD_RUN_AFTER=$(grep "NO_RECORD_RUN_AFTER=" "$T4C_OUT" | cut -d= -f2 || echo "")
assert_eq "4c: missing record_run.sh does not abort caller" "reached" "$NO_RECORD_RUN_AFTER"
rm -rf "$T4C" "$T4C_OUT" 2>/dev/null || true

# 4d: Exported vars are set even when record_run.sh is absent
T4D=$(mktemp -d)

T4D_OUT=$(mktemp)
(
  set +euo pipefail
  unset CLOSEDLOOP_WORKDIR CLOSEDLOOP_COMMAND CLOSEDLOOP_RUN_ID

  STUB_DIR=$(mktemp -d)
  cp "$INIT_SCRIPT" "${STUB_DIR}/command-telemetry-init.sh"

  source "${STUB_DIR}/command-telemetry-init.sh" "check_cmd" "$T4D"
  echo "CMD_EXPORT=${CLOSEDLOOP_COMMAND:-}"
  echo "RUN_ID_EXPORT=${CLOSEDLOOP_RUN_ID:-}"
  rm -rf "$STUB_DIR"
) > "$T4D_OUT" 2>/dev/null

CMD_EXPORT=$(grep "^CMD_EXPORT=" "$T4D_OUT" | cut -d= -f2- || echo "")
RUN_ID_EXPORT=$(grep "^RUN_ID_EXPORT=" "$T4D_OUT" | cut -d= -f2- || echo "")
assert_eq "4d: CLOSEDLOOP_COMMAND exported even when record_run.sh absent" "check_cmd" "$CMD_EXPORT"
assert_nonempty "4e: CLOSEDLOOP_RUN_ID exported even when record_run.sh absent" "$RUN_ID_EXPORT"
rm -rf "$T4D" "$T4D_OUT" 2>/dev/null || true

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "${#_errors[@]}" -gt 0 ]]; then
  echo "Failed tests:"
  for e in "${_errors[@]}"; do
    echo "  - $e"
  done
  echo ""
  exit 1
fi

exit 0
