#!/usr/bin/env python3
"""Validate plan.json structure and extract data for the orchestrator.

Performs all deterministic validation that the plan-validator agent does
(Steps 1-5: JSON parsing, schema validation, task checkbox regex, required
sections, sync validation, and data extraction) using pure Python. Only the
semantic consistency check (Step 6: storage/query alignment, task/architecture
contradictions) requires LLM reasoning and is left to the agent.

Usage:
    python3 validate_plan.py <WORKDIR> [--auto-sync] [--schema-path <path>]

Output (JSON to stdout):
    Same format as plan-validator agent output.
"""
from __future__ import annotations

import json
import os
import re
import sys


REQUIRED_FIELDS = [
    "content",
    "acceptanceCriteria",
    "pendingTasks",
    "completedTasks",
    "openQuestions",
    "answeredQuestions",
    "gaps",
]

REQUIRED_SECTIONS = [
    "Summary",
    "Acceptance Criteria",
    "Architecture Fit",
    "Tasks",
    "API & Data Impacts",
    "Risks & Constraints",
    "Test Plan",
    "Rollback",
    "Open Questions",
    "Gaps",
]

# Regex for valid task lines in markdown content
TASK_LINE_RE = re.compile(r"^\s*- \[[x ]\] \*\*T-\d+\.\d+\*\*")
# Regex to detect any task reference (may be missing checkbox)
TASK_REF_RE = re.compile(r"\*\*T-\d+\.\d+\*\*")
# Pending task line
PENDING_TASK_RE = re.compile(r"^\s*- \[ \] \*\*T-(\d+\.\d+)\*\*(?:\s+\[MANUAL\])?:")
# Completed task line
COMPLETED_TASK_RE = re.compile(r"^\s*- \[x\] \*\*T-(\d+\.\d+)\*\*:")
# Manual task line
MANUAL_TASK_RE = re.compile(r"^\s*- \[ \] \*\*T-(\d+\.\d+)\*\* \[MANUAL\]:")
# Open question line (supports optional bold markers: **Q-001** or Q-001)
OPEN_Q_RE = re.compile(r"^\s*- \[ \] \*{0,2}(Q-\d{3})\*{0,2}:")
# Answered question line (supports optional bold markers: **Q-001** or Q-001)
ANSWERED_Q_RE = re.compile(r"^\s*- \[x\] \*{0,2}(Q-\d{3})\*{0,2}:")
# Extract answer text from a checked question line.
# Matches **Answer: text**, *Answer: text*, or trailing Answer: text
ANSWER_TEXT_RE = re.compile(r"\*{1,2}\s*Answer:\s*(.+?)\s*\*{1,2}\s*$")
ANSWER_TEXT_PLAIN_RE = re.compile(r"(?:^|[\].])\s*Answer:\s*(.+?)\s*$")
# A-### keyed answer line (flexible: optional list marker, optional checkbox)
A_ANSWER_RE = re.compile(r"^\s*-?\s*\[?\s*[x ]?\s*\]?\s*A-(\d{3}):\s*(.+)")
# Metadata markers to strip when extracting inline comments
BLOCKING_TAG_RE = re.compile(r"\(BLOCKING\s+T-\d+\.\d+\)")
RECOMMENDED_TAG_RE = re.compile(r"\[Recommended:[^\]]*\]")
# AC table row pattern
AC_TABLE_ROW_RE = re.compile(r"\| (AC-\d{3}) \|")
# Gap content pattern
GAP_CONTENT_RE = re.compile(r"\*\*(GAP-\d{3})\*\*")
# Task ID pattern
TASK_ID_RE = re.compile(r"^T-\d+\.\d+$")
# AC ID pattern
AC_ID_RE = re.compile(r"^AC-\d{3}$")
# Question ID pattern
Q_ID_RE = re.compile(r"^Q-\d{3}$")
# Gap ID pattern
GAP_ID_RE = re.compile(r"^GAP-\d{3}$")


