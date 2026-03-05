"""State management for plan amendment sessions.

CLI interface for the /code:amend-plan slash command to persist
conversation state across GitHub workflow runs.

Usage:
    # Load state (creates new if doesn't exist)
    python amend_state.py load --state-file path/to/amend-session.json --run-dir path/to/run

    # Add a message to conversation
    python amend_state.py add-message --state-file path/to/amend-session.json --role user --content "message"

    # Add a pending change
    python amend_state.py add-change --state-file path/to/amend-session.json --description "change" --task-id task-001

    # Apply changes and reset for re-validation
    python amend_state.py apply --state-file path/to/amend-session.json --run-dir path/to/run
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional


def load_state(state_file: Path, run_dir: Optional[str] = None) -> Dict[str, Any]:
    """Load session state or return empty state.

    Args:
        state_file: Path to the amend-session.json file
        run_dir: Run directory path (used when creating new state)

    Returns:
        Session state dictionary
    """
    if state_file.exists():
        return json.loads(state_file.read_text())
    return {
        "version": "1.0",
        "run_dir": run_dir or "",
        "status": "discussing",
        "conversation": [],
        "pending_changes": [],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }


def save_state(state_file: Path, state: Dict[str, Any]) -> None:
    """Save session state to file.

    Args:
        state_file: Path to write the state file
        state: Session state dictionary to save
    """
    state["updated_at"] = datetime.now().isoformat()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state, indent=2, sort_keys=True))


def add_message(
    state: Dict[str, Any], role: Literal["user", "assistant"], content: str
) -> Dict[str, Any]:
    """Add a message to conversation history.

    Args:
        state: Current session state
        role: Message role ('user' or 'assistant')
        content: Message content

    Returns:
        Updated state dictionary
    """
    state["conversation"].append(
        {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        }
    )
    return state


def add_pending_change(
    state: Dict[str, Any], description: str, task_id: Optional[str] = None
) -> Dict[str, Any]:
    """Track a pending change.

    Args:
        state: Current session state
        description: Description of the change
        task_id: Optional task ID this change affects

    Returns:
        Updated state dictionary
    """
    state["pending_changes"].append(
        {
            "task_id": task_id,
            "description": description,
            "discussed_at": datetime.now().isoformat(),
        }
    )
    return state


def clear_pending_changes(state: Dict[str, Any]) -> Dict[str, Any]:
    """Clear all pending changes.

    Args:
        state: Current session state

    Returns:
        Updated state dictionary with empty pending_changes
    """
    state["pending_changes"] = []
    return state


def apply_changes(
    run_dir: Path,
    state: Dict[str, Any],
    state_file: Optional[Path] = None,
    plan_format: str = "md",
) -> Dict[str, Any]:
    """Apply pending changes and finalize the amendment.

    This function:
    1. Records amendment metadata in state.json (md) or plan.json (json)
    2. Clears old critic reviews
    3. Deletes the amend session state file (so next amend starts fresh)

    The actual plan edits should be done by the LLM before calling this.

    Args:
        run_dir: Path to the run directory (or workdir for experimental)
        state: Current amend session state
        state_file: Optional path to the amend-session.json file to delete after apply
        plan_format: Plan format - 'md' for implementation-plan.md, 'json' for plan.json

    Returns:
        Result dictionary with status
    """
    if plan_format == "json":
        # Experimental workflow: plan.json
        plan_file = run_dir / "plan.json"
        if not plan_file.exists():
            return {"error": "No plan.json found to amend", "applied": False}

        # Record amendment in plan.json itself
        plan = json.loads(plan_file.read_text())
        if "amendments" not in plan:
            plan["amendments"] = []
        plan["amendments"].append({
            "timestamp": datetime.now().isoformat(),
            "changes": [c["description"] for c in state.get("pending_changes", [])],
            "conversation": state.get("conversation", []),
        })
        plan_file.write_text(json.dumps(plan, indent=2))
    else:
        # Legacy workflow: implementation-plan.md
        plan_file = run_dir / "implementation-plan.md"
        if not plan_file.exists():
            return {"error": "No implementation-plan.md found to amend", "applied": False}

        # Update state.json to record the amendment
        run_state_file = run_dir / "state.json"
        if run_state_file.exists():
            run_state = json.loads(run_state_file.read_text())
            run_state["amended"] = {
                "timestamp": datetime.now().isoformat(),
                "changes": [c["description"] for c in state.get("pending_changes", [])],
                "conversation": state.get("conversation", []),  # Preserve conversation history
            }
            run_state_file.write_text(json.dumps(run_state, indent=2, sort_keys=True))

    # Clear old critic reviews so they can be re-run if needed (both workflows)
    reviews_dir = run_dir / "reviews"
    if reviews_dir.exists():
        for review_file in reviews_dir.glob("*.review.json"):
            review_file.unlink()

    # Delete the amend session state file so next amend starts fresh
    if state_file and state_file.exists():
        state_file.unlink()

    # Update amend session state (for return value, even though file is deleted)
    state["status"] = "applied"
    state["pending_changes"] = []

    return {
        "applied": True,
        "plan_file": str(plan_file),
        "state_file_deleted": state_file is not None,
    }


def get_conversation_context(state: Dict[str, Any]) -> str:
    """Format conversation history for display.

    Args:
        state: Session state dictionary

    Returns:
        Formatted conversation string
    """
    lines: List[str] = []
    for entry in state.get("conversation", []):
        role = entry.get("role", "unknown")
        content = entry.get("content", "")
        prefix = "User" if role == "user" else "Assistant"
        lines.append(f"{prefix}: {content}")
    return "\n\n".join(lines)


def main() -> None:
    """CLI entry point for amend state management."""
    parser = argparse.ArgumentParser(
        description="Amend session state management for /code:amend-plan"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Load state command
    load_cmd = subparsers.add_parser("load", help="Load session state (creates new if missing)")
    load_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")
    load_cmd.add_argument("--run-dir", help="Run directory path (for new sessions)")

    # Save state command
    save_cmd = subparsers.add_parser("save", help="Save session state")
    save_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")
    save_cmd.add_argument("--state-json", required=True, help="JSON state to save")

    # Add message command
    msg_cmd = subparsers.add_parser("add-message", help="Add message to conversation")
    msg_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")
    msg_cmd.add_argument("--role", required=True, choices=["user", "assistant"], help="Message role")
    msg_cmd.add_argument("--content", required=True, help="Message content")

    # Add pending change command
    change_cmd = subparsers.add_parser("add-change", help="Add pending change")
    change_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")
    change_cmd.add_argument("--description", required=True, help="Change description")
    change_cmd.add_argument("--task-id", help="Optional task ID affected by this change")

    # Clear pending changes command
    clear_cmd = subparsers.add_parser("clear-changes", help="Clear all pending changes")
    clear_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")

    # Apply changes command
    apply_cmd = subparsers.add_parser(
        "apply", help="Apply changes and reset for re-validation"
    )
    apply_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")
    apply_cmd.add_argument("--run-dir", required=True, help="Path to run directory")
    apply_cmd.add_argument(
        "--plan-format",
        choices=["md", "json"],
        default="md",
        help="Plan format: 'md' for implementation-plan.md, 'json' for plan.json",
    )

    # Get conversation context command
    context_cmd = subparsers.add_parser("context", help="Get formatted conversation context")
    context_cmd.add_argument("--state-file", required=True, help="Path to amend-session.json")

    args = parser.parse_args()
    state_file = Path(args.state_file)

    if args.command == "load":
        run_dir = args.run_dir if hasattr(args, "run_dir") and args.run_dir else None
        state = load_state(state_file, run_dir)
        print(json.dumps(state, indent=2))

    elif args.command == "save":
        state = json.loads(args.state_json)
        save_state(state_file, state)
        print(json.dumps({"saved": True}))

    elif args.command == "add-message":
        state = load_state(state_file)
        state = add_message(state, args.role, args.content)
        save_state(state_file, state)
        print(json.dumps(state, indent=2))

    elif args.command == "add-change":
        state = load_state(state_file)
        task_id = args.task_id if hasattr(args, "task_id") else None
        state = add_pending_change(state, args.description, task_id)
        save_state(state_file, state)
        print(json.dumps(state, indent=2))

    elif args.command == "clear-changes":
        state = load_state(state_file)
        state = clear_pending_changes(state)
        save_state(state_file, state)
        print(json.dumps(state, indent=2))

    elif args.command == "apply":
        state = load_state(state_file)
        plan_format = args.plan_format if hasattr(args, "plan_format") else "md"
        result = apply_changes(Path(args.run_dir), state, state_file, plan_format)
        # Note: state file is deleted on successful apply, no need to save
        print(json.dumps(result, indent=2))

    elif args.command == "context":
        state = load_state(state_file)
        context = get_conversation_context(state)
        print(context)


if __name__ == "__main__":
    main()
