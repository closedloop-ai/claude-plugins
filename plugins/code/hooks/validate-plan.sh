#!/bin/bash

# Plan Validation Script
# Validates plan.json against quality criteria and PRD requirements
#
# Usage: validate-plan.sh [PRD_FILE] [WORKDIR]

set -euo pipefail

PRD_FILE="${1:-prd.pdf}"
WORKDIR="${2:-.}"
PLAN_FILE="$WORKDIR/plan.json"

ISSUES=()
WARNINGS=()

# Helper function to add issue
add_issue() {
  ISSUES+=("$1")
}

add_warning() {
  WARNINGS+=("$1")
}

# Check if plan.json exists
if [[ ! -f "$PLAN_FILE" ]]; then
  add_issue "CRITICAL: plan.json does not exist"
  echo "VALIDATION: FAIL"
  echo ""
  echo "Issues found:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
  exit 0
fi

# Check if PRD exists
if [[ ! -f "$PRD_FILE" ]]; then
  add_warning "PRD file not found: $PRD_FILE (cannot verify PRD coverage)"
fi

# =============================================================================
# EXTRACT CONTENT FROM JSON
# =============================================================================

# plan.json is a JSON file with markdown in the "content" field
# Extract the content field for validation
CONTENT=$(jq -r '.content // empty' "$PLAN_FILE" 2>/dev/null)
if [[ -z "$CONTENT" ]]; then
  add_issue "CRITICAL: plan.json missing 'content' field or invalid JSON"
  echo "VALIDATION: FAIL"
  echo ""
  echo "Issues found:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
  exit 0
fi

# =============================================================================
# STRUCTURAL CHECKS (on markdown content)
# =============================================================================

# Check for Open Questions section in content
if ! echo "$CONTENT" | grep -q "^## Open Questions"; then
  add_issue "Missing '## Open Questions' section (required even if empty)"
fi

# Check for task checkbox format in content
TASK_LINES=$(echo "$CONTENT" | grep -E "^[[:space:]]*-[[:space:]]" | grep -v "^[[:space:]]*-[[:space:]]\[" || true)
if [[ -n "$TASK_LINES" ]]; then
  # Count non-checkbox list items that look like tasks (not just sub-bullets under checkboxes)
  NON_CHECKBOX_COUNT=$(echo "$TASK_LINES" | grep -v "^[[:space:]]*-[[:space:]].*:" | wc -l | tr -d ' ')
  if [[ "$NON_CHECKBOX_COUNT" -gt 5 ]]; then
    add_issue "Multiple tasks not using checkbox format (found $NON_CHECKBOX_COUNT). Use '- [ ]' or '- [x]' format"
  fi
fi

# Check for incomplete checkboxes (should have content) in content
EMPTY_CHECKBOXES=$(echo "$CONTENT" | grep -E "^[[:space:]]*-[[:space:]]\[[[:space:]x]\][[:space:]]*$" || true)
if [[ -n "$EMPTY_CHECKBOXES" ]]; then
  add_issue "Found empty checkbox items with no description"
fi

# =============================================================================
# ARCHITECTURE CHECKS (on markdown content)
# =============================================================================

# Check for new file creation without justification
NEW_FILE_MENTIONS=$(echo "$CONTENT" | grep -iE "(create|new|add)[[:space:]]+(a[[:space:]]+)?(new[[:space:]]+)?(file|component|module|class)" || true)
if [[ -n "$NEW_FILE_MENTIONS" ]]; then
  # Check if there's architecture/rationale discussion
  if ! echo "$CONTENT" | grep -qiE "(rationale|reason|because|justif|extend|exist)"; then
    add_warning "Plan mentions creating new files but lacks rationale. Consider whether existing files can be extended."
  fi
fi

# Check for potential duplication patterns
if echo "$CONTENT" | grep -qiE "copy|duplicate|similar to|based on|like[[:space:]]+(the|existing)"; then
  add_warning "Plan mentions copying/duplicating code. Consider extracting shared utilities instead."
fi

# =============================================================================
# COMPLETENESS CHECKS (on markdown content)
# =============================================================================

# Check for TODO/TBD/placeholder markers
PLACEHOLDERS=$(echo "$CONTENT" | grep -iE "\b(TODO|TBD|FIXME|placeholder|to be determined|fill in)\b" || true)
if [[ -n "$PLACEHOLDERS" ]]; then
  PLACEHOLDER_COUNT=$(echo "$PLACEHOLDERS" | wc -l | tr -d ' ')
  add_issue "Found $PLACEHOLDER_COUNT placeholder/TODO markers in plan. All tasks must be fully specified."
fi

# Check Open Questions format (should use checkboxes)
OPEN_QUESTIONS_SECTION=$(echo "$CONTENT" | sed -n '/^## Open Questions/,/^## /p' | sed '$d')
if [[ -n "$OPEN_QUESTIONS_SECTION" ]]; then
  # Check for non-checkbox questions (lines starting with - but not - [ ] or - [x])
  BAD_QUESTIONS=$(echo "$OPEN_QUESTIONS_SECTION" | grep -E "^[[:space:]]*-[[:space:]][^\[]" || true)
  if [[ -n "$BAD_QUESTIONS" ]]; then
    add_issue "Open Questions must use checkbox format: '- [ ] Q-XXX: question' or '- [x] Q-XXX: question **Answer: ...**'"
  fi
fi

# =============================================================================
# OUTPUT RESULTS
# =============================================================================

echo ""

if [[ ${#ISSUES[@]} -eq 0 ]] && [[ ${#WARNINGS[@]} -eq 0 ]]; then
  echo "VALIDATION: PASS"
  echo ""
  echo "Plan meets all quality criteria."
elif [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "VALIDATION: PASS (with warnings)"
  echo ""
  echo "Warnings (non-blocking):"
  for warning in "${WARNINGS[@]}"; do
    echo "  - $warning"
  done
else
  echo "VALIDATION: FAIL"
  echo ""
  echo "Issues to fix (${#ISSUES[@]}):"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo ""
    echo "Warnings (${#WARNINGS[@]}):"
    for warning in "${WARNINGS[@]}"; do
      echo "  - $warning"
    done
  fi
fi

exit 0