def _extract_answer(line: str, q_obj: dict, a_answers: dict[str, str]) -> str:
    """Extract answer text from a question line using multiple strategies.

    Tries, in order:
    1. Bold/italic ``**Answer: text**`` or ``*Answer: text*``
    2. Plain ``Answer: text`` (after ``]`` or ``.``)
    3. ``A-###`` keyed answer line (pre-scanned)
    4. Inline comment — text appended after the known question, stripped of metadata
    5. ``recommendedAnswer`` from the JSON entry
    """
    qid = q_obj.get("id", "")

    # 1. Bold/italic
    m = ANSWER_TEXT_RE.search(line)
    if m:
        return m.group(1).strip()

    # 2. Plain prefix
    m = ANSWER_TEXT_PLAIN_RE.search(line)
    if m:
        return m.group(1).strip()

    # 3. A-### keyed answer
    if qid in a_answers:
        return a_answers[qid]

    # 4. Inline comment: find text after the known question, strip metadata
    question_text = q_obj.get("question", "")
    if question_text:
        idx = line.find(question_text)
        if idx >= 0:
            after = line[idx + len(question_text) :]
            after = BLOCKING_TAG_RE.sub("", after)
            after = RECOMMENDED_TAG_RE.sub("", after)
            after = after.strip().strip("*").strip()
            if after:
                return after

    # 5. recommendedAnswer fallback
    return q_obj.get("recommendedAnswer") or ""


def auto_sync_markdown_answers(data: dict, content: str) -> tuple[dict, list[str]]:
    """Migrate questions answered in markdown to the answeredQuestions JSON array.

    Handles three answer formats:

    1. **Inline with prefix** — ``**Answer: text**``, ``*Answer: text*``, or
       plain ``Answer: text`` on a checked ``[x]`` question line.
    2. **A-### keyed answer** — a separate ``A-001: answer text`` line that
       corresponds to ``Q-001``.  The question checkbox does not need to be
       checked; the function updates the markdown content to check it.
    3. **Inline comment** — extra text appended after the known question text
       on a checked line (no ``Answer:`` prefix).

    Returns ``(data, migrated_ids)`` where *migrated_ids* lists the question
    IDs that were moved.  The caller is responsible for writing the modified
    *data* back to disk.
    """
    migrated: list[str] = []

    open_q_by_id: dict[str, dict] = {}
    for q in data.get("openQuestions", []):
        if isinstance(q, dict) and "id" in q:
            open_q_by_id[q["id"]] = q

    if not open_q_by_id:
        return data, migrated

    # Pre-scan for A-### answer lines
    a_answers: dict[str, str] = {}
    for line in content.splitlines():
        m = A_ANSWER_RE.match(line)
        if m:
            a_answers[f"Q-{m.group(1)}"] = m.group(2).strip()

    # Track unchecked questions that need their checkbox flipped in content
    needs_check: set[str] = set()

    for line in content.splitlines():
        # Checked question lines
        m = ANSWERED_Q_RE.match(line)
        if m:
            qid = m.group(1)
            if qid not in open_q_by_id:
                continue
            answer_text = _extract_answer(line, open_q_by_id[qid], a_answers)
            if not answer_text:
                continue
            q_obj = open_q_by_id.pop(qid)
            data["openQuestions"] = [q for q in data["openQuestions"] if q.get("id") != qid]
            data.setdefault("answeredQuestions", []).append(
                {"id": qid, "question": q_obj.get("question", ""), "answer": answer_text}
            )
            migrated.append(qid)
            continue

        # Unchecked question lines — only migrate if an A-### answer exists
        m = OPEN_Q_RE.match(line)
        if m:
            qid = m.group(1)
            if qid in open_q_by_id and qid in a_answers:
                q_obj = open_q_by_id.pop(qid)
                data["openQuestions"] = [q for q in data["openQuestions"] if q.get("id") != qid]
                data.setdefault("answeredQuestions", []).append(
                    {"id": qid, "question": q_obj.get("question", ""), "answer": a_answers[qid]}
                )
                migrated.append(qid)
                needs_check.add(qid)

    # Update markdown content: check boxes for questions migrated via A-### lines
    if needs_check:
        updated_lines: list[str] = []
        for line in content.splitlines():
            m = OPEN_Q_RE.match(line)
            if m and m.group(1) in needs_check:
                line = line.replace("- [ ]", "- [x]", 1)
            updated_lines.append(line)
        data["content"] = "\n".join(updated_lines)

    return data, migrated


def empty_result(status: str, issues: list[str] | None = None) -> dict:
    """Return an empty result skeleton."""
    return {
        "status": status,
        "issues": issues or [],
        "has_unanswered_questions": False,
        "unanswered_questions": [],
        "has_answered_questions": False,
        "answered_questions": [],
        "has_addressed_gaps": False,
        "addressed_gaps": [],
        "pending_tasks": [],
        "completed_tasks": [],
        "manual_tasks": [],
    }


def validate_schema_fields(data: dict) -> list[str]:
    """Validate required top-level fields and basic types."""
    issues: list[str] = []

    for field in REQUIRED_FIELDS:
        if field not in data:
            issues.append(f"Missing required field: {field}")

    if issues:
        return issues

    # Type checks
    if not isinstance(data.get("content"), str):
        issues.append("Field 'content' must be a string")
    for arr_field in REQUIRED_FIELDS[1:]:
        if not isinstance(data.get(arr_field), list):
            issues.append(f"Field '{arr_field}' must be an array")

    if issues:
        return issues

    # Validate ID patterns in arrays
    for task in data.get("pendingTasks", []):
        if not isinstance(task, dict):
            issues.append(f"pendingTasks item must be an object, got {type(task).__name__}")
            continue
        tid = task.get("id", "")
        if not TASK_ID_RE.match(tid):
            issues.append(f"Invalid task ID format in pendingTasks: '{tid}'")
        if "description" not in task:
            issues.append(f"Task {tid} missing required field: description")
        if "acceptanceCriteria" not in task:
            issues.append(f"Task {tid} missing required field: acceptanceCriteria")

    for task in data.get("completedTasks", []):
        if not isinstance(task, dict):
            issues.append(f"completedTasks item must be an object, got {type(task).__name__}")
            continue
        tid = task.get("id", "")
        if not TASK_ID_RE.match(tid):
            issues.append(f"Invalid task ID format in completedTasks: '{tid}'")

    for task in data.get("manualTasks", []):
        if not isinstance(task, dict):
            issues.append(f"manualTasks item must be an object, got {type(task).__name__}")
            continue
        tid = task.get("id", "")
        if not TASK_ID_RE.match(tid):
            issues.append(f"Invalid task ID format in manualTasks: '{tid}'")

    for ac in data.get("acceptanceCriteria", []):
        if not isinstance(ac, dict):
            issues.append(f"acceptanceCriteria item must be an object, got {type(ac).__name__}")
            continue
        acid = ac.get("id", "")
        if not AC_ID_RE.match(acid):
            issues.append(f"Invalid AC ID format: '{acid}'")

    for q in data.get("openQuestions", []):
        if not isinstance(q, dict):
            issues.append(f"openQuestions item must be an object, got {type(q).__name__}")
            continue
        qid = q.get("id", "")
        if not Q_ID_RE.match(qid):
            issues.append(f"Invalid question ID format in openQuestions: '{qid}'")

    for q in data.get("answeredQuestions", []):
        if not isinstance(q, dict):
            issues.append(f"answeredQuestions item must be an object, got {type(q).__name__}")
            continue
        qid = q.get("id", "")
        if not Q_ID_RE.match(qid):
            issues.append(f"Invalid question ID format in answeredQuestions: '{qid}'")

    for gap in data.get("gaps", []):
        if not isinstance(gap, dict):
            issues.append(f"gaps item must be an object, got {type(gap).__name__}")
            continue
        gid = gap.get("id", "")
        if not GAP_ID_RE.match(gid):
            issues.append(f"Invalid gap ID format: '{gid}'")

    if "decisionTable" in data:
        dt = data["decisionTable"]
        if not isinstance(dt, dict):
            issues.append("Field 'decisionTable' must be an object")
        else:
            dt_path = dt.get("path")
            if not isinstance(dt_path, str) or not dt_path:
                issues.append("decisionTable.path must be a non-empty string")
            allowed_statuses = {"pending", "aligned", "aligned_with_clarifications", "verification_failed"}
            if dt.get("status") not in allowed_statuses:
                issues.append(
                    "decisionTable.status must be one of pending|aligned|aligned_with_clarifications|verification_failed"
                )

    return issues


def validate_task_checkboxes(content: str) -> list[str]:
    """Validate that every task reference has a proper checkbox prefix."""
    issues: list[str] = []
    for line in content.splitlines():
        if TASK_REF_RE.search(line) and not TASK_LINE_RE.match(line):
            issues.append(f"Task missing checkbox in content: '{line.strip()}'")
    return issues


def validate_required_sections(content: str) -> list[str]:
    """Validate that all required ## sections exist."""
    issues: list[str] = []
    content_lower = content.lower()
    for section in REQUIRED_SECTIONS:
        # Match ## Section Name (case-insensitive)
        if f"## {section.lower()}" not in content_lower:
            issues.append(f"Missing required section: ## {section}")
    return issues


def validate_sync(data: dict, content: str) -> list[str]:
    """Validate that JSON arrays match markdown content lines."""
    issues: list[str] = []

    # Extract task IDs from content
    content_pending: set[str] = set()
    content_completed: set[str] = set()
    content_manual: set[str] = set()
    content_open_q: set[str] = set()
    content_answered_q: set[str] = set()

    for line in content.splitlines():
        m = MANUAL_TASK_RE.match(line)
        if m:
            content_manual.add(f"T-{m.group(1)}")
            continue
        m = PENDING_TASK_RE.match(line)
        if m:
            tid = f"T-{m.group(1)}"
            if tid not in content_manual:
                content_pending.add(tid)
            continue
        m = COMPLETED_TASK_RE.match(line)
        if m:
            content_completed.add(f"T-{m.group(1)}")
            continue
        m = OPEN_Q_RE.match(line)
        if m:
            content_open_q.add(m.group(1))
            continue
        m = ANSWERED_Q_RE.match(line)
        if m:
            content_answered_q.add(m.group(1))
            continue

    # Compare JSON arrays with content
    json_pending = {t["id"] for t in data.get("pendingTasks", []) if isinstance(t, dict)}
    json_completed = {t["id"] for t in data.get("completedTasks", []) if isinstance(t, dict)}
    json_manual = {t["id"] for t in data.get("manualTasks", []) if isinstance(t, dict)}
    json_open_q = {q["id"] for q in data.get("openQuestions", []) if isinstance(q, dict)}
    json_answered_q = {q["id"] for q in data.get("answeredQuestions", []) if isinstance(q, dict)}

    # pendingTasks sync
    for tid in json_pending - content_pending:
        issues.append(f"Sync error: pendingTasks contains {tid} but no matching task in content")
    for tid in content_pending - json_pending:
        # Only flag if not in manual or completed
        if tid not in json_manual and tid not in json_completed:
            issues.append(f"Sync error: content has pending task {tid} but not in pendingTasks array")

    # completedTasks sync
    for tid in json_completed - content_completed:
        issues.append(f"Sync error: completedTasks contains {tid} but no matching task in content")
    for tid in content_completed - json_completed:
        issues.append(f"Sync error: content has completed task {tid} but not in completedTasks array")

    # manualTasks sync
    for tid in json_manual - content_manual:
        issues.append(f"Sync error: manualTasks contains {tid} but no matching [MANUAL] task in content")
    for tid in content_manual - json_manual:
        issues.append(f"Sync error: content has manual task {tid} but not in manualTasks array")

    # openQuestions sync
    for qid in json_open_q - content_open_q:
        issues.append(f"Sync error: openQuestions contains {qid} but no matching line in content")
    for qid in content_open_q - json_open_q:
        issues.append(f"Sync error: content has open question {qid} but not in openQuestions array")

    # answeredQuestions sync
    for qid in json_answered_q - content_answered_q:
        issues.append(f"Sync error: answeredQuestions contains {qid} but no matching line in content")

    # AC sync
    content_ac_ids = set(AC_TABLE_ROW_RE.findall(content))
    json_ac_ids = {ac["id"] for ac in data.get("acceptanceCriteria", []) if isinstance(ac, dict)}
    for acid in json_ac_ids - content_ac_ids:
        issues.append(f"Sync error: acceptanceCriteria contains {acid} but no matching row in content")
    for acid in content_ac_ids - json_ac_ids:
        issues.append(f"Sync error: content has AC {acid} but not in acceptanceCriteria array")

    # Gap sync
    content_gap_ids = set(GAP_CONTENT_RE.findall(content))
    json_gap_ids = {g["id"] for g in data.get("gaps", []) if isinstance(g, dict)}
    for gid in json_gap_ids - content_gap_ids:
        issues.append(f"Sync error: gaps contains {gid} but no matching entry in content")
    for gid in content_gap_ids - json_gap_ids:
        issues.append(f"Sync error: content has gap {gid} but not in gaps array")

    return issues


def extract_data(data: dict) -> dict:
    """Extract orchestrator-relevant data from validated plan."""
    open_questions = data.get("openQuestions", [])
    answered_questions = data.get("answeredQuestions", [])
    gaps = data.get("gaps", [])

    addressed_gaps = [
        {"id": g["id"], "description": g.get("description", ""), "resolution": g.get("resolution", "")}
        for g in gaps
        if isinstance(g, dict) and g.get("addressed") is True and g.get("resolution")
    ]

    unanswered_questions = [
        {
            "id": q["id"],
            "question": q.get("question", ""),
            "blockingTask": q.get("blockingTask"),
            "recommendedAnswer": q.get("recommendedAnswer"),
        }
        for q in open_questions
        if isinstance(q, dict)
    ]

    answered_q_list = [
        {"id": q["id"], "question": q.get("question", ""), "answer": q.get("answer", "")}
        for q in answered_questions
        if isinstance(q, dict)
    ]

    pending = [
        {
            "id": t["id"],
            "description": t.get("description", ""),
            "acceptanceCriteria": t.get("acceptanceCriteria", []),
        }
        for t in data.get("pendingTasks", [])
        if isinstance(t, dict)
    ]

    completed = [
        {
            "id": t["id"],
            "description": t.get("description", ""),
            "acceptanceCriteria": t.get("acceptanceCriteria", []),
        }
        for t in data.get("completedTasks", [])
        if isinstance(t, dict)
    ]

    manual = [
        {
            "id": t["id"],
            "description": t.get("description", ""),
            "acceptanceCriteria": t.get("acceptanceCriteria", []),
        }
        for t in data.get("manualTasks", [])
        if isinstance(t, dict)
    ]

    decision_table = data.get("decisionTable")
    dt_path = decision_table.get("path", "") if isinstance(decision_table, dict) else ""
    dt_status = decision_table.get("status", "") if isinstance(decision_table, dict) else ""

    return {
        "status": "VALID",
        "issues": [],
        "has_unanswered_questions": len(unanswered_questions) > 0,
        "unanswered_questions": unanswered_questions,
        "has_answered_questions": len(answered_q_list) > 0,
        "answered_questions": answered_q_list,
        "has_addressed_gaps": len(addressed_gaps) > 0,
        "addressed_gaps": addressed_gaps,
        "pending_tasks": pending,
        "completed_tasks": completed,
        "manual_tasks": manual,
        "decision_table_path": dt_path,
        "decision_table_status": dt_status,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: validate_plan.py <WORKDIR> [--auto-sync] [--schema-path <path>]", file=sys.stderr)
        sys.exit(1)

    workdir = sys.argv[1]
    auto_sync = "--auto-sync" in sys.argv
    plan_path = os.path.join(workdir, "plan.json")

    # Check file existence
    if not os.path.isfile(plan_path):
        print(json.dumps(empty_result("EMPTY_FILE", ["File not found or empty"])))
        return

    # Check empty file
    if os.path.getsize(plan_path) == 0:
        print(json.dumps(empty_result("EMPTY_FILE", ["File not found or empty"])))
        return

    # Parse JSON
    try:
        with open(plan_path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(json.dumps(empty_result("INVALID_JSON", [f"JSON parse error: {e}"])))
        return

    if not isinstance(data, dict):
        print(json.dumps(empty_result("INVALID_JSON", ["plan.json root must be an object"])))
        return

    # Auto-sync: migrate markdown-answered questions to JSON before validation
    if auto_sync and isinstance(data.get("content"), str):
        data, migrated = auto_sync_markdown_answers(data, data["content"])
        if migrated:
            with open(plan_path, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write("\n")
            print(
                f"Auto-synced {len(migrated)} answered question(s) from markdown: {', '.join(migrated)}",
                file=sys.stderr,
            )

    # Step 1: Schema field validation
    all_issues: list[str] = []
    schema_issues = validate_schema_fields(data)
    all_issues.extend(schema_issues)

    if all_issues:
        print(json.dumps(empty_result("FORMAT_ISSUES", all_issues)))
        return

    content = data["content"]

    # Step 2: Task checkbox validation
    checkbox_issues = validate_task_checkboxes(content)
    all_issues.extend(checkbox_issues)

    # Step 3: Required sections validation
    section_issues = validate_required_sections(content)
    all_issues.extend(section_issues)

    # Step 4: Sync validation
    sync_issues = validate_sync(data, content)
    all_issues.extend(sync_issues)

    if all_issues:
        print(json.dumps(empty_result("FORMAT_ISSUES", all_issues)))
        return

    # All deterministic checks passed - extract data
    result = extract_data(data)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
